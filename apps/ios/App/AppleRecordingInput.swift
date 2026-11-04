import Foundation
@preconcurrency import AVFoundation
import LimeIoTKit

private enum RecordingInputError: Error { case unavailable, permission }
private final class RecordingConverterSource: @unchecked Sendable {
    private let lock = NSLock()
    private let buffer: AVAudioPCMBuffer
    private var supplied = false
    init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
    func take(_ state: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
        lock.lock(); defer { lock.unlock() }
        guard !supplied else { state.pointee = .noDataNow; return nil }
        supplied = true; state.pointee = .haveData; return buffer
    }
}

@MainActor final class AppleRecordingInput: RecordingInput {
    private let engine = AVAudioEngine()
    private var observers: [NSObjectProtocol] = []
    private var tapped = false
    private var closed = false
    private var sessionActive = false
    static func requestPermission() async -> Bool {
        #if os(iOS)
        return await AVAudioApplication.requestRecordPermission()
        #else
        return await AVCaptureDevice.requestAccess(for: .audio)
        #endif
    }
    func start(samples: @escaping @Sendable ([Int16]) -> Void, interrupted: @escaping @Sendable () -> Void) throws {
        guard !closed, !tapped else { throw RecordingInputError.unavailable }
        #if os(iOS)
        guard AVAudioApplication.shared.recordPermission == .granted else { throw RecordingInputError.permission }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement); try session.setActive(true); sessionActive = true
        #else
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { throw RecordingInputError.permission }
        #endif
        let node = engine.inputNode, format = node.outputFormat(forBus: 0)
        guard format.sampleRate >= 8000, format.channelCount > 0,
              let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(PcmRecording.sampleRate), channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: format, to: output) else { throw RecordingInputError.unavailable }
        node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            let capacity = Int(ceil(Double(buffer.frameLength) * output.sampleRate / format.sampleRate)) + 32
            guard capacity > 0, capacity <= 4096, let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: AVAudioFrameCount(capacity)) else { interrupted(); return }
            let source = RecordingConverterSource(buffer); var error: NSError?
            let status = converter.convert(to: converted, error: &error) { _, state in source.take(state) }
            guard error == nil, status != .error else { interrupted(); return }
            if converted.frameLength > 0, let channel = converted.int16ChannelData?[0] {
                samples(Array(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength))))
                channel.update(repeating: 0, count: Int(converted.frameLength))
            }
        }
        tapped = true
        var names: [Notification.Name] = [.AVAudioEngineConfigurationChange]
        #if os(iOS)
        names += [AVAudioSession.interruptionNotification, AVAudioSession.routeChangeNotification]
        #endif
        for name in names { observers.append(NotificationCenter.default.addObserver(forName: name, object: name == .AVAudioEngineConfigurationChange ? engine : nil, queue: .main) { _ in interrupted() }) }
        engine.prepare(); try engine.start()
    }
    func close() {
        guard !closed else { return }; closed = true
        for observer in observers { NotificationCenter.default.removeObserver(observer) }; observers.removeAll()
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }; engine.stop(); engine.reset()
        #if os(iOS)
        if sessionActive { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation); sessionActive = false }
        #endif
    }
}
