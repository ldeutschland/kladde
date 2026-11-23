import UIKit
import UniformTypeIdentifiers

private let maxHTMLBytes = 5 * 1024 * 1024
private let maxTitle = 1000
private let maxNote = 4000
private let maxAddress = 2048
private let maxText = 100_000
private let maxImages = 20
private let maxEncodedImage = (10 * 1024 * 1024 + 2) / 3 * 4
private let closeDelay: Duration = .milliseconds(1400)

private let german = Locale.preferredLanguages.first?.hasPrefix("de") ?? false

private func words(_ de: String, _ en: String) -> String { german ? de : en }

private func clipped(_ text: String, _ limit: Int) -> String {
    var view = String.UnicodeScalarView()
    view.append(contentsOf: text.unicodeScalars.prefix(limit))
    return String(view)
}

private func webAddress(_ text: String) -> URL? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.utf8.count <= maxAddress, !trimmed.contains(where: \.isWhitespace),
          let url = URL(string: trimmed), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
          url.host?.isEmpty == false else { return nil }
    return url
}

enum ShareFailure: Error {
    case unsupported
}

struct Picture: Encodable {
    let url: String
    let data: String
}

struct WebPage {
    let url: URL
    let title: String
    let html: String
    let selection: String
    var images: [Picture] = []
}

enum Shared {
    case page(WebPage)
    case file(name: String, type: String, copy: URL)
    case text(String)
}

enum ClipMode: String {
    case article, page, selection, link

    var label: String {
        switch self {
        case .article: words("Artikel", "Article")
        case .page: words("Ganze Seite", "Whole page")
        case .selection: words("Auswahl", "Selection")
        case .link: words("Nur Link", "Link only")
        }
    }

    static func available(for page: WebPage) -> [ClipMode] {
        var modes: [ClipMode] = []
        if !page.html.isEmpty, page.html.utf8.count <= maxHTMLBytes { modes += [.article, .page] }
        if !page.selection.isEmpty, page.selection.utf8.count <= maxHTMLBytes { modes.append(.selection) }
        return modes + [.link]
    }

    static func preferred(in modes: [ClipMode]) -> ClipMode {
        modes.contains(.selection) ? .selection : modes.first ?? .link
    }
}

struct ClipMessage: Encodable {
    let version = 1
    let kind: String
    let url: String
    let title: String
    let note: String
    let html: String
    let target: String
    let images: [Picture]

    init(page: WebPage, mode: ClipMode, note: String) {
        kind = mode.rawValue
        url = page.url.absoluteString
        title = clipped(page.title, maxTitle)
        self.note = clipped(note.trimmingCharacters(in: .whitespacesAndNewlines), maxNote)
        html = mode == .selection ? page.selection : mode == .link ? "" : page.html
        target = mode == .link ? page.url.absoluteString : ""
        images = mode == .link ? [] : page.images
    }
}

enum SharedLoader {
    static func load(_ providers: [NSItemProvider]) async throws -> Shared {
        let pageType = UTType.propertyList.identifier
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(pageType) }),
           let page = try? await page(from: provider) {
            return .page(page)
        }
        for provider in providers {
            if let address = try? await sharedAddress(from: provider) { return link(address) }
        }
        for provider in providers {
            if let shared = try await other(from: provider) { return shared }
        }
        throw ShareFailure.unsupported
    }

    private static func sharedAddress(from provider: NSItemProvider) async throws -> URL? {
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
           let url = try await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
           let web = webAddress(url.absoluteString) {
            return web
        }
        guard provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
              let text = try await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String,
              text.utf8.count <= maxText else { return nil }
        return webAddress(text)
    }

    private static func page(from provider: NSItemProvider) async throws -> WebPage? {
        let item = try await provider.loadItem(forTypeIdentifier: UTType.propertyList.identifier)
        guard let values = item as? NSDictionary,
              let results = values[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any],
              let url = webAddress(results["url"] as? String ?? "") else { return nil }
        return WebPage(url: url, title: results["title"] as? String ?? "",
                       html: results["html"] as? String ?? "", selection: results["selection"] as? String ?? "",
                       images: pictures(results["images"]))
    }

    private static func pictures(_ value: Any?) -> [Picture] {
        let raw = value as? [[String: String]] ?? []
        let valid = raw.compactMap { item -> Picture? in
            guard let address = item["url"], let data = item["data"], webAddress(address) != nil,
                  !data.isEmpty, data.utf8.count <= maxEncodedImage else { return nil }
            return Picture(url: address, data: data)
        }
        return Array(valid.prefix(maxImages))
    }

    private static func link(_ url: URL) -> Shared {
        .page(WebPage(url: url, title: "", html: "", selection: ""))
    }

    private static func other(from provider: NSItemProvider) async throws -> Shared? {
        for type in [UTType.pdf, .image] where provider.hasItemConformingToTypeIdentifier(type.identifier) {
            return try await file(from: provider, type: type)
        }
        guard provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
              let text = try await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String else { return nil }
        guard text.utf8.count <= maxText else { throw CocoaError(.fileReadTooLarge) }
        return .text(text)
    }

    private static func file(from provider: NSItemProvider, type: UTType) async throws -> Shared {
        try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                continuation.resume(with: Result { try keep(url, error: error, type: type) })
            }
        }
    }

    private static func keep(_ url: URL?, error: Error?, type: UTType) throws -> Shared {
        if let error { throw error }
        guard let url, let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size <= ShareQueue.limit else { throw CocoaError(.fileReadTooLarge) }
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.copyItem(at: url, to: copy)
        let format = UTType(filenameExtension: url.pathExtension)
        let mime = type == .pdf ? "application/pdf" : format?.preferredMIMEType ?? "application/octet-stream"
        return .file(name: url.lastPathComponent, type: mime, copy: copy)
    }
}

enum ShareStore {
    static func save(_ shared: Shared, mode: ClipMode, note: String) throws {
        switch shared {
        case .page(let page):
            try ShareQueue.saveClip(JSONEncoder().encode(ClipMessage(page: page, mode: mode, note: note)))
        case .file(let name, let type, let copy):
            defer { try? FileManager.default.removeItem(at: copy) }
            try ShareQueue.save(name: name, type: type, bytes: Data(contentsOf: copy, options: .mappedIfSafe))
        case .text(let text):
            try ShareQueue.save(name: "", type: "text/plain", bytes: Data(text.utf8))
        }
    }

    static func message(for error: Error) -> String {
        switch error {
        case ShareFailure.unsupported:
            words("Dieser Inhalt lässt sich nicht in Kladde speichern.", "This content can’t be saved to Kladde.")
        case CocoaError.fileWriteOutOfSpace:
            words("In Kladde warten schon viele Einträge. Öffne Kladde einmal, dann ist wieder Platz.",
                  "Many items are already waiting for Kladde. Open Kladde once to make room.")
        case CocoaError.fileReadTooLarge:
            words("Der Inhalt ist zu groß. Speichere die Seite als Link.", "The content is too large. Save the page as a link instead.")
        case CocoaError.fileReadNoPermission, CocoaError.fileWriteNoPermission:
            words("Kladde kann gerade nicht speichern. Entsperre dein iPhone und versuche es erneut.",
                  "Kladde can’t save right now. Unlock your iPhone and try again.")
        default:
            words("Speichern fehlgeschlagen: ", "Saving failed: ") + error.localizedDescription
        }
    }
}

final class ShareController: UIViewController {
    private var started = false
    private var shared: Shared?
    private var modes: [ClipMode] = []
    private let titleLabel = UILabel()
    private let detailLabel = UILabel()
    private let modePicker = UISegmentedControl()
    private let noteField = UITextField()
    private let statusLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let saveButton = UIButton(configuration: .filled())
    private let cancelButton = UIButton(configuration: .gray())

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        prepareViews()
        prepareButtons()
        pin(stack())
        showLoading()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        let providers = (extensionContext?.inputItems as? [NSExtensionItem])?.flatMap { $0.attachments ?? [] } ?? []
        Task { @MainActor in
            do { show(try await SharedLoader.load(providers)) } catch { fail(error, final: true) }
        }
    }

    private func prepareViews() {
        titleLabel.font = .preferredFont(forTextStyle: .title3)
        titleLabel.numberOfLines = 3
        detailLabel.font = .preferredFont(forTextStyle: .subheadline)
        detailLabel.textColor = .secondaryLabel
        detailLabel.numberOfLines = 2
        statusLabel.font = .preferredFont(forTextStyle: .callout)
        statusLabel.numberOfLines = 0
        noteField.placeholder = words("Notiz (optional)", "Note (optional)")
        noteField.borderStyle = .roundedRect
        noteField.returnKeyType = .done
        noteField.addAction(UIAction { [weak self] _ in self?.noteField.resignFirstResponder() }, for: .editingDidEndOnExit)
        for label in [titleLabel, detailLabel, statusLabel] { label.adjustsFontForContentSizeCategory = true }
    }

    private func prepareButtons() {
        cancelButton.configuration?.title = words("Abbrechen", "Cancel")
        cancelButton.addAction(UIAction { [weak self] _ in self?.cancel() }, for: .primaryActionTriggered)
        saveButton.configuration?.title = words("Speichern", "Save")
        saveButton.addAction(UIAction { [weak self] _ in self?.save() }, for: .primaryActionTriggered)
    }

    private func stack() -> UIStackView {
        let header = UILabel()
        header.text = "Kladde"
        header.font = .preferredFont(forTextStyle: .headline)
        let buttons = UIStackView(arrangedSubviews: [cancelButton, saveButton])
        buttons.distribution = .fillEqually
        buttons.spacing = 12
        let column = UIStackView(arrangedSubviews: [header, spinner, titleLabel, detailLabel, modePicker, noteField, statusLabel, buttons])
        column.axis = .vertical
        column.spacing = 14
        column.alignment = .fill
        return column
    }

    private func pin(_ column: UIStackView) {
        column.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            column.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            column.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 20),
        ])
    }

    private func showLoading() {
        spinner.startAnimating()
        titleLabel.text = words("Inhalt wird gelesen …", "Reading content…")
        detailLabel.isHidden = true
        modePicker.isHidden = true
        noteField.isHidden = true
        statusLabel.isHidden = true
        saveButton.isEnabled = false
    }

    private func show(_ shared: Shared) {
        self.shared = shared
        spinner.stopAnimating()
        spinner.isHidden = true
        detailLabel.isHidden = false
        saveButton.isEnabled = true
        switch shared {
        case .page(let page): showPage(page)
        case .file(let name, _, _): showCapture(name, hint: words("Datei", "File"))
        case .text(let text): showCapture(clipped(text, 140), hint: words("Text", "Text"))
        }
    }

    private func showPage(_ page: WebPage) {
        titleLabel.text = page.title.isEmpty ? page.url.host() : page.title
        detailLabel.text = page.url.host()
        modes = ClipMode.available(for: page)
        modePicker.removeAllSegments()
        for (index, mode) in modes.enumerated() { modePicker.insertSegment(withTitle: mode.label, at: index, animated: false) }
        modePicker.selectedSegmentIndex = modes.firstIndex(of: ClipMode.preferred(in: modes)) ?? 0
        modePicker.isHidden = modes.count < 2
        noteField.isHidden = false
        saveButton.configuration?.title = words("Als Web-Clip speichern", "Save as web clip")
    }

    private func showCapture(_ name: String, hint: String) {
        titleLabel.text = name
        detailLabel.text = hint + " · " + words("für die Schnellnotizen", "for quick notes")
        saveButton.configuration?.title = words("Zu Schnellnotizen", "Add to quick notes")
    }

    private var mode: ClipMode {
        modes.indices.contains(modePicker.selectedSegmentIndex) ? modes[modePicker.selectedSegmentIndex] : .link
    }

    private func save() {
        guard let shared else { return }
        noteField.resignFirstResponder()
        setBusy(true)
        let mode = mode, note = noteField.text ?? ""
        Task.detached(priority: .userInitiated) {
            let result = Result { try ShareStore.save(shared, mode: mode, note: note) }
            await MainActor.run { self.finish(result) }
        }
    }

    private func setBusy(_ busy: Bool) {
        saveButton.configuration?.showsActivityIndicator = busy
        saveButton.isEnabled = !busy
        cancelButton.isEnabled = !busy
        modePicker.isEnabled = !busy
        noteField.isEnabled = !busy
        statusLabel.isHidden = true
    }

    private func finish(_ result: Result<Void, Error>) {
        setBusy(false)
        switch result {
        case .success: succeed()
        case .failure(let error): fail(error, final: false)
        }
    }

    private func succeed() {
        let clip = if case .page = shared { true } else { false }
        statusLabel.textColor = .systemGreen
        statusLabel.text = clip
            ? words("✓ Gespeichert. Kladde legt den Clip unter „Web-Clips“ ab, sobald du die App öffnest.",
                    "✓ Saved. Kladde files the clip under “Web clips” as soon as you open the app.")
            : words("✓ Gespeichert. Du findest es in Kladde in den Schnellnotizen.",
                    "✓ Saved. You’ll find it in Kladde’s quick notes.")
        statusLabel.isHidden = false
        for control in [modePicker, noteField, saveButton, cancelButton] as [UIView] { control.isHidden = true }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        Task { @MainActor in
            try? await Task.sleep(for: closeDelay)
            extensionContext?.completeRequest(returningItems: nil)
        }
    }

    private func fail(_ error: Error, final: Bool) {
        spinner.stopAnimating()
        spinner.isHidden = true
        statusLabel.textColor = .systemRed
        statusLabel.text = ShareStore.message(for: error)
        statusLabel.isHidden = false
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        guard final else { return }
        titleLabel.text = words("Nicht gespeichert", "Not saved")
        saveButton.isHidden = true
        cancelButton.configuration?.title = words("Schließen", "Close")
    }

    private func cancel() {
        if case .file(_, _, let copy) = shared { try? FileManager.default.removeItem(at: copy) }
        extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
    }
}
