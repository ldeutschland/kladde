import AVFoundation
import Foundation
import Speech

public typealias AudioNotice = @convention(c) (UnsafePointer<CChar>) -> Void

private enum Setting {
    static let sampleRate = 44_100.0
    static let bitRate = 64_000
    static let levelInterval = 0.1
    static let quietDecibels = -50.0
    static let waitingSeconds = 20.0
    static let tapFrames: AVAudioFrameCount = 4_096
    static let reconnectAttempts = 5
    static let reconnectDelay = 0.4
}

struct Notifier: @unchecked Sendable {
    let call: AudioNotice
    var generation: UInt64 = 0

    func send(_ fields: [String: Any]) {
        var fields = fields
        fields["generation"] = generation
        guard let data = try? JSONSerialization.data(withJSONObject: fields),
              let text = String(data: data, encoding: .utf8) else { return }
        text.withCString { call($0) }
    }

    func fail(_ reason: String) {
        send(["kind": "failed", "reason": reason])
    }
}

private final class Transcript: @unchecked Sendable {
    private let lock = NSLock()
    private var settled = ""
    private var pending = ""

    func accept(_ text: String, final: Bool) -> (String, String) {
        lock.lock()
        defer { lock.unlock() }
        if final {
            settled = Transcript.joined(settled, text)
            pending = ""
        } else {
            pending = text
        }
        return (settled, pending)
    }

    var whole: String {
        lock.lock()
        defer { lock.unlock() }
        return Transcript.joined(settled, pending).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func joined(_ head: String, _ tail: String) -> String {
        let addition = tail.trimmingCharacters(in: .newlines)
        guard !addition.isEmpty else { return head }
        guard let last = head.last else { return addition }
        let spaced = last.isWhitespace || addition.first?.isWhitespace == true
        return spaced ? head + addition : head + " " + addition
    }
}

private struct Listener {
    let modules: [any SpeechModule]
    let texts: AsyncThrowingStream<(String, Bool), Error>
}

private func texts<Results: AsyncSequence>(
    _ results: Results,
    _ read: @escaping (Results.Element) -> (String, Bool)
) -> AsyncThrowingStream<(String, Bool), Error> {
    AsyncThrowingStream { continuation in
        let task = Task {
            do {
                for try await result in results { continuation.yield(read(result)) }
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
        continuation.onTermination = { _ in task.cancel() }
    }
}

private func dictationAllowed() async -> Bool {
    await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
    }
}

private func listener(_ locale: Locale, live: Bool) async -> Listener? {
    if SpeechTranscriber.isAvailable,
       let match = await SpeechTranscriber.supportedLocale(equivalentTo: locale) {
        let module = SpeechTranscriber(locale: match, preset: live ? .progressiveTranscription : .transcription)
        let stream = texts(module.results) { (String($0.text.characters), $0.isFinal) }
        return Listener(modules: [module], texts: stream)
    }
    guard let match = await DictationTranscriber.supportedLocale(equivalentTo: locale),
          await dictationAllowed() else { return nil }
    let module = DictationTranscriber(locale: match, preset: live ? .progressiveLongDictation : .longDictation)
    let stream = texts(module.results) { (String($0.text.characters), $0.isFinal) }
    return Listener(modules: [module], texts: stream)
}

private func installed(_ modules: [any SpeechModule], _ notifier: Notifier) async throws -> Bool {
    if await AssetInventory.status(forModules: modules) == .unsupported { return false }
    guard let request = try await AssetInventory.assetInstallationRequest(supporting: modules) else { return true }
    notifier.send(["kind": "model"])
    try await request.downloadAndInstall()
    return true
}

private func converted(_ buffer: AVAudioPCMBuffer, by converter: AVAudioConverter) -> AVAudioPCMBuffer? {
    let ratio = converter.outputFormat.sampleRate / converter.inputFormat.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
    guard let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: capacity) else { return nil }
    var supplied = false
    var failure: NSError?
    let status = converter.convert(to: output, error: &failure) { _, state in
        if supplied {
            state.pointee = .noDataNow
            return nil
        }
        supplied = true
        state.pointee = .haveData
        return buffer
    }
    guard status != .error, output.frameLength > 0 else { return nil }
    return output
}

private func loudness(_ buffer: AVAudioPCMBuffer) -> Double {
    guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
    var sum = 0.0
    for index in 0..<Int(buffer.frameLength) {
        let sample = Double(samples[index])
        sum += sample * sample
    }
    let power = sum / Double(buffer.frameLength)
    guard power > 0 else { return 0 }
    let decibels = 10 * log10(power)
    return min(1, max(0, 1 - decibels / Setting.quietDecibels))
}

private func transcribed(_ url: URL, _ locale: Locale, _ notifier: Notifier) async throws -> String? {
    guard let heard = await listener(locale, live: false),
          try await installed(heard.modules, notifier) else { return nil }
    let file = try AVAudioFile(forReading: url)
    let analyzer = SpeechAnalyzer(modules: heard.modules)
    let transcript = Transcript()
    let reading = Task {
        for try await (text, final) in heard.texts {
            let (settled, pending) = transcript.accept(text, final: final)
            notifier.send(["kind": "text", "settled": settled, "pending": pending])
        }
    }
    if let end = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: end)
    } else {
        await analyzer.cancelAndFinishNow()
    }
    try await reading.value
    return transcript.whole
}

final class Session: @unchecked Sendable {
    private let notifier: Notifier
    private let url: URL
    private let locale: Locale
    private var engine: AVAudioEngine?
    private let transcript = Transcript()
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var toFile: AVAudioConverter?
    private var toSpeech: AVAudioConverter?
    private var speech: AsyncStream<AnalyzerInput>.Continuation?
    private var analyzer: SpeechAnalyzer?
    private var reading: Task<Void, Never>?
    private var waiting: [AVAudioPCMBuffer]? = []
    private var frames: AVAudioFramePosition = 0
    private var noticed = Date.distantPast
    private var paused = false
    private var closed = false
    private var observers: [NSObjectProtocol] = []
    private let control = DispatchQueue(label: "kladde.audio.control")

    init(url: URL, locale: Locale, notifier: Notifier) {
        self.url = url
        self.locale = locale
        self.notifier = notifier
    }

    func begin() throws {
        #if os(iOS)
        let shared = AVAudioSession.sharedInstance()
        try shared.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try shared.setActive(true)
        #endif
        try open()
        observe()
        try control.sync {
            guard !lock.withLock({ closed }) else { throw CancellationError() }
            try listen()
        }
        announce()
    }

    func open() throws {
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: Setting.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: Setting.bitRate,
        ]
        file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    }

    func announce() {
        notifier.send(["kind": "state", "state": "recording"])
        Task { await self.hear() }
    }

    private func listen() throws {
        retire()
        let fresh = AVAudioEngine()
        let input = fresh.inputNode
        let hardware = input.inputFormat(forBus: 0)
        guard hardware.sampleRate > 0, hardware.channelCount > 0 else {
            throw CocoaError(.featureUnsupported)
        }
        input.installTap(onBus: 0, bufferSize: Setting.tapFrames, format: hardware) { [weak self] buffer, _ in
            self?.take(buffer)
        }
        engine = fresh
        fresh.prepare()
        try fresh.start()
    }

    private func retire() {
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        engine = nil
    }

    private func observe() {
        let center = NotificationCenter.default
        let changed = center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) { [weak self] note in
            guard let self, let source = note.object as AnyObject? else { return }
            let changedEngine = ObjectIdentifier(source)
            self.control.async { self.reconnect(changedEngine) }
        }
        observers.append(changed)
        #if os(iOS)
        let interrupted = center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] _ in
            guard let self else { return }
            self.control.async { self.hold() }
        }
        observers.append(interrupted)
        #endif
    }

    func take(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard !paused, let file, let toFile = fileConverter(from: buffer.format, into: file),
              let mono = converted(buffer, by: toFile) else { return }
        do {
            try file.write(from: mono)
        } catch {
            return
        }
        frames += AVAudioFramePosition(mono.frameLength)
        offer(mono)
        report(mono)
    }

    private func fileConverter(from format: AVAudioFormat, into file: AVAudioFile) -> AVAudioConverter? {
        if let toFile, toFile.inputFormat == format { return toFile }
        toFile = AVAudioConverter(from: format, to: file.processingFormat)
        return toFile
    }

    private func offer(_ mono: AVAudioPCMBuffer) {
        if let toSpeech, let speech {
            if let sample = converted(mono, by: toSpeech) { speech.yield(AnalyzerInput(buffer: sample)) }
            return
        }
        guard waiting != nil else { return }
        if seconds > Setting.waitingSeconds {
            waiting = nil
            return
        }
        waiting?.append(mono)
    }

    private func report(_ mono: AVAudioPCMBuffer) {
        let now = Date()
        guard now.timeIntervalSince(noticed) >= Setting.levelInterval else { return }
        noticed = now
        notifier.send(["kind": "level", "seconds": seconds, "level": loudness(mono)])
    }

    private var seconds: Double {
        Double(frames) / Setting.sampleRate
    }

    private func hear() async {
        do {
            guard let heard = await listener(locale, live: true),
                  try await installed(heard.modules, notifier),
                  let source = file?.processingFormat,
                  let wanted = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: heard.modules, considering: source),
                  let converter = AVAudioConverter(from: source, to: wanted) else {
                abandon()
                return
            }
            let (inputs, continuation) = AsyncStream<AnalyzerInput>.makeStream()
            let analyzer = SpeechAnalyzer(modules: heard.modules)
            try await analyzer.start(inputSequence: inputs)
            guard attach(analyzer, converter, continuation, heard.texts) else {
                await analyzer.cancelAndFinishNow()
                return
            }
        } catch {
            abandon()
        }
    }

    private func attach(
        _ analyzer: SpeechAnalyzer,
        _ converter: AVAudioConverter,
        _ continuation: AsyncStream<AnalyzerInput>.Continuation,
        _ texts: AsyncThrowingStream<(String, Bool), Error>
    ) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let early = waiting else { return false }
        for mono in early {
            if let sample = converted(mono, by: converter) { continuation.yield(AnalyzerInput(buffer: sample)) }
        }
        waiting = nil
        self.analyzer = analyzer
        toSpeech = converter
        speech = continuation
        reading = Task { await self.read(texts) }
        return true
    }

    private func abandon() {
        lock.lock()
        waiting = nil
        lock.unlock()
    }

    private func read(_ texts: AsyncThrowingStream<(String, Bool), Error>) async {
        do {
            for try await (text, final) in texts {
                let (settled, pending) = transcript.accept(text, final: final)
                notifier.send(["kind": "text", "settled": settled, "pending": pending])
            }
        } catch {
            lock.withLock { analyzer = nil }
        }
    }

    func pause() {
        control.sync { hold() }
    }

    func resume() {
        control.sync { restart() }
    }

    private func hold() {
        let already = lock.withLock {
            let was = paused || closed
            paused = true
            return was
        }
        guard !already else { return }
        engine?.pause()
        notifier.send(["kind": "state", "state": "paused"])
    }

    private func restart() {
        guard !lock.withLock({ closed }) else { return }
        do {
            try listen()
            lock.withLock { paused = false }
            notifier.send(["kind": "state", "state": "recording"])
        } catch {
            lock.withLock { paused = true }
            notifier.send(["kind": "state", "state": "paused"])
        }
    }

    private func reconnect(_ changedEngine: ObjectIdentifier) {
        guard let engine, ObjectIdentifier(engine) == changedEngine else { return }
        reconnect(attempt: 0)
    }

    private func reconnect(attempt: Int) {
        guard !lock.withLock({ paused || closed }) else { return }
        do {
            try listen()
        } catch {
            guard attempt < Setting.reconnectAttempts else { return hold() }
            control.asyncAfter(deadline: .now() + Setting.reconnectDelay) { self.reconnect(attempt: attempt + 1) }
        }
    }

    private func close() -> (SpeechAnalyzer?, Task<Void, Never>?, Double) {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        control.sync {
            lock.withLock { closed = true }
            retire()
        }
        lock.lock()
        defer { lock.unlock() }
        paused = true
        file?.close()
        file = nil
        speech?.finish()
        speech = nil
        waiting = nil
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
        return (analyzer, reading, seconds)
    }

    func discard() async {
        let (analyzer, reading, _) = close()
        await analyzer?.cancelAndFinishNow()
        reading?.cancel()
        try? FileManager.default.removeItem(at: url)
    }

    func finish(_ wanted: Locale) async {
        let (analyzer, reading, seconds) = close()
        notifier.send(["kind": "state", "state": "finishing"])
        var text = await heardLive(analyzer, reading)
        if wanted.identifier != locale.identifier { text = nil }
        var reason = ""
        if text == nil {
            do {
                text = try await transcribed(url, wanted, notifier)
                if text == nil { reason = "unsupported" }
            } catch {
                reason = error.localizedDescription
            }
        }
        notifier.send([
            "kind": "done",
            "seconds": seconds,
            "text": text ?? "",
            "transcribed": text != nil,
            "reason": reason,
        ])
    }

    private func heardLive(_ analyzer: SpeechAnalyzer?, _ reading: Task<Void, Never>?) async -> String? {
        guard let analyzer, let reading else { return nil }
        do {
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        } catch {
            reading.cancel()
            return nil
        }
        await reading.value
        let complete = lock.withLock { self.analyzer != nil }
        return complete ? transcript.whole : nil
    }
}

private final class Desk: @unchecked Sendable {
    static let shared = Desk()
    private let lock = NSLock()
    private var session: Session?

    func replace(with made: Session) -> Session? {
        lock.lock()
        defer { lock.unlock() }
        let orphan = session
        session = made
        return orphan
    }

    func take(_ expected: Session) -> Session? {
        lock.lock()
        defer { lock.unlock() }
        guard session === expected else { return nil }
        session = nil
        return expected
    }

    var current: Session? {
        lock.lock()
        defer { lock.unlock() }
        return session
    }

    func take() -> Session? {
        lock.lock()
        defer { lock.unlock() }
        let taken = session
        session = nil
        return taken
    }
}

@_cdecl("kladde_audio_start")
public func audioStart(
    _ path: UnsafePointer<CChar>,
    _ language: UnsafePointer<CChar>,
    _ generation: UInt64,
    _ notice: AudioNotice
) -> Bool {
    let url = URL(fileURLWithPath: String(cString: path))
    let locale = Locale(identifier: String(cString: language))
    let notifier = Notifier(call: notice, generation: generation)
    let session = Session(url: url, locale: locale, notifier: notifier)
    let orphan = Desk.shared.replace(with: session)
    Task {
        await orphan?.discard()
        guard await AVAudioApplication.requestRecordPermission() else {
            if Desk.shared.take(session) != nil { notifier.fail("microphone") }
            return
        }
        do {
            try session.begin()
        } catch {
            guard let owned = Desk.shared.take(session) else { return }
            await owned.discard()
            notifier.fail("input")
        }
    }
    return true
}

@_cdecl("kladde_audio_pause")
public func audioPause() {
    Desk.shared.current?.pause()
}

@_cdecl("kladde_audio_resume")
public func audioResume() {
    Desk.shared.current?.resume()
}

@_cdecl("kladde_audio_stop")
public func audioStop(_ language: UnsafePointer<CChar>?) -> Bool {
    guard let session = Desk.shared.take() else { return false }
    let wanted = language.map { Locale(identifier: String(cString: $0)) }
    Task {
        if let wanted {
            await session.finish(wanted)
        } else {
            await session.discard()
        }
    }
    return true
}

@_cdecl("kladde_audio_transcribe")
public func audioTranscribe(_ path: UnsafePointer<CChar>, _ language: UnsafePointer<CChar>, _ notice: AudioNotice) {
    let url = URL(fileURLWithPath: String(cString: path))
    let locale = Locale(identifier: String(cString: language))
    let notifier = Notifier(call: notice)
    Task {
        do {
            let text = try await transcribed(url, locale, notifier)
            notifier.send([
                "kind": "done",
                "seconds": 0,
                "text": text ?? "",
                "transcribed": text != nil,
                "reason": text == nil ? "unsupported" : "",
            ])
        } catch {
            notifier.fail(error.localizedDescription)
        }
    }
}

@_cdecl("kladde_audio_languages")
public func audioLanguages(_ notice: AudioNotice) {
    let notifier = Notifier(call: notice)
    Task {
        let modern = SpeechTranscriber.isAvailable ? await SpeechTranscriber.supportedLocales : []
        let known = modern.isEmpty ? await DictationTranscriber.supportedLocales : modern
        let ids = Set(known.map { $0.identifier(.bcp47) }).sorted()
        notifier.send(["kind": "languages", "ids": ids])
    }
}
