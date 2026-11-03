import Foundation
import Combine
import LimeIoTKit

@MainActor final class VisionStore: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var ready = false
    @Published private(set) var online = true
    @Published private(set) var message = ""
    @Published private(set) var capabilities: VisionCapabilities?
    @Published private(set) var fileName = ""
    @Published private(set) var prompt = ""
    @Published private(set) var records: [VisionRecord] = []
    @Published private(set) var outputs: [String: VisionRecord] = [:]
    @Published private(set) var confirmation: String?
    let space: String
    private let client: VisionClient
    private let authFailure: (Error) -> Void
    private let now: () -> Date
    private var image: Data?, contentType = ""
    private var active = true, generation = 0
    private var work: Task<Void, Never>?
    init(client: VisionClient, space: String, authFailure: @escaping (Error) -> Void, now: @escaping () -> Date = Date.init) {
        self.client = client; self.space = space; self.authFailure = authFailure; self.now = now
    }
    var pending: Bool { records.contains(where: \.pending) }
    var writable: Bool { active && online && ready && !busy }
    var editable: Bool { writable && !pending }
    var canGenerate: Bool { editable && capabilities?.configured == true && image != nil && (try? VisionRequests.validatePrompt(prompt)) != nil }
    var clearingSuccess: Bool { records.contains { $0.id == confirmation && $0.status == "succeeded" } }
    func setPrompt(_ value: String) { guard editable else { return }; prompt = value }
    func selectFile(_ name: String, bytes: Data) {
        guard editable else { return }
        clearImage()
        do { contentType = try VisionRequests.contentType(of: bytes); image = bytes; fileName = String(name.prefix(128)); message = "" }
        catch { fileFailure(error) }
    }
    func fileFailure(_ error: Error) { guard active, online else { return }; clearImage(); message = "请选择不超过2 MiB、边长不超过1024像素的PNG或JPEG" }
    private func clearImage() { image = nil; contentType = ""; fileName = "" }
    private func clearInput() { clearImage(); prompt = "" }
    private func showable(_ record: VisionRecord) -> Bool { record.outputExpiresAt.map { $0 > now() } == true }
    func text(for key: String) -> String? { guard let record = outputs[key], showable(record) else { return nil }; return record.text }
    private func expireOutputs() { outputs = outputs.filter { showable($0.value) } }
    private func current(_ epoch: Int) throws { try Task.checkCancellation(); guard active, online, epoch == generation else { throw CancellationError() } }
    private func originals(_ epoch: Int) async throws { let next = try await client.records(space: space); try current(epoch); records = next }
    private func accept(_ record: VisionRecord, epoch: Int, showText: Bool = true) async throws {
        try current(epoch); try await originals(epoch)
        if showText, record.text != nil, showable(record) { outputs[record.id] = record } else { outputs.removeValue(forKey: record.id) }
        expireOutputs()
    }
    private func run(_ action: @escaping @MainActor (Int) async throws -> Void) {
        guard active, online, !busy else { return }
        busy = true; message = ""; confirmation = nil; let epoch = generation
        work = Task {
            defer { if epoch == generation { busy = false; work = nil } }
            do { try current(epoch); try await action(epoch) }
            catch {
                guard epoch == generation, active, !(error is CancellationError) else { return }
                if let next = try? await client.records(space: space), epoch == generation { records = next }
                guard epoch == generation, active else { return }
                ready = false; clearInput(); outputs = [:]; confirmation = nil
                message = (error as? VisionError)?.message ?? (error as? GatewayError)?.message ?? "结果未知，请查询原观察任务"
                if let error = error as? GatewayError, error == .unauthenticated { authFailure(error) }
            }
        }
    }
    func refresh() {
        run { epoch in
            self.ready = false; try await self.originals(epoch)
            let capability = try await self.client.capabilities(space: self.space); try self.current(epoch); self.capabilities = capability
            for record in self.records where record.pending {
                do { try await self.accept(self.client.resolve(space: self.space, key: record.id), epoch: epoch, showText: false) }
                catch let error as VisionError where error.code == "vision_unknown" { try self.current(epoch) }
            }
            self.expireOutputs(); try self.current(epoch); self.ready = true
        }
    }
    func generate() {
        guard canGenerate, let bytes = image else { return }
        let question = prompt, type = contentType
        clearInput()
        run { epoch in
            let input = try await Task.detached(priority: .userInitiated) { try VisionRequests.input(bytes: bytes, contentType: type, prompt: question) }.value
            try self.current(epoch)
            let record = try await self.client.submit(space: self.space, input: input); try await self.accept(record, epoch: epoch); self.message = record.statusText
        }
    }
    func recover(_ key: String) {
        guard records.contains(where: { $0.id == key && $0.rejectedCode == nil }) else { return }
        run { epoch in let record = try await self.client.resolve(space: self.space, key: key); try await self.accept(record, epoch: epoch); self.ready = true; self.message = record.statusText }
    }
    func poll() { expireOutputs(); guard ready, confirmation == nil, let record = records.first(where: { $0.status == "running" }) else { return }; recover(record.id) }
    func requestDiscard(_ key: String) { guard writable, records.contains(where: { $0.id == key && $0.canDiscard }) else { return }; confirmation = key }
    func cancelDiscard() { confirmation = nil }
    func confirmDiscard() {
        guard writable, let key = confirmation else { return }
        run { epoch in let record = try await self.client.discard(space: self.space, key: key); try await self.accept(record, epoch: epoch); self.message = record.statusText }
    }
    func pause() { generation += 1; work?.cancel(); busy = false; ready = false; clearInput(); outputs = [:]; confirmation = nil }
    func setOnline(_ value: Bool) { if !value { pause() }; online = value }
    func close() { pause(); active = false }
    func waitForIdle() async { await work?.value }
}
