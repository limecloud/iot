import Foundation
import Combine
import LimeIoTKit

@MainActor protocol RecordingInput: AnyObject {
    func start(samples: @escaping @Sendable ([Int16]) -> Void, interrupted: @escaping @Sendable () -> Void) throws
    func close()
}

// 音频回调同步写入有界缓冲，只在结束或失败时调度一次主线程任务。
private final class RecordingBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var values = [Int16](repeating: 0, count: PcmRecording.maxFrames)
    private var count = 0
    private var ended = false
    func append(_ chunk: [Int16]) -> Int {
        lock.lock(); defer { lock.unlock() }
        guard !ended else { return 0 }
        guard !chunk.isEmpty, chunk.count <= 4096 else { ended = true; return -1 }
        let size = min(chunk.count, PcmRecording.maxFrames - count)
        values.replaceSubrange(count..<(count + size), with: chunk.prefix(size)); count += size
        if count == PcmRecording.maxFrames { ended = true; return 1 }; return 0
    }
    var seconds: Int { lock.lock(); defer { lock.unlock() }; return count / PcmRecording.sampleRate }
    func take() -> [Int16] {
        lock.lock(); defer { lock.unlock() }
        ended = true; let result = Array(values.prefix(count))
        values.withUnsafeMutableBufferPointer { $0.update(repeating: 0) }; values.removeAll(); count = 0
        return result
    }
    func clear() { lock.lock(); defer { lock.unlock() }; ended = true; values.withUnsafeMutableBufferPointer { $0.update(repeating: 0) }; values.removeAll(); count = 0 }
}

@MainActor final class RecordingStore: ObservableObject {
    enum Phase { case idle, requesting, starting, recording, finishing }
    @Published private(set) var phase = Phase.idle
    @Published private(set) var seconds = 0
    @Published private(set) var message = ""
    var busy: Bool { phase != .idle }
    private var available = false
    private var active = true
    private var generation = UUID()
    private var input: (any RecordingInput)?
    private var buffer: RecordingBuffer?
    private var deadline: Task<Void, Never>?
    private var ticker: Task<Void, Never>?
    private let factory: () throws -> any RecordingInput
    private let completed: (Data) -> Bool
    private let cleared: () -> Void
    private let wait: @Sendable (Duration) async throws -> Void
    init(factory: @escaping () throws -> any RecordingInput, completed: @escaping (Data) -> Bool, cleared: @escaping () -> Void,
         wait: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.factory = factory; self.completed = completed; self.cleared = cleared; self.wait = wait
    }
    private func current(_ epoch: UUID) -> Bool { active && available && epoch == generation }
    func setAvailable(_ value: Bool) { available = value; if !value { cancel() } }
    func request() -> UUID? {
        guard active, available, !busy else { return nil }
        generation = UUID(); let epoch = generation; phase = .requesting; seconds = 0; message = ""; cleared()
        deadline = Task { [weak self, wait] in
            do { try await wait(.seconds(30)); try Task.checkCancellation(); self?.fail(epoch, "等待麦克风授权超时，请重新开始") } catch {}
        }
        return epoch
    }
    func authorize(_ epoch: UUID, granted: Bool) {
        guard current(epoch), phase == .requesting else { return }
        guard granted else { fail(epoch, "未获得麦克风权限，可在系统设置中允许"); return }
        phase = .starting
        do {
            let source = try factory()
            guard current(epoch), phase == .starting else { source.close(); return }
            let capture = RecordingBuffer(); input = source; buffer = capture; phase = .recording
            try source.start(samples: { [weak self] samples in
                let result = capture.append(samples)
                if result != 0 { Task { @MainActor [weak self] in
                    guard let self, self.current(epoch), self.phase == .recording else { return }
                    if result > 0 { self.finish() } else { self.fail(epoch, "录音已中断，请重新开始") }
                } }
            }, interrupted: { [weak self] in Task { @MainActor [weak self] in
                guard let self, self.current(epoch), self.phase == .recording else { return }; self.fail(epoch, "录音已中断，请重新开始")
            } })
            guard current(epoch), phase == .recording else { return }
            deadline?.cancel()
            deadline = Task { [weak self, wait] in
                do { try await wait(.seconds(PcmRecording.maxSeconds)); try Task.checkCancellation(); if self?.current(epoch) == true { self?.finish() } } catch {}
            }
            ticker = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(1)); try Task.checkCancellation() } catch { return }
                    guard let self, self.current(epoch), self.phase == .recording else { return }; self.seconds = capture.seconds
                }
            }
        } catch { fail(epoch, "麦克风不可用，请检查设备") }
    }
    func finish() {
        guard current(generation), phase == .recording, let buffer else { return }
        let epoch = generation; phase = .finishing; deadline?.cancel(); deadline = nil; ticker?.cancel(); ticker = nil
        input?.close(); input = nil; var samples = buffer.take(); self.buffer = nil
        defer { samples.withUnsafeMutableBufferPointer { $0.update(repeating: 0) } }
        do {
            var bytes = try PcmRecording.encode(samples); defer { bytes.resetBytes(in: 0..<bytes.count) }
            guard current(epoch) else { return }
            guard completed(bytes) else { fail(epoch, "无法保留录音，请重新开始"); return }
            if current(epoch) { generation = UUID(); phase = .idle; seconds = 0 }
        } catch { fail(epoch, "未能保存录音，请重新开始") }
    }
    private func fail(_ epoch: UUID, _ value: String) { guard current(epoch) else { return }; cancel(); if active && available { message = value } }
    func cancel() {
        generation = UUID(); deadline?.cancel(); deadline = nil; ticker?.cancel(); ticker = nil
        input?.close(); input = nil; buffer?.clear(); buffer = nil; phase = .idle; seconds = 0; message = ""; cleared()
    }
    func close() { active = false; available = false; cancel() }
}
