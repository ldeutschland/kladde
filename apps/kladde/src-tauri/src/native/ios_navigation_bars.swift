import UIKit
import WebKit

public typealias ChromeNotice = @convention(c) (UnsafePointer<CChar>) -> Void

private enum Measure {
    static let side: CGFloat = 16
    static let barHeight: CGFloat = 62
    static let barLift: CGFloat = 12
    static let barInset: CGFloat = 4
    static let gap: CGFloat = 10
    static let merge: CGFloat = 14
    static let control: CGFloat = 44
    static let topInset: CGFloat = 4
    static let symbol: CGFloat = 17
    static let tabSymbol: CGFloat = 18
    static let tabTitle: CGFloat = 10
    static let tabTitleMax: CGFloat = 13
    static let selectionAlpha: CGFloat = 0.1
    static let lensDelay = 0.12
    static let lensScale: CGFloat = 1.22
    static let hoverScale: CGFloat = 1.12
    static let fade = 0.2
    static let spring = 0.4
    static let bounce: CGFloat = 0.18
    static let contentPrefix = "WKContent"
    static let quietClass = "KladdeQuietContentView"
    static let screens = 6
    static let swipeEdge: CGFloat = 24
    static let parallax: CGFloat = 0.3
    static let dimming: CGFloat = 0.1
    static let edgeShadow: Float = 0.18
    static let edgeShadowRadius: CGFloat = 12
    static let commitShare: CGFloat = 0.4
    static let flick: CGFloat = 1.2
    static let maxSpring: CGFloat = 20
    static let swipeSeconds = 0.36
    static let revealDelay = 0.2
    static let revealLimit = 1.5
}

private struct ChromeState: Decodable, Equatable {
    struct Labels: Decodable, Equatable {
        let home: String
        let pages: String
        let search: String
        let ai: String
        let add: String
        let back: String
        let favorite: String
        let more: String
        let settings: String
    }

    let bar: Bool
    let tab: String
    let top: String
    let favorite: Bool
    let dark: Bool?
    let view: String?
    let behind: String?
    let ai: Bool
    let labels: Labels
}

@MainActor
private final class Swipe {
    let cover = UIView()
    let leaving: UIView
    let arriving: UIView
    let shade = UIView()
    let from: String?
    var settling = false
    var waiting = false
    var revealing = false

    init(leaving: UIView, arriving: UIView, from: String?) {
        self.leaving = leaving
        self.arriving = arriving
        self.from = from
    }

    func place(_ progress: CGFloat) {
        let width = cover.bounds.width
        leaving.transform = CGAffineTransform(translationX: width * progress, y: 0)
        arriving.transform = CGAffineTransform(translationX: -width * Measure.parallax * (1 - progress), y: 0)
        shade.alpha = Measure.dimming * (1 - progress)
    }
}

private struct TabItem {
    let action: String
    let symbol: String
    let selectable: Bool
}

private let tabItems = [
    TabItem(action: "home", symbol: "house", selectable: true),
    TabItem(action: "pages", symbol: "doc.text", selectable: true),
    TabItem(action: "search", symbol: "magnifyingglass", selectable: false),
    TabItem(action: "ai", symbol: "sparkles", selectable: false),
]

private final class PassthroughGlass: UIVisualEffectView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self || hit === contentView ? nil : hit
    }
}

@MainActor
private final class Chrome: NSObject {
    static let shared = Chrome()
    private var notice: ChromeNotice?
    private var state: ChromeState?
    private var typing = false
    private weak var host: UIView?
    private weak var web: WKWebView?
    private var documentPin: NSKeyValueObservation?
    private var screens: [String: UIView] = [:]
    private var screenOrder: [String] = []
    private var swipe: Swipe?
    private let cluster = PassthroughGlass()
    private let bar = UIVisualEffectView()
    private let barGlass = Chrome.glass()
    private let selection = UIView()
    private var selectionPins: [NSLayoutConstraint] = []
    private let lens = UIVisualEffectView()
    private let lensGlass = UIGlassEffect(style: .clear)
    private var hovered: Int?
    private let tabs = UIStackView()
    private var tabButtons: [String: UIButton] = [:]
    private let addButton = UIButton(type: .system)
    private let backButton = UIButton(type: .system)
    private let pageGroup = UIVisualEffectView()
    private let pageGlass = Chrome.glass()
    private let favoriteButton = UIButton(type: .system)
    private let moreButton = UIButton(type: .system)
    private let settingsButton = UIButton(type: .system)
    private let trailing = UIStackView()
    private let selectionFeedback = UISelectionFeedbackGenerator()
    private let tapFeedback = UIImpactFeedbackGenerator(style: .light)

    private static func glass() -> UIGlassEffect {
        let glass = UIGlassEffect(style: .regular)
        glass.isInteractive = true
        return glass
    }

    func apply(_ next: ChromeState, _ notice: ChromeNotice) {
        self.notice = notice
        guard install() else { return }
        guard next != state else { return }
        state = next
        refresh()
        if let swipe, swipe.waiting, next.view != swipe.from { reveal(swipe) }
    }

    private var window: UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.flatMap(\.windows)
        return windows.first(where: \.isKeyWindow) ?? windows.first
    }

    private func install() -> Bool {
        if host != nil { return true }
        guard let view = window?.rootViewController?.view else { return false }
        host = view
        calm(view)
        buildBar(in: view)
        buildTop(in: view)
        buildSwipe(in: view)
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(keyboardShown), name: UIResponder.keyboardWillShowNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardHidden), name: UIResponder.keyboardWillHideNotification, object: nil)
        center.addObserver(self, selector: #selector(textSizeChanged), name: UIContentSizeCategory.didChangeNotification, object: nil)
        return true
    }

    private func calm(_ view: UIView) {
        if let web = view as? WKWebView {
            self.web = web
            web.scrollView.bounces = false
            web.scrollView.alwaysBounceVertical = false
            web.scrollView.contentInsetAdjustmentBehavior = .never
            web.allowsLinkPreview = false
            quietKeyboard(web)
            pinDocument(web.scrollView)
        }
        view.subviews.forEach(calm)
    }

    private func pinDocument(_ scroll: UIScrollView) {
        documentPin = scroll.observe(\.contentOffset) { scroll, _ in
            MainActor.assumeIsolated {
                guard scroll.zoomScale <= scroll.minimumZoomScale, scroll.contentOffset != .zero else { return }
                scroll.contentOffset = .zero
            }
        }
    }

    private func quietKeyboard(_ web: WKWebView) {
        let content = web.scrollView.subviews.first { NSStringFromClass(type(of: $0)).hasPrefix(Measure.contentPrefix) }
        guard let content, let base = object_getClass(content) else { return }
        let name = Measure.quietClass
        if let known = NSClassFromString(name) {
            object_setClass(content, known)
            return
        }
        guard let quiet = objc_allocateClassPair(base, name, 0) else { return }
        let none: @convention(block) (AnyObject) -> UIView? = { _ in nil }
        let getter = #selector(getter: UIResponder.inputAccessoryView)
        class_addMethod(quiet, getter, imp_implementationWithBlock(none), "@@:")
        objc_registerClassPair(quiet)
        object_setClass(content, quiet)
    }

    private func buildBar(in view: UIView) {
        let container = UIGlassContainerEffect()
        container.spacing = Measure.merge
        cluster.effect = container
        cluster.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cluster)
        bar.effect = barGlass
        bar.cornerConfiguration = .capsule()
        bar.translatesAutoresizingMaskIntoConstraints = false
        selection.isUserInteractionEnabled = false
        selection.backgroundColor = UIColor.label.withAlphaComponent(Measure.selectionAlpha)
        selection.cornerConfiguration = .capsule()
        selection.translatesAutoresizingMaskIntoConstraints = false
        bar.contentView.addSubview(selection)
        tabs.axis = .horizontal
        tabs.distribution = .fillEqually
        tabs.translatesAutoresizingMaskIntoConstraints = false
        for item in tabItems {
            let button = UIButton(type: .system)
            button.addAction(UIAction { [weak self] _ in self?.pick(item) }, for: .touchUpInside)
            tabButtons[item.action] = button
            tabs.addArrangedSubview(button)
        }
        bar.contentView.addSubview(tabs)
        cluster.contentView.addSubview(bar)
        addButton.translatesAutoresizingMaskIntoConstraints = false
        addButton.configuration = round("plus", prominent: true)
        addButton.addAction(UIAction { [weak self] _ in self?.create() }, for: .touchUpInside)
        cluster.contentView.addSubview(addButton)
        buildLens(in: view)
        let resting = bar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: Measure.barLift)
        resting.priority = .defaultHigh
        NSLayoutConstraint.activate([
            cluster.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            cluster.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            cluster.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            cluster.topAnchor.constraint(equalTo: bar.topAnchor, constant: -Measure.merge),
            tabs.leadingAnchor.constraint(equalTo: bar.contentView.leadingAnchor, constant: Measure.barInset),
            tabs.trailingAnchor.constraint(equalTo: bar.contentView.trailingAnchor, constant: -Measure.barInset),
            tabs.topAnchor.constraint(equalTo: bar.contentView.topAnchor, constant: Measure.barInset),
            tabs.bottomAnchor.constraint(equalTo: bar.contentView.bottomAnchor, constant: -Measure.barInset),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Measure.side),
            bar.heightAnchor.constraint(equalToConstant: Measure.barHeight),
            bar.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -Measure.barLift),
            resting,
            addButton.leadingAnchor.constraint(equalTo: bar.trailingAnchor, constant: Measure.gap),
            addButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Measure.side),
            addButton.widthAnchor.constraint(equalToConstant: Measure.barHeight),
            addButton.heightAnchor.constraint(equalToConstant: Measure.barHeight),
            addButton.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
        ])
    }

    private func buildLens(in view: UIView) {
        lens.isUserInteractionEnabled = false
        lens.cornerConfiguration = .capsule()
        lens.isHidden = true
        view.addSubview(lens)
        let glide = UILongPressGestureRecognizer(target: self, action: #selector(glide(_:)))
        glide.minimumPressDuration = Measure.lensDelay
        glide.allowableMovement = .greatestFiniteMagnitude
        bar.addGestureRecognizer(glide)
    }

    private func buildTop(in view: UIView) {
        let rounds: [(UIButton, String, String)] = [
            (backButton, "chevron.left", "back"),
            (settingsButton, "gearshape", "settings"),
        ]
        for (button, symbol, action) in rounds {
            button.configuration = round(symbol, prominent: false)
            fix(button, action)
        }
        let grouped: [(UIButton, String, String)] = [
            (favoriteButton, "star", "favorite"),
            (moreButton, "ellipsis", "more"),
        ]
        for (button, symbol, action) in grouped {
            button.configuration = inset(symbol)
            fix(button, action)
        }
        let pair = UIStackView(arrangedSubviews: [favoriteButton, moreButton])
        pair.axis = .horizontal
        pair.translatesAutoresizingMaskIntoConstraints = false
        pageGroup.effect = pageGlass
        pageGroup.cornerConfiguration = .capsule()
        pageGroup.contentView.addSubview(pair)
        trailing.axis = .horizontal
        trailing.spacing = 8
        trailing.translatesAutoresizingMaskIntoConstraints = false
        [pageGroup, settingsButton].forEach(trailing.addArrangedSubview)
        view.addSubview(backButton)
        view.addSubview(trailing)
        let top = view.safeAreaLayoutGuide.topAnchor
        NSLayoutConstraint.activate([
            pair.leadingAnchor.constraint(equalTo: pageGroup.contentView.leadingAnchor),
            pair.trailingAnchor.constraint(equalTo: pageGroup.contentView.trailingAnchor),
            pair.topAnchor.constraint(equalTo: pageGroup.contentView.topAnchor),
            pair.bottomAnchor.constraint(equalTo: pageGroup.contentView.bottomAnchor),
            backButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Measure.side),
            backButton.topAnchor.constraint(equalTo: top, constant: Measure.topInset),
            trailing.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Measure.side),
            trailing.topAnchor.constraint(equalTo: top, constant: Measure.topInset),
        ])
    }

    private func buildSwipe(in view: UIView) {
        let edge = UIPanGestureRecognizer(target: self, action: #selector(swipeBack(_:)))
        edge.maximumNumberOfTouches = 1
        edge.delegate = self
        view.addGestureRecognizer(edge)
    }

    func remember(_ key: String) {
        guard let web, let picture = web.snapshotView(afterScreenUpdates: false) else { return }
        screens[key] = picture
        screenOrder.removeAll { $0 == key }
        screenOrder.append(key)
        while screenOrder.count > Measure.screens {
            screens.removeValue(forKey: screenOrder.removeFirst())
        }
    }

    private func screen(_ key: String?, fitting size: CGSize) -> UIView {
        if let key, let picture = screens[key], picture.bounds.size == size { return picture }
        let plain = UIView()
        plain.backgroundColor = .systemBackground
        return plain
    }

    private func canSwipe(_ gesture: UIPanGestureRecognizer) -> Bool {
        guard let host, swipe == nil, web != nil, state?.top == "page", state?.bar == true else { return false }
        let start = gesture.location(in: host).x - gesture.translation(in: host).x
        let velocity = gesture.velocity(in: host)
        return start <= Measure.swipeEdge && velocity.x > abs(velocity.y)
    }

    @objc private func swipeBack(_ gesture: UIPanGestureRecognizer) {
        guard let host else { return }
        let width = max(host.bounds.width, 1)
        let progress = min(max(gesture.translation(in: host).x / width, 0), 1)
        switch gesture.state {
        case .began: beginSwipe()
        case .changed: swipe?.place(progress)
        case .ended: endSwipe(progress, speed: gesture.velocity(in: host).x / width)
        default: endSwipe(progress, speed: -Measure.flick * 2)
        }
    }

    private func beginSwipe() {
        guard let web, let parent = web.superview, let state,
              let leaving = web.snapshotView(afterScreenUpdates: false) else { return }
        let arriving = screen(state.behind, fitting: web.bounds.size)
        let made = Swipe(leaving: leaving, arriving: arriving, from: state.view)
        made.cover.frame = web.frame
        made.cover.clipsToBounds = true
        made.cover.isUserInteractionEnabled = false
        made.cover.backgroundColor = .systemBackground
        made.shade.backgroundColor = .black
        for part in [arriving, made.shade, leaving] {
            part.frame = made.cover.bounds
            made.cover.addSubview(part)
        }
        leaving.layer.shadowColor = UIColor.black.cgColor
        leaving.layer.shadowOpacity = Measure.edgeShadow
        leaving.layer.shadowRadius = Measure.edgeShadowRadius
        leaving.layer.shadowPath = UIBezierPath(rect: leaving.bounds).cgPath
        parent.insertSubview(made.cover, aboveSubview: web)
        made.place(0)
        swipe = made
    }

    private func endSwipe(_ progress: CGFloat, speed: CGFloat) {
        guard let swipe, !swipe.settling else { return }
        let leave = speed > Measure.flick || (speed > -Measure.flick && progress > Measure.commitShare)
        let remaining = max(leave ? 1 - progress : progress, 0.01)
        let push = min(max((leave ? speed : -speed) / remaining, 0), Measure.maxSpring)
        let timing = UISpringTimingParameters(dampingRatio: 1, initialVelocity: CGVector(dx: push, dy: 0))
        let animator = UIViewPropertyAnimator(duration: Measure.swipeSeconds, timingParameters: timing)
        animator.addAnimations { swipe.place(leave ? 1 : 0) }
        animator.addCompletion { [weak self] _ in
            if leave { self?.awaitArrival(swipe) } else { self?.dismiss(swipe) }
        }
        swipe.settling = true
        if leave { send("back") }
        animator.startAnimation()
    }

    private func awaitArrival(_ swipe: Swipe) {
        if state?.view != swipe.from { return reveal(swipe) }
        swipe.waiting = true
        DispatchQueue.main.asyncAfter(deadline: .now() + Measure.revealLimit) { [weak self] in
            self?.reveal(swipe)
        }
    }

    private func reveal(_ swipe: Swipe) {
        guard self.swipe === swipe, !swipe.revealing else { return }
        swipe.revealing = true
        UIView.animate(withDuration: Measure.fade, delay: Measure.revealDelay, options: [], animations: {
            swipe.cover.alpha = 0
        }, completion: { [weak self] _ in
            self?.dismiss(swipe)
        })
    }

    private func dismiss(_ swipe: Swipe) {
        swipe.cover.removeFromSuperview()
        if self.swipe === swipe { self.swipe = nil }
    }

    private func fix(_ button: UIButton, _ action: String) {
        button.translatesAutoresizingMaskIntoConstraints = false
        button.addAction(UIAction { [weak self] _ in self?.send(action) }, for: .touchUpInside)
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: Measure.control),
            button.heightAnchor.constraint(equalToConstant: Measure.control),
        ])
    }

    private func inset(_ symbol: String) -> UIButton.Configuration {
        var configuration = UIButton.Configuration.plain()
        let weight = UIImage.SymbolConfiguration(pointSize: Measure.symbol, weight: .semibold)
        configuration.image = UIImage(systemName: symbol, withConfiguration: weight)
        configuration.baseForegroundColor = .label
        configuration.cornerStyle = .capsule
        return configuration
    }

    private func round(_ symbol: String, prominent: Bool) -> UIButton.Configuration {
        var configuration: UIButton.Configuration = prominent ? .prominentGlass() : .glass()
        let weight = UIImage.SymbolConfiguration(pointSize: Measure.symbol, weight: .semibold)
        configuration.image = UIImage(systemName: symbol, withConfiguration: weight)
        configuration.cornerStyle = .capsule
        return configuration
    }

    private func tab(_ item: TabItem, _ title: String, selected: Bool) -> UIButton.Configuration {
        var configuration = UIButton.Configuration.plain()
        let weight = UIImage.SymbolConfiguration(pointSize: Measure.tabSymbol, weight: .medium)
        let symbol = selected ? item.symbol + ".fill" : item.symbol
        configuration.image = UIImage(systemName: symbol, withConfiguration: weight)
            ?? UIImage(systemName: item.symbol, withConfiguration: weight)
        configuration.imagePlacement = .top
        configuration.imagePadding = 3
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 2, bottom: 4, trailing: 2)
        configuration.title = title
        configuration.titleLineBreakMode = .byTruncatingTail
        let font = UIFontMetrics(forTextStyle: .caption2).scaledFont(
            for: .systemFont(ofSize: Measure.tabTitle, weight: selected ? .semibold : .medium),
            maximumPointSize: Measure.tabTitleMax
        )
        configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var outgoing = incoming
            outgoing.font = font
            return outgoing
        }
        configuration.baseForegroundColor = selected ? .tintColor : .label
        configuration.background.backgroundColor = .clear
        return configuration
    }

    private func title(_ action: String, _ labels: ChromeState.Labels) -> String {
        switch action {
        case "home": return labels.home
        case "pages": return labels.pages
        case "search": return labels.search
        default: return labels.ai
        }
    }

    private func refresh(animated: Bool = true) {
        guard let state else { return }
        if let dark = state.dark {
            window?.overrideUserInterfaceStyle = dark ? .dark : .light
        } else {
            window?.overrideUserInterfaceStyle = .unspecified
        }
        for item in tabItems {
            guard let button = tabButtons[item.action] else { continue }
            button.isHidden = !shown(item)
            let label = title(item.action, state.labels)
            let selected = item.selectable && item.action == state.tab
            button.configuration = tab(item, label, selected: selected)
            button.accessibilityLabel = label
            button.accessibilityTraits = selected ? [.button, .selected] : .button
            if selected { moveSelection(to: button, animated: animated) }
        }
        addButton.accessibilityLabel = state.labels.add
        backButton.accessibilityLabel = state.labels.back
        favoriteButton.accessibilityLabel = state.labels.favorite
        favoriteButton.accessibilityTraits = state.favorite ? [.button, .selected] : .button
        moreButton.accessibilityLabel = state.labels.more
        settingsButton.accessibilityLabel = state.labels.settings
        let star = UIImage.SymbolConfiguration(pointSize: Measure.symbol, weight: .semibold)
        favoriteButton.configuration?.image = UIImage(systemName: state.favorite ? "star.fill" : "star", withConfiguration: star)
        favoriteButton.configuration?.baseForegroundColor = state.favorite ? .systemYellow : .label
        let page = state.top == "page"
        let root = state.top == "root"
        show(backButton, page)
        reveal(pageGroup, pageGlass, page)
        show(settingsButton, root)
        showBar()
    }

    private func moveSelection(to button: UIButton, animated: Bool) {
        NSLayoutConstraint.deactivate(selectionPins)
        selectionPins = [
            selection.leadingAnchor.constraint(equalTo: button.leadingAnchor),
            selection.trailingAnchor.constraint(equalTo: button.trailingAnchor),
            selection.topAnchor.constraint(equalTo: button.topAnchor),
            selection.bottomAnchor.constraint(equalTo: button.bottomAnchor),
        ]
        NSLayoutConstraint.activate(selectionPins)
        guard animated, !selection.frame.isEmpty, !UIAccessibility.isReduceMotionEnabled else {
            bar.layoutIfNeeded()
            return
        }
        UIView.animate(springDuration: Measure.spring, bounce: Measure.bounce) {
            self.bar.layoutIfNeeded()
        }
    }

    @objc private func glide(_ gesture: UILongPressGestureRecognizer) {
        let x = gesture.location(in: tabs).x
        switch gesture.state {
        case .began: liftLens(at: x)
        case .changed: follow(x)
        case .ended: dropLens(choosing: true)
        default: dropLens(choosing: false)
        }
    }

    private func liftLens(at x: CGFloat) {
        selectionFeedback.prepare()
        placeLens(at: x)
        lens.isHidden = false
        hover(tabIndex(at: x))
        let lifted = UIAccessibility.isReduceMotionEnabled
            ? CGAffineTransform.identity
            : CGAffineTransform(scaleX: Measure.lensScale, y: Measure.lensScale)
        settle {
            self.lens.effect = self.lensGlass
            self.lens.transform = lifted
            self.selection.alpha = 0
        }
    }

    private func follow(_ x: CGFloat) {
        placeLens(at: x)
        let index = tabIndex(at: x)
        guard index != hovered else { return }
        selectionFeedback.selectionChanged()
        hover(index)
    }

    private var shownItems: [TabItem] {
        tabItems.filter(shown)
    }

    private func shown(_ item: TabItem) -> Bool {
        item.action != "ai" || state?.ai == true
    }

    private func dropLens(choosing: Bool) {
        guard let index = hovered else { return }
        hover(nil)
        let items = shownItems
        guard items.indices.contains(index) else { return }
        let item = items[index]
        if choosing, item.selectable, let button = tabButtons[item.action] {
            moveSelection(to: button, animated: false)
        }
        let target = selection.convert(selection.bounds, to: lens.superview)
        settle({
            self.lens.effect = nil
            self.lens.transform = .identity
            self.lens.bounds = CGRect(origin: .zero, size: target.size)
            self.lens.center = CGPoint(x: target.midX, y: target.midY)
            self.selection.alpha = 1
        }, then: {
            self.lens.isHidden = self.hovered == nil
        })
        if choosing { send(item.action) }
    }

    private func tabIndex(at x: CGFloat) -> Int {
        let count = shownItems.count
        let width = tabs.bounds.width / CGFloat(count)
        guard width > 0 else { return 0 }
        return min(max(Int(x / width), 0), count - 1)
    }

    private func placeLens(at x: CGFloat) {
        let width = tabs.bounds.width / CGFloat(shownItems.count)
        let center = min(max(x, width / 2), tabs.bounds.width - width / 2)
        let cell = CGRect(x: center - width / 2, y: 0, width: width, height: tabs.bounds.height)
        let frame = tabs.convert(cell, to: lens.superview)
        lens.bounds = CGRect(origin: .zero, size: frame.size)
        lens.center = CGPoint(x: frame.midX, y: frame.midY)
    }

    private func hover(_ index: Int?) {
        let previous = hovered
        hovered = index
        guard !UIAccessibility.isReduceMotionEnabled else { return }
        let grown = CGAffineTransform(scaleX: Measure.hoverScale, y: Measure.hoverScale)
        let leaving = shownButton(previous)
        let entering = shownButton(index)
        UIView.animate(springDuration: Measure.spring, bounce: Measure.bounce) {
            leaving?.transform = .identity
            entering?.transform = grown
        }
    }

    private func shownButton(_ index: Int?) -> UIButton? {
        let items = shownItems
        guard let index, items.indices.contains(index) else { return nil }
        return tabButtons[items[index].action]
    }

    private func settle(_ changes: @escaping () -> Void, then finish: @escaping () -> Void = {}) {
        guard !UIAccessibility.isReduceMotionEnabled else {
            UIView.animate(withDuration: Measure.fade, animations: changes) { _ in finish() }
            return
        }
        UIView.animate(springDuration: Measure.spring, bounce: Measure.bounce, animations: changes) { _ in finish() }
    }

    private func showBar() {
        let visible = state?.bar == true && !typing
        reveal(bar, barGlass, visible)
        show(addButton, visible)
    }

    private func reveal(_ view: UIVisualEffectView, _ glass: UIGlassEffect, _ visible: Bool) {
        if visible { view.isHidden = false }
        UIView.animate(withDuration: Measure.fade, animations: {
            view.effect = visible ? glass : nil
            view.contentView.alpha = visible ? 1 : 0
        }, completion: { _ in
            view.isHidden = view.contentView.alpha == 0
        })
    }

    private func show(_ view: UIView, _ visible: Bool) {
        if visible { view.isHidden = false }
        UIView.animate(withDuration: Measure.fade, animations: {
            view.alpha = visible ? 1 : 0
        }, completion: { _ in
            view.isHidden = view.alpha == 0
        })
    }

    private func pick(_ item: TabItem) {
        if item.selectable, item.action != state?.tab {
            selectionFeedback.selectionChanged()
        }
        send(item.action)
    }

    private func create() {
        tapFeedback.impactOccurred()
        send("add")
    }

    private func send(_ action: String) {
        guard let notice else { return }
        action.withCString { notice($0) }
    }

    @objc private func keyboardShown() {
        typing = true
        showBar()
    }

    @objc private func keyboardHidden() {
        typing = false
        showBar()
    }

    @objc private func textSizeChanged() {
        refresh(animated: false)
    }

    func share(_ url: URL) {
        guard let controller = window?.rootViewController else { return }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
        }
        sheet.popoverPresentationController?.sourceView = controller.view
        controller.present(sheet, animated: true)
    }
}

extension Chrome: UIGestureRecognizerDelegate {
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
        return canSwipe(pan)
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        otherGestureRecognizer is UIPanGestureRecognizer && otherGestureRecognizer.view is UIScrollView
    }
}

@_cdecl("kladde_chrome_remember")
public func chromeRemember(_ key: UnsafePointer<CChar>) {
    let name = String(cString: key)
    let remember = { MainActor.assumeIsolated { Chrome.shared.remember(name) } }
    if Thread.isMainThread {
        remember()
    } else {
        DispatchQueue.main.sync(execute: remember)
    }
}

@_cdecl("kladde_chrome_update")
public func chromeUpdate(_ state: UnsafePointer<CChar>, _ notice: ChromeNotice) {
    let text = String(cString: state)
    DispatchQueue.main.async {
        guard let decoded = try? JSONDecoder().decode(ChromeState.self, from: Data(text.utf8)) else { return }
        Chrome.shared.apply(decoded, notice)
    }
}

@_cdecl("kladde_share_file")
public func shareFile(_ path: UnsafePointer<CChar>) {
    let url = URL(fileURLWithPath: String(cString: path))
    DispatchQueue.main.async {
        Chrome.shared.share(url)
    }
}
