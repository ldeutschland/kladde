import UIKit
import UniformTypeIdentifiers

private let maxHTMLBytes = 5 * 1024 * 1024
private let maxTitle = 1000
private let maxNote = 4000
private let maxAddress = 2048
private let maxText = 100_000
private let maxImages = 20
private let maxEncodedImage = (10 * 1024 * 1024 + 2) / 3 * 4
private let maxPreview = 140
private let closeDelay: Duration = .milliseconds(1800)
private let destinationKey = "share.destination"
private let modeKey = "share.mode"
private let accentHex: UInt32 = 0x9065B0
private let darkAccentTextHex: UInt32 = 0xB48FDB

private let german = Locale.preferredLanguages.first?.hasPrefix("de") ?? false

private func words(_ de: String, _ en: String) -> String { german ? de : en }

private func color(_ hex: UInt32) -> UIColor {
    UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}

private let accent = color(accentHex)
private let accentTint = UIColor { $0.userInterfaceStyle == .dark ? color(darkAccentTextHex) : accent }

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
    case selection, article, page, link

    var label: String {
        switch self {
        case .selection: words("Auswahl", "Selection")
        case .article: words("Artikel", "Article")
        case .page: words("Ganze Seite", "Whole page")
        case .link: words("Link", "Link")
        }
    }

    var detail: String {
        switch self {
        case .selection: words("Nur der Text, den du markiert hast", "Only the text you selected")
        case .article: words("Haupttext mit Bildern, ohne Menüs und Werbung", "Main text with images, without menus and ads")
        case .page: words("Alles, was die Seite gerade zeigt", "Everything the page shows right now")
        case .link: words("Speichert die Adresse. Beim nächsten Öffnen holt Kladde den Artikel, sofern die Seite es zulässt.",
                          "Saves the address. Next time you open Kladde, it fetches the article if the page allows it.")
        }
    }

    var symbol: String {
        switch self {
        case .selection: "text.quote"
        case .article: "newspaper"
        case .page: "doc.richtext"
        case .link: "link"
        }
    }

    static func available(for page: WebPage) -> [ClipMode] {
        var modes: [ClipMode] = []
        if !page.selection.isEmpty, page.selection.utf8.count <= maxHTMLBytes { modes.append(.selection) }
        if !page.html.isEmpty, page.html.utf8.count <= maxHTMLBytes { modes += [.article, .page] }
        return modes + [.link]
    }

    static func preferred(in modes: [ClipMode], remembered: ClipMode?) -> ClipMode {
        if modes.contains(.selection) { return .selection }
        if let remembered, modes.contains(remembered) { return remembered }
        return modes.first ?? .link
    }
}

enum Destination: String, CaseIterable {
    case webClips, quickNotes

    var title: String {
        switch self {
        case .webClips: words("Web-Clips", "Web clips")
        case .quickNotes: words("Schnellnotizen", "Quick notes")
        }
    }

    var symbol: String {
        switch self {
        case .webClips: "globe"
        case .quickNotes: "note.text"
        }
    }

    var arrival: String {
        switch self {
        case .webClips: words("Kladde legt den Clip beim nächsten Öffnen in „Web-Clips“ ab.",
                              "Kladde files the clip in “Web clips” the next time you open it.")
        case .quickNotes: words("Der Eintrag wartet in Kladde an der Schnellnotiz, bis du ihn übernimmst.",
                                "The item waits at Kladde’s quick note until you add it.")
        }
    }

    func detail(for shared: Shared) -> String {
        switch (self, shared) {
        case (.webClips, _): words("Eigene Seite mit Text, Bildern und Quelle", "A page of its own with text, images and source")
        case (.quickNotes, .page): words("Titel und Link als kurze Notiz", "Title and link as a short note")
        case (.quickNotes, .file): words("Die Datei als neue Schnellnotiz", "The file as a new quick note")
        case (.quickNotes, .text): words("Der Text als neue Schnellnotiz", "The text as a new quick note")
        }
    }

    static func available(for shared: Shared) -> [Destination] {
        if case .page = shared { return allCases }
        return [.quickNotes]
    }
}

struct ShareChoice {
    var destination: Destination
    var mode: ClipMode
    var note = ""

    static func initial(for shared: Shared) -> ShareChoice {
        let destinations = Destination.available(for: shared)
        let remembered = ShareMemory.destination.flatMap { destinations.contains($0) ? $0 : nil }
        let modes = if case .page(let page) = shared { ClipMode.available(for: page) } else { [ClipMode.link] }
        return ShareChoice(destination: remembered ?? destinations[0],
                           mode: ClipMode.preferred(in: modes, remembered: ShareMemory.mode))
    }
}

enum ShareMemory {
    static var destination: Destination? {
        UserDefaults.standard.string(forKey: destinationKey).flatMap(Destination.init(rawValue:))
    }

    static var mode: ClipMode? {
        UserDefaults.standard.string(forKey: modeKey).flatMap(ClipMode.init(rawValue:))
    }

    static func remember(_ choice: ShareChoice, for shared: Shared) {
        guard case .page = shared else { return }
        UserDefaults.standard.set(choice.destination.rawValue, forKey: destinationKey)
        guard choice.destination == .webClips, choice.mode != .selection else { return }
        UserDefaults.standard.set(choice.mode.rawValue, forKey: modeKey)
    }
}

struct Preview {
    let title: String
    let detail: String
    let symbol: String

    init(_ shared: Shared) {
        switch shared {
        case .page(let page):
            let host = page.url.host() ?? page.url.absoluteString
            title = page.title.isEmpty ? host : clipped(page.title, maxPreview)
            detail = host
            symbol = "safari"
        case .file(let name, let type, _):
            let image = type.hasPrefix("image/")
            title = clipped(name, maxPreview)
            detail = image ? words("Bild", "Image") : words("Datei", "File")
            symbol = image ? "photo" : "doc"
        case .text(let text):
            title = clipped(text.trimmingCharacters(in: .whitespacesAndNewlines), maxPreview)
            detail = words("Text", "Text")
            symbol = "text.alignleft"
        }
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
    static func save(_ shared: Shared, choice: ShareChoice) throws {
        switch shared {
        case .page(let page) where choice.destination == .quickNotes:
            try saveText(quickNote(page, note: choice.note))
        case .page(let page):
            try ShareQueue.saveClip(JSONEncoder().encode(ClipMessage(page: page, mode: choice.mode, note: choice.note)))
        case .file(let name, let type, let copy):
            defer { try? FileManager.default.removeItem(at: copy) }
            try ShareQueue.save(name: name, type: type, bytes: Data(contentsOf: copy, options: .mappedIfSafe))
        case .text(let text):
            try saveText(text)
        }
    }

    private static func saveText(_ text: String) throws {
        try ShareQueue.save(name: "", type: "text/plain", bytes: Data(text.utf8))
    }

    private static func quickNote(_ page: WebPage, note: String) -> String {
        let title = page.title.split(whereSeparator: \.isNewline).joined(separator: " ")
        let lines = [clipped(title, maxTitle), page.url.absoluteString,
                     clipped(note.trimmingCharacters(in: .whitespacesAndNewlines), maxNote)]
        return lines.filter { !$0.isEmpty }.joined(separator: "\n")
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

private let cellID = "option"
private let statusIconSize: CGFloat = 48
private let rowPadding: CGFloat = 3
private let buttonInset: CGFloat = 10
private let barInset: CGFloat = 12
private let minimumNoteHeight: CGFloat = 32
private let reloadDuration = 0.2

private struct Option {
    let title: String
    let detail: String
    let symbol: String
    let selected: Bool
    let selectable: Bool
}

final class ShareController: UIViewController {
    private enum Section { case preview, destination, content, note }

    private var started = false
    private var shared: Shared?
    private var choice = ShareChoice(destination: .quickNotes, mode: .link)
    private let navigationBar = UINavigationBar()
    private let tableView = UITableView(frame: .zero, style: .insetGrouped)
    private let buttonBar = UIView()
    private let saveButton = UIButton(configuration: .filled())
    private let noteCell = UITableViewCell(style: .default, reuseIdentifier: nil)
    private let noteField = UITextField()
    private let statusStack = UIStackView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let statusIcon = UIImageView()
    private let statusTitle = UILabel()
    private let statusDetail = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        view.tintColor = accentTint
        prepareNavigation()
        prepareTable()
        prepareNote()
        prepareSaveButton()
        prepareStatus()
        layout()
        showStatus(symbol: nil, color: .label, title: words("Inhalt wird gelesen …", "Reading content…"), detail: "")
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        let providers = (extensionContext?.inputItems as? [NSExtensionItem])?.flatMap { $0.attachments ?? [] } ?? []
        Task { @MainActor in
            do { show(try await SharedLoader.load(providers)) } catch { fail(error) }
        }
    }

    private func prepareNavigation() {
        navigationItem.title = words("In Kladde sichern", "Save to Kladde")
        setCloseTitle(words("Abbrechen", "Cancel"))
        navigationBar.setItems([navigationItem], animated: false)
    }

    private func setCloseTitle(_ title: String) {
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: title, primaryAction: UIAction { [weak self] _ in self?.cancel() })
    }

    private func prepareTable() {
        tableView.dataSource = self
        tableView.delegate = self
        tableView.keyboardDismissMode = .interactive
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: cellID)
    }

    private func prepareNote() {
        noteField.placeholder = words("Notiz hinzufügen (optional)", "Add a note (optional)")
        noteField.font = .preferredFont(forTextStyle: .body)
        noteField.adjustsFontForContentSizeCategory = true
        noteField.returnKeyType = .done
        noteField.clearButtonMode = .whileEditing
        noteField.addAction(UIAction { [weak self] _ in self?.choice.note = self?.noteField.text ?? "" }, for: .editingChanged)
        noteField.addAction(UIAction { [weak self] _ in self?.noteField.resignFirstResponder() }, for: .editingDidEndOnExit)
        noteCell.selectionStyle = .none
        noteField.translatesAutoresizingMaskIntoConstraints = false
        noteCell.contentView.addSubview(noteField)
        let margins = noteCell.contentView.layoutMarginsGuide
        NSLayoutConstraint.activate([
            noteField.leadingAnchor.constraint(equalTo: margins.leadingAnchor),
            noteField.trailingAnchor.constraint(equalTo: margins.trailingAnchor),
            noteField.topAnchor.constraint(equalTo: margins.topAnchor),
            noteField.bottomAnchor.constraint(equalTo: margins.bottomAnchor),
            noteField.heightAnchor.constraint(greaterThanOrEqualToConstant: minimumNoteHeight),
        ])
    }

    private func prepareSaveButton() {
        saveButton.configuration?.buttonSize = .large
        saveButton.configuration?.baseBackgroundColor = accent
        saveButton.configuration?.baseForegroundColor = .white
        saveButton.configuration?.cornerStyle = .large
        saveButton.configuration?.titleLineBreakMode = .byTruncatingTail
        saveButton.addAction(UIAction { [weak self] _ in self?.save() }, for: .primaryActionTriggered)
        buttonBar.backgroundColor = .systemGroupedBackground
        buttonBar.addSubview(saveButton)
    }

    private func prepareStatus() {
        statusStack.axis = .vertical
        statusStack.alignment = .center
        statusStack.spacing = 12
        statusIcon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: statusIconSize)
        statusTitle.font = .preferredFont(forTextStyle: .title3)
        statusDetail.font = .preferredFont(forTextStyle: .body)
        statusDetail.textColor = .secondaryLabel
        for label in [statusTitle, statusDetail] {
            label.numberOfLines = 0
            label.textAlignment = .center
            label.adjustsFontForContentSizeCategory = true
        }
        for part in [spinner, statusIcon, statusTitle, statusDetail] as [UIView] { statusStack.addArrangedSubview(part) }
    }

    private func layout() {
        for part in [navigationBar, tableView, buttonBar, saveButton, statusStack] as [UIView] {
            part.translatesAutoresizingMaskIntoConstraints = false
        }
        for part in [navigationBar, tableView, buttonBar, statusStack] as [UIView] { view.addSubview(part) }
        NSLayoutConstraint.activate(frameConstraints() + buttonConstraints() + statusConstraints())
    }

    private func frameConstraints() -> [NSLayoutConstraint] {
        [
            navigationBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: barInset),
            navigationBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            navigationBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tableView.topAnchor.constraint(equalTo: navigationBar.bottomAnchor),
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tableView.bottomAnchor.constraint(equalTo: buttonBar.topAnchor),
            buttonBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            buttonBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            buttonBar.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
        ]
    }

    private func buttonConstraints() -> [NSLayoutConstraint] {
        let margins = buttonBar.layoutMarginsGuide
        return [
            saveButton.leadingAnchor.constraint(equalTo: margins.leadingAnchor),
            saveButton.trailingAnchor.constraint(equalTo: margins.trailingAnchor),
            saveButton.topAnchor.constraint(equalTo: buttonBar.topAnchor, constant: buttonInset),
            saveButton.bottomAnchor.constraint(equalTo: buttonBar.bottomAnchor, constant: -buttonInset),
        ]
    }

    private func statusConstraints() -> [NSLayoutConstraint] {
        let margins = view.layoutMarginsGuide
        return [
            statusStack.centerYAnchor.constraint(equalTo: tableView.centerYAnchor),
            statusStack.leadingAnchor.constraint(equalTo: margins.leadingAnchor),
            statusStack.trailingAnchor.constraint(equalTo: margins.trailingAnchor),
        ]
    }

    private func show(_ shared: Shared) {
        self.shared = shared
        choice = ShareChoice.initial(for: shared)
        tableView.reloadData()
        updateSaveButton()
        tableView.isHidden = false
        buttonBar.isHidden = false
        statusStack.isHidden = true
        spinner.stopAnimating()
    }

    private func showStatus(symbol: String?, color: UIColor, title: String, detail: String) {
        tableView.isHidden = true
        buttonBar.isHidden = true
        statusStack.isHidden = false
        spinner.isHidden = symbol != nil
        if symbol == nil { spinner.startAnimating() } else { spinner.stopAnimating() }
        statusIcon.isHidden = symbol == nil
        statusIcon.image = symbol.flatMap { UIImage(systemName: $0) }
        statusIcon.tintColor = color
        statusTitle.text = title
        statusDetail.text = detail
        statusDetail.isHidden = detail.isEmpty
    }

    private func fail(_ error: Error) {
        showStatus(symbol: "exclamationmark.triangle.fill", color: .systemOrange,
                   title: words("Nicht gespeichert", "Not saved"), detail: ShareStore.message(for: error))
        setCloseTitle(words("Schließen", "Close"))
        UINotificationFeedbackGenerator().notificationOccurred(.error)
    }

    private func updateSaveButton() {
        let place = choice.destination.title
        saveButton.configuration?.title = words("In „\(place)“ sichern", "Save to \(place)")
    }

    private func save() {
        guard let shared else { return }
        view.endEditing(true)
        setBusy(true)
        let choice = choice
        Task.detached(priority: .userInitiated) {
            let result = Result { try ShareStore.save(shared, choice: choice) }
            await MainActor.run { self.finish(result) }
        }
    }

    private func setBusy(_ busy: Bool) {
        saveButton.configuration?.showsActivityIndicator = busy
        saveButton.isEnabled = !busy
        tableView.isUserInteractionEnabled = !busy
        navigationItem.leftBarButtonItem?.isEnabled = !busy
    }

    private func finish(_ result: Result<Void, Error>) {
        setBusy(false)
        switch result {
        case .success: succeed()
        case .failure(let error): warn(error)
        }
    }

    private func succeed() {
        if let shared { ShareMemory.remember(choice, for: shared) }
        let place = choice.destination
        showStatus(symbol: "checkmark.circle.fill", color: .systemGreen,
                   title: words("In „\(place.title)“ gesichert", "Saved to \(place.title)"), detail: place.arrival)
        navigationItem.leftBarButtonItem = nil
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        Task { @MainActor in
            try? await Task.sleep(for: closeDelay)
            extensionContext?.completeRequest(returningItems: nil)
        }
    }

    private func warn(_ error: Error) {
        let alert = UIAlertController(title: words("Nicht gespeichert", "Not saved"),
                                      message: ShareStore.message(for: error), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
        UINotificationFeedbackGenerator().notificationOccurred(.error)
    }

    private func cancel() {
        if case .file(_, _, let copy) = shared { try? FileManager.default.removeItem(at: copy) }
        extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
    }

    private var sections: [Section] {
        guard let shared else { return [] }
        guard case .page = shared else { return [.preview, .destination] }
        return choice.destination == .webClips ? [.preview, .destination, .content, .note] : [.preview, .destination, .note]
    }

    private var destinations: [Destination] {
        shared.map(Destination.available(for:)) ?? []
    }

    private var modes: [ClipMode] {
        guard case .page(let page) = shared else { return [] }
        return ClipMode.available(for: page)
    }

    private var footer: String {
        choice.destination.arrival + " "
            + words("Die Zieldatenbank wählst du in Kladde unter Einstellungen › Ablage.",
                    "Pick the target database in Kladde under Settings › Destinations.")
    }

    private func choose(_ destination: Destination) {
        guard destination != choice.destination else { return }
        choice.destination = destination
        reloadChoices()
    }

    private func choose(_ mode: ClipMode) {
        guard mode != choice.mode else { return }
        choice.mode = mode
        reloadChoices()
    }

    private func reloadChoices() {
        UIView.transition(with: tableView, duration: reloadDuration, options: .transitionCrossDissolve) {
            self.tableView.reloadData()
        }
        updateSaveButton()
    }

    private func destinationOption(_ destination: Destination) -> Option {
        Option(title: destination.title, detail: shared.map(destination.detail(for:)) ?? "",
               symbol: destination.symbol, selected: destination == choice.destination,
               selectable: destinations.count > 1)
    }

    private func modeOption(_ mode: ClipMode) -> Option {
        Option(title: mode.label, detail: mode.detail, symbol: mode.symbol, selected: mode == choice.mode, selectable: true)
    }

    private func previewCell(at indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: cellID, for: indexPath)
        guard let shared else { return cell }
        let preview = Preview(shared)
        var content = UIListContentConfiguration.subtitleCell()
        content.text = preview.title
        content.textProperties.font = .preferredFont(forTextStyle: .headline)
        content.textProperties.numberOfLines = 3
        content.secondaryText = preview.detail
        content.secondaryTextProperties.color = .secondaryLabel
        content.image = UIImage(systemName: preview.symbol)
        content.imageProperties.tintColor = .secondaryLabel
        content.textToSecondaryTextVerticalPadding = rowPadding
        cell.contentConfiguration = content
        cell.accessoryType = .none
        cell.selectionStyle = .none
        cell.accessibilityTraits = .staticText
        return cell
    }

    private func optionCell(_ option: Option, at indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: cellID, for: indexPath)
        var content = UIListContentConfiguration.subtitleCell()
        content.text = option.title
        content.secondaryText = option.detail
        content.secondaryTextProperties.color = .secondaryLabel
        content.image = UIImage(systemName: option.symbol)
        content.textToSecondaryTextVerticalPadding = rowPadding
        cell.contentConfiguration = content
        cell.accessoryType = option.selected ? .checkmark : .none
        cell.selectionStyle = option.selectable ? .default : .none
        cell.accessibilityTraits = option.selected ? [.button, .selected] : .button
        return cell
    }
}

extension ShareController: UITableViewDataSource, UITableViewDelegate {
    func numberOfSections(in tableView: UITableView) -> Int {
        sections.count
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        switch sections[section] {
        case .preview, .note: 1
        case .destination: destinations.count
        case .content: modes.count
        }
    }

    func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        switch sections[section] {
        case .preview: nil
        case .destination: words("Ablegen in", "Save to")
        case .content: words("Was gespeichert wird", "What gets saved")
        case .note: words("Notiz", "Note")
        }
    }

    func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        section == sections.count - 1 ? footer : nil
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        switch sections[indexPath.section] {
        case .preview: previewCell(at: indexPath)
        case .destination: optionCell(destinationOption(destinations[indexPath.row]), at: indexPath)
        case .content: optionCell(modeOption(modes[indexPath.row]), at: indexPath)
        case .note: noteCell
        }
    }

    func tableView(_ tableView: UITableView, shouldHighlightRowAt indexPath: IndexPath) -> Bool {
        switch sections[indexPath.section] {
        case .preview, .note: false
        case .destination: destinations.count > 1
        case .content: true
        }
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        switch sections[indexPath.section] {
        case .destination: choose(destinations[indexPath.row])
        case .content: choose(modes[indexPath.row])
        case .preview, .note: break
        }
    }
}
