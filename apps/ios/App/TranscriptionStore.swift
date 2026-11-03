import Foundation
import Combine
import LimeIoTKit

@MainActor final class TranscriptionStore: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var ready = false
    @Published private(set) var online = true
    @Published private(set) var message = ""
    @Published private(set) var capabilities: TranscriptionCapabilities?
    @Published private(set) var sources: [MediaItem] = []
    @Published private(set) var selectedMedia = ""
    @Published private(set) var language = "auto"
    @Published private(set) var records: [TranscriptionRecord] = []
    @Published private(set) var outputs: [String: TranscriptionRecord] = [:]
    @Published private(set) var confirmation: String?
    let space: String
    private let client: TranscriptionClient
    private let media: MediaClient
    private let authFailure: (Error) -> Void
    private var active = true, generation = 0
    private var work: Task<Void, Never>?
    init(client: TranscriptionClient, media: MediaClient, space: String, authFailure: @escaping (Error) -> Void) {
        self.client = client; self.media = media; self.space = space; self.authFailure = authFailure
    }
    var pending: Bool { records.contains(where: \.pending) }
    var writable: Bool { active && online && ready && !busy }
    private func available(_ item: MediaItem) -> Bool {
        let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fractional = format.date(from: item.expiresAt); format.formatOptions = [.withInternetDateTime]
        return item.available && (fractional ?? format.date(from: item.expiresAt) ?? .distantPast) > Date()
    }
    var canGenerate: Bool { writable && !pending && capabilities?.configured == true && sources.contains(where: { $0.id == selectedMedia && available($0) }) }
    func selectMedia(_ id: String) { guard writable, !pending else { return }; selectedMedia = sources.contains(where: { $0.id == id && available($0) }) ? id : "" }
    func selectLanguage(_ value: String) { guard writable, !pending, ["auto", "zh", "en"].contains(value) else { return }; language = value }
    private func showable(_ record: TranscriptionRecord) -> Bool {
        guard let expiry = record.outputExpiresAt, expiry > Date(), case .object(let original) = record.original, case .object(let input) = original["input"], case .string(let id) = input["media_id"] else { return false }
        return sources.contains(where: { $0.id == id && available($0) })
    }
    func text(for key: String) -> String? {
        guard let record = outputs[key], showable(record) else { return nil }
        return record.text
    }
    private func expireOutputs() { outputs = outputs.filter { showable($0.value) } }
    private func current(_ epoch: Int) throws { try Task.checkCancellation(); guard active, online, epoch == generation else { throw CancellationError() } }
    private func originals(_ epoch: Int) async throws { let next = try await client.records(space: space); try current(epoch); records = next }
    private func accept(_ record: TranscriptionRecord, epoch: Int) async throws {
        try current(epoch); try await originals(epoch)
        if record.text != nil, showable(record) { outputs[record.id] = record } else { outputs.removeValue(forKey: record.id) }
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
                ready = false; outputs = [:]; confirmation = nil
                message = (error as? TranscriptionError)?.message ?? (error as? GatewayError)?.message ?? "结果未知，请查询原识别任务"
                if let error = error as? GatewayError, error == .unauthenticated { authFailure(error) }
            }
        }
    }
    func refresh() {
        run { epoch in
            self.ready = false; try await self.originals(epoch)
            let capability = try await self.client.capabilities(space: self.space); try self.current(epoch); self.capabilities = capability
            let page = try await self.media.list(space: self.space); try self.current(epoch)
            self.sources = page.items.filter(self.available)
            if !self.sources.contains(where: { $0.id == self.selectedMedia }) { self.selectedMedia = "" }
            self.outputs = self.outputs.filter { entry in
                guard case .object(let original) = entry.value.original, case .object(let input) = original["input"], case .string(let id) = input["media_id"] else { return false }
                return self.sources.contains(where: { $0.id == id })
            }
            for record in self.records where record.pending {
                do { try await self.accept(self.client.resolve(space: self.space, key: record.id), epoch: epoch) }
                catch let error as TranscriptionError where error.code == "transcription_unknown" { try self.current(epoch) }
            }
            self.expireOutputs(); try self.current(epoch); self.ready = true
        }
    }
    func generate() {
        guard canGenerate, let source = sources.first(where: { $0.id == selectedMedia }), case .object(let metadata) = source.metadata, case .string(let digest) = metadata["content_digest"] else { return }
        do {
            let input = try TranscriptionRequests.input(mediaId: source.id, mediaDigest: digest, language: language)
            run { epoch in let record = try await self.client.submit(space: self.space, input: input); try await self.accept(record, epoch: epoch); self.message = record.statusText }
        } catch { message = (error as? TranscriptionError)?.message ?? "请检查识别输入" }
    }
    func recover(_ key: String) {
        guard records.contains(where: { $0.id == key && $0.rejectedCode == nil }) else { return }
        run { epoch in let record = try await self.client.resolve(space: self.space, key: key); try await self.accept(record, epoch: epoch); self.ready = true; self.message = record.statusText }
    }
    func poll() { expireOutputs(); guard ready, let record = records.first(where: { $0.status == "running" }) else { return }; recover(record.id) }
    func requestDiscard(_ key: String) { guard writable, records.contains(where: { $0.id == key && ["running", "unknown"].contains($0.status) }) else { return }; confirmation = key }
    func cancelDiscard() { confirmation = nil }
    func confirmDiscard() {
        guard writable, let key = confirmation else { return }
        run { epoch in let record = try await self.client.discard(space: self.space, key: key); try await self.accept(record, epoch: epoch); self.message = record.statusText }
    }
    func pause() { generation += 1; work?.cancel(); busy = false; ready = false; outputs = [:]; sources = []; selectedMedia = ""; confirmation = nil }
    func setOnline(_ value: Bool) { if !value { pause() }; online = value }
    func close() { pause(); active = false }
    func waitForIdle() async { await work?.value }
}
