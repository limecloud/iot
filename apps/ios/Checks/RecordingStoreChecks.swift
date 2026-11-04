import Foundation
import AVFoundation
import LimeIoTKit

private enum RecordingCheckError: Error { case check(String) }
@MainActor private func expect(_ value: Bool, _ name: String) throws { if !value { throw RecordingCheckError.check(name) } }
@MainActor private final class CaptureInput: RecordingInput {
    var starts = 0, closes = 0
    var samples: (@Sendable ([Int16]) -> Void)?
    var interrupted: (@Sendable () -> Void)?
    func start(samples: @escaping @Sendable ([Int16]) -> Void, interrupted: @escaping @Sendable () -> Void) { starts += 1; self.samples = samples; self.interrupted = interrupted }
    func close() { closes += 1 }
    func push(_ count: Int) { samples?([Int16](repeating: 321, count: count)) }
}
private actor Deadlines {
    var entries: [(Duration, CheckedContinuation<Void, any Error>)] = []
    func sleep(_ duration: Duration) async throws { try await withCheckedThrowingContinuation { entries.append((duration, $0)) } }
    func fire(_ duration: Duration? = nil) { let matches = entries.filter { duration == nil || $0.0 == duration }; entries.removeAll { duration == nil || $0.0 == duration }; for entry in matches { entry.1.resume() } }
    func contains(_ duration: Duration) -> Bool { entries.contains { $0.0 == duration } }
}

@main struct RecordingStoreChecks {
    @MainActor static func settle(_ condition: () -> Bool) async throws {
        for _ in 0..<200 { if condition() { return }; try await Task.sleep(for: .milliseconds(5)) }
        try expect(condition(), "state settled")
    }
    @MainActor static func main() async throws {
        if ProcessInfo.processInfo.environment["LIMEIOT_RECORDING_NATIVE_PHASE"] != nil { try await recordingLiveChecks(); return }
        let env = ProcessInfo.processInfo.environment
        let values: [Int16] = [-32768, -1, 0, 1, 32767], encoded = try PcmRecording.encode(values)
        let output = URL(fileURLWithPath: env["LIMEIOT_RECORDING_PCM_OUTPUT"] ?? ".dev/recording-native/swift-recording.wav")
        try encoded.write(to: output)
        let file = try AVAudioFile(forReading: output, commonFormat: .pcmFormatInt16, interleaved: false)
        let pcm = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 5)!
        try file.read(into: pcm)
        try expect(file.processingFormat.sampleRate == 16000 && file.processingFormat.channelCount == 1 && file.length == 5 && Array(UnsafeBufferPointer(start: pcm.int16ChannelData![0], count: 5)) == values, "independent AVFoundation decoder")
        try expect(try PcmRecording.encode([Int16](repeating: 0, count: PcmRecording.maxFrames)).count == PcmRecording.maxBytes, "exact maximum WAV")
        for value in [[Int16](), [Int16](repeating: 0, count: PcmRecording.maxFrames + 1)] {
            do { _ = try PcmRecording.encode(value); throw RecordingCheckError.check("invalid frames accepted") } catch is MediaError {}
        }
        var outputs: [Data] = [], opened = 0, clears = 0
        let input = CaptureInput()
        let store = RecordingStore(factory: { opened += 1; return input }, completed: { outputs.append($0); return true }, cleared: { clears += 1 })
        try expect(store.request() == nil, "initially unavailable"); store.setAvailable(true)
        let cancelled = store.request()!; store.cancel(); store.authorize(cancelled, granted: true)
        let denied = store.request()!; store.authorize(denied, granted: false)
        try expect(opened == 0 && store.message.contains("权限"), "cancelled and denied grants do not create input")
        store.authorize(store.request()!, granted: true); input.push(1600)
        try expect(outputs.isEmpty, "no implicit completion")
        store.finish(); input.push(1024); input.interrupted?(); await Task.yield()
        try expect(outputs.count == 1 && outputs[0].count == 3244 && input.closes == 1 && store.phase == .idle, "single completion and late callbacks rejected")
        store.authorize(store.request()!, granted: true); input.push(1600); store.setAvailable(false); input.push(1600); input.interrupted?(); await Task.yield()
        try expect(outputs.count == 1 && input.closes == 2 && store.request() == nil && clears >= 3, "offline clears input and prevents revival")
        store.close(); store.setAvailable(true); try expect(store.request() == nil, "closed store stays closed")
        let late = CaptureInput(); var opening: RecordingStore!
        opening = RecordingStore(factory: { opening.cancel(); return late }, completed: { _ in false }, cleared: {})
        opening.setAvailable(true); opening.authorize(opening.request()!, granted: true)
        try expect(late.starts == 0 && late.closes == 1, "cancelled opening closes late input"); opening.close()
        let limitInput = CaptureInput(); var limitOutputs: [Data] = []
        let limited = RecordingStore(factory: { limitInput }, completed: { limitOutputs.append($0); return true }, cleared: {})
        limited.setAvailable(true); limited.authorize(limited.request()!, granted: true)
        var remaining = PcmRecording.maxFrames
        while remaining > 0 { let count = min(4096, remaining); limitInput.push(count); remaining -= count }
        limitInput.push(4096); try await settle { !limited.busy }
        try expect(limitOutputs.count == 1 && limitOutputs[0].count == PcmRecording.maxBytes && limitInput.closes == 1, "exact 960000-frame limit")
        limited.close()
        let clock = Deadlines(), timedInput = CaptureInput(); var timedOutputs: [Data] = []
        let timed = RecordingStore(factory: { timedInput }, completed: { timedOutputs.append($0); return true }, cleared: {}, wait: { try await clock.sleep($0) })
        timed.setAvailable(true); let expired = timed.request()!
        for _ in 0..<200 { if await clock.contains(.seconds(30)) { break }; await Task.yield() }
        try expect(await clock.contains(.seconds(30)), "original 30-second permission deadline")
        await clock.fire(.seconds(30)); try await settle { !timed.busy }; timed.authorize(expired, granted: true)
        try expect(timedInput.starts == 0 && timed.message.contains("超时"), "expired grant cannot reopen")
        timed.authorize(timed.request()!, granted: true); timedInput.push(1600)
        for _ in 0..<200 { if await clock.contains(.seconds(60)) { break }; await Task.yield() }
        try expect(await clock.contains(.seconds(60)), "original 60-second recording deadline")
        await clock.fire(.seconds(60)); try await settle { !timed.busy }
        try expect(timedOutputs.count == 1 && timedOutputs[0].count == 3244 && timedInput.closes == 1, "deadline closes without padding")
        timed.close(); await clock.fire()
        let broken = CaptureInput(); var rejected = 0
        let failing = RecordingStore(factory: { broken }, completed: { _ in rejected += 1; return false }, cleared: {})
        failing.setAvailable(true); failing.authorize(failing.request()!, granted: true); broken.interrupted?(); try await settle { !failing.busy }
        try expect(rejected == 0 && broken.closes == 1 && failing.message.contains("中断"), "interruption clears capture")
        failing.authorize(failing.request()!, granted: true); broken.push(4097); try await settle { !failing.busy }
        try expect(rejected == 0 && broken.closes == 2, "oversized callback rejected")
        failing.authorize(failing.request()!, granted: true); broken.push(1600); failing.finish()
        try expect(rejected == 1 && broken.closes == 3 && failing.message.contains("无法保留"), "rejected selection ends cleanly"); failing.close()
        print("{\"recording_contract_groups\":8,\"independent_avfoundation_decode\":true,\"system_microphone_opened\":false}")
    }
}
