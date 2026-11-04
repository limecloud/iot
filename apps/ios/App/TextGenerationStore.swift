import Foundation
import Combine
import LimeIoTKit

@MainActor final class TextGenerationStore: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var ready = false
    @Published private(set) var online = true
    @Published private(set) var message = ""
    @Published private(set) var prompt = ""
    @Published private(set) var capabilities: TextGenerationCapabilities?
    @Published private(set) var records: [TextGenerationRecord] = []
    @Published private(set) var outputs: [String: TextGenerationRecord] = [:]
    @Published private(set) var messages: [TextGenerationMessage] = []
    @Published private(set) var confirmation: String?
    let space: String
    private let client: TextGenerationClient, authFailure: (Error) -> Void, now: () -> Date
    private var contextExpiresAt: Date?
    private var turn: (key: String, messages: [TextGenerationMessage], expires: Date?)?
    private var active = true, generation = 0
    private var work: Task<Void, Never>?
    init(client: TextGenerationClient, space: String, authFailure: @escaping (Error) -> Void, now: @escaping () -> Date = Date.init) { self.client = client; self.space = space; self.authFailure = authFailure; self.now = now }
    var pending: Bool { records.contains(where: \.pending) }
    var writable: Bool { active && online && ready && !busy }
    var editable: Bool { writable && !pending }
    var canGenerate: Bool { editable && capabilities?.configured == true && (try? TextGenerationRequests.input(messages: currentMessages + [.init(role: "user", content: prompt)])) != nil }
    var clearingSuccess: Bool { records.contains { $0.id == confirmation && $0.status == "succeeded" } }
    private var currentMessages: [TextGenerationMessage] { contextExpiresAt.map { $0 <= now() } == true ? [] : messages }
    func setPrompt(_ value: String) { guard editable else { return }; prompt = value }
    func prepareQuestion(_ value: String) -> Bool {
        guard editable, capabilities?.configured == true else { return false }
        guard (try? TextGenerationRequests.input(messages: [.init(role: "user", content: value)])) != nil else { message = "识别文字不适合提问，请核对内容"; return false }
        startNew(); setPrompt(value); return true
    }
    private func clearConversation() { messages = []; contextExpiresAt = nil; turn = nil; prompt = "" }
    func startNew() { guard editable else { return }; clearConversation(); outputs = [:]; message = "" }
    private func showable(_ record: TextGenerationRecord) -> Bool { record.outputExpiresAt.map { $0 > now() } == true }
    func text(for key: String) -> String? { guard let record = outputs[key], showable(record) else { return nil }; return record.text }
    private func expireOutputs() {
        outputs = outputs.filter { showable($0.value) }
        if contextExpiresAt.map({ $0 <= now() }) == true { clearConversation(); outputs = [:] }
    }
    private func current(_ epoch: Int) throws { try Task.checkCancellation(); guard active, online, epoch == generation else { throw CancellationError() } }
    private func originals(_ epoch: Int) async throws { let next = try await client.records(space: space); try current(epoch); records = next }
    private func accept(_ record: TextGenerationRecord, epoch: Int, showText: Bool = true) async throws {
        try current(epoch); try await originals(epoch)
        if showText, let text = record.text, showable(record) {
            outputs[record.id] = record
            if let original = turn, original.key == record.id, let expires = record.outputExpiresAt {
                let end = min(original.expires ?? expires, expires)
                if end > now() { messages = original.messages + [.init(role: "assistant", content: text)]; contextExpiresAt = end }
                turn = nil
            }
        } else { outputs.removeValue(forKey: record.id) }
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
                ready = false; clearConversation(); outputs = [:]; confirmation = nil
                message = (error as? TextGenerationError)?.message ?? (error as? GatewayError)?.message ?? "结果未知，请查询原文字任务"
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
                catch let error as TextGenerationError where error.code == "text_unknown" { try self.current(epoch) }
            }
            self.expireOutputs(); try self.current(epoch); self.ready = true
        }
    }
    func generate() {
        expireOutputs(); guard canGenerate else { return }
        let context = currentMessages + [TextGenerationMessage(role: "user", content: prompt)], key = UUID().uuidString.lowercased()
        turn = (key, context, contextExpiresAt); prompt = ""
        run { epoch in
            let input = try TextGenerationRequests.input(messages: context); try self.current(epoch)
            let record = try await self.client.submit(space: self.space, input: input, key: key); try await self.accept(record, epoch: epoch); self.message = record.statusText
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
        clearConversation(); outputs = [:]
        run { epoch in let record = try await self.client.discard(space: self.space, key: key); try await self.accept(record, epoch: epoch); self.message = record.statusText }
    }
    func pause() { generation += 1; work?.cancel(); busy = false; ready = false; clearConversation(); outputs = [:]; confirmation = nil }
    func setOnline(_ value: Bool) { if !value { pause() }; online = value }
    func close() { pause(); active = false }
    func waitForIdle() async { await work?.value }
}
