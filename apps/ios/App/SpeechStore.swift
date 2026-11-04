import Foundation
import Combine
import LimeIoTKit

@MainActor final class SpeechStore: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var ready = false
    @Published private(set) var online = true
    @Published private(set) var message = ""
    @Published private(set) var capabilities: SpeechCapabilities?
    @Published private(set) var records: [SpeechRecord] = []
    @Published private(set) var text = ""
    @Published private(set) var voice = ""
    @Published private(set) var retainSeconds = 600
    @Published private(set) var confirmation: String?
    let space: String
    private let client: SpeechClient
    private let authFailure: (Error) -> Void
    private let onGenerated: (String) async -> Void
    private var active = true
    private var generation = 0
    private var work: Task<Void, Never>?
    init(client: SpeechClient, space: String, authFailure: @escaping (Error) -> Void, onGenerated: @escaping (String) async -> Void) {
        self.client = client; self.space = space; self.authFailure = authFailure; self.onGenerated = onGenerated
    }
    var pending: Bool { records.contains(where: \.pending) }
    var writable: Bool { active && online && ready && !busy }
    var canGenerate: Bool { writable && capabilities?.configured == true && !pending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.unicodeScalars.count <= 1000 && text.utf8.count <= 4096 && capabilities?.voices.contains(voice) == true }
    func setText(_ value: String) {
        guard writable, !pending else { return }
        guard value.utf8.count <= 8192 else { message = "请填写 1000 字以内的文本"; return }
        text = value
    }
    func prepareAnswer(_ value: String) -> Bool {
        guard writable, !pending, capabilities?.configured == true else { return false }
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, value.unicodeScalars.count <= 1000, value.utf8.count <= 4096 else { message = "回答超出语音长度限制，请保留文字回答"; return false }
        text = value; message = ""; return true
    }
    func selectVoice(_ value: String) { guard writable, !pending, capabilities?.voices.contains(value) == true else { return }; voice = value }
    func setRetention(_ value: Int) { guard writable, !pending, [600, 3600, 86400].contains(value) else { return }; retainSeconds = value }
    private func current(_ epoch: Int) throws { try Task.checkCancellation(); guard active, online, epoch == generation else { throw CancellationError() } }
    private func originals(_ epoch: Int) async throws { let next = try await client.records(space: space); try current(epoch); records = next }
    private func accept(_ record: SpeechRecord, epoch: Int, select: Bool) async throws {
        try current(epoch); try await originals(epoch)
        if select, let id = record.mediaId { await onGenerated(id); try current(epoch) }
    }
    private func run(_ action: @escaping @MainActor (Int) async throws -> Void) {
        guard active, online, !busy else { return }
        busy = true; message = ""; confirmation = nil; let epoch = generation
        work = Task {
            defer { if epoch == generation { busy = false; work = nil } }
            do { try current(epoch); try await action(epoch) }
            catch {
                guard epoch == generation, active, !(error is CancellationError) else { return }
                if let next = try? await client.records(space: space) { try? current(epoch); if epoch == generation { records = next } }
                guard epoch == generation, active else { return }
                ready = false; text = ""; confirmation = nil
                message = (error as? SpeechError)?.message ?? (error as? GatewayError)?.message ?? "结果未知，请查询原语音任务"
                if let error = error as? GatewayError, error == .unauthenticated { authFailure(error) }
            }
        }
    }
    func refresh() {
        run { epoch in
            self.ready = false; try await self.originals(epoch)
            let capability = try await self.client.capabilities(space: self.space); try self.current(epoch)
            self.capabilities = capability
            if !capability.voices.contains(self.voice) { self.voice = capability.voices.first ?? "" }
            for record in self.records where record.pending {
                do { let next = try await self.client.resolve(space: self.space, key: record.id); try await self.accept(next, epoch: epoch, select: true) }
                catch let error as SpeechError where error.code == "speech_unknown" { try self.current(epoch) }
            }
            try self.current(epoch); self.ready = true
        }
    }
    func generate() {
        guard canGenerate else { return }
        do {
            let input = try SpeechRequests.input(text: text, voice: voice, retainSeconds: retainSeconds)
            text = ""
            run { epoch in
                let record = try await self.client.submit(space: self.space, input: input); try await self.accept(record, epoch: epoch, select: true)
                self.message = record.statusText
            }
        } catch { message = (error as? SpeechError)?.message ?? "请检查语音输入" }
    }
    func recover(_ key: String) {
        guard records.contains(where: { $0.id == key && $0.rejectedCode == nil }) else { return }
        run { epoch in let record = try await self.client.resolve(space: self.space, key: key); try await self.accept(record, epoch: epoch, select: true); self.ready = true; self.message = record.statusText }
    }
    func poll() { guard ready, let record = records.first(where: { $0.status == "running" }) else { return }; recover(record.id) }
    func requestDiscard(_ key: String) { guard writable, records.contains(where: { $0.id == key && ["running", "unknown"].contains($0.status) }) else { return }; confirmation = key }
    func cancelDiscard() { confirmation = nil }
    func confirmDiscard() {
        guard writable, let key = confirmation else { return }
        run { epoch in let record = try await self.client.discard(space: self.space, key: key); try await self.accept(record, epoch: epoch, select: false); self.message = record.statusText }
    }
    func pause() { generation += 1; work?.cancel(); busy = false; ready = false; text = ""; confirmation = nil }
    func setOnline(_ value: Bool) { if !value { pause() }; online = value }
    func close() { pause(); active = false }
    func waitForIdle() async { await work?.value }
}
