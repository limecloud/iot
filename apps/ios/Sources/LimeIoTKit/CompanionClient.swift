import Foundation

private actor CompanionPersistenceGate {
    static let shared = CompanionPersistenceGate()
    private var busy = false
    func begin() throws { guard !busy else { throw CompanionError(code: "companion_busy") }; busy = true }
    func end() { busy = false }
}
private struct CompanionTurnStore: SessionStore {
    let read: @Sendable () async throws -> Data?
    let write: @Sendable (Data?) async throws -> Void
    func load(origin: String) async throws -> Data? { try await read() }
    func save(origin: String, data: Data?) async throws { try await write(data) }
}

// 外层保存会话预算和摘要；每个原回合仍由VoiceTurnClient负责，正文只驻留内存。
public actor CompanionClient {
    private let gateway: GatewayClient, store: any SessionStore, space: String, now: @Sendable () -> Date
    private var policy: CompanionPolicy?, history: [TextGenerationMessage]?
    private var previous: Data?, unconfirmedWrite: Data?
    private var loaded = false, busy = false
    private var storageKey: String { gateway.origin + "#companion:" + space }
    public init(gateway: GatewayClient, store: any SessionStore, space: String, policy: CompanionPolicy? = nil, history: [TextGenerationMessage]? = nil, now: @escaping @Sendable () -> Date = Date.init) throws {
        try CompanionJSON.match(.string(space), #"[A-Za-z0-9_-]{1,128}"#)
        self.gateway = gateway; self.store = store; self.space = space; self.policy = policy; self.history = history; self.now = now
    }
    public func forgetContext() { policy = nil; history = nil }
    private func locked<T: Sendable>(_ work: () async throws -> T) async throws -> T {
        guard !busy else { throw CompanionError(code: "companion_busy") }; busy = true; defer { busy = false }
        try await CompanionPersistenceGate.shared.begin()
        do { try Task.checkCancellation(); let result = try await work(); await CompanionPersistenceGate.shared.end(); return result }
        catch { await CompanionPersistenceGate.shared.end(); throw error }
    }
    private func load() async throws -> CompanionRecord? {
        try Task.checkCancellation(); let data = try await store.load(origin: storageKey); try Task.checkCancellation()
        guard !loaded || data == previous || unconfirmedWrite != nil && data == unconfirmedWrite else { throw CompanionError(code: "companion_record_unavailable") }
        let record = try data.map { try CompanionRecord.parse(String(decoding: $0, as: UTF8.self), origin: gateway.origin, space: space) }
        previous = data; unconfirmedWrite = nil; loaded = true; return record
    }
    private func requireRecord() async throws -> CompanionRecord {
        guard let record = try await load() else { throw CompanionError(code: "companion_not_found") }; return record
    }
    private func save(_ value: JSONValue) async throws -> CompanionRecord {
        try Task.checkCancellation()
        var body = try MediaJSON.object(value); body.removeValue(forKey: "checksum"); body["checksum"] = .string(IntegerJSON.digest(.object(body)))
        let text = IntegerJSON.canonical(.object(body)), next = try CompanionRecord.parse(text, origin: gateway.origin, space: space), data = Data(text.utf8)
        do {
            guard try await store.load(origin: storageKey) == previous else { throw CompanionError(code: "companion_record_unavailable") }
            try Task.checkCancellation(); unconfirmedWrite = data; try await store.save(origin: storageKey, data: data); try Task.checkCancellation()
            guard try await store.load(origin: storageKey) == data else { throw CompanionError(code: "companion_record_unavailable") }
            try Task.checkCancellation()
        } catch is CancellationError { throw CancellationError() }
        catch { throw CompanionError(code: "companion_record_unavailable") }
        previous = data; unconfirmedWrite = nil; loaded = true; return next
    }
    public func record() async throws -> CompanionRecord? { try await locked { try await load() } }
    public func capabilities() async throws -> VoiceTurnCapabilities {
        try await VoiceTurnClient(gateway: gateway, store: store, space: space, now: now).capabilities()
    }
    private func historyAvailable(_ record: CompanionRecord) -> Bool {
        guard let history else { return false }
        let summary = MediaJSON.member(record.document, "history")
        return MediaJSON.member(summary, "message_count") == .integer(history.count) && MediaJSON.member(summary, "digest") == .string(IntegerJSON.digest(.array(history.map(\.document))))
    }
    private func deployments() async throws -> JSONValue {
        let capabilities = try await capabilities()
        guard let policy, capabilities.configured, capabilities.speech.voices.contains(policy.voice) else { throw CompanionError(code: "companion_not_configured") }
        return .object(Dictionary(uniqueKeysWithValues: VoiceTurnJSON.kinds.map { ($0, capabilities.revision($0)) }))
    }
    private func requireLive(_ record: CompanionRecord) async throws -> VoiceTextContext {
        if record.stopped { throw CompanionError(code: "companion_stopped") }
        if try now() >= record.expiresAt { throw CompanionError(code: "companion_expired") }
        let body = record.document
        guard let policy, MediaJSON.member(body, "policy_digest") == .string(IntegerJSON.digest(policy.document)), MediaJSON.member(body, "max_turns") == .integer(policy.maxTurns),
              try (record.expiresAt.timeIntervalSince1970 * 1000).rounded() - (VoiceTurnJSON.time(MediaJSON.member(body, "created_at")).timeIntervalSince1970 * 1000).rounded() == Double(policy.maxSeconds * 1000) else { throw CompanionError(code: "companion_policy_changed") }
        guard historyAvailable(record), let history else { throw CompanionError(code: "companion_history_unavailable") }
        guard try await deployments() == MediaJSON.member(body, "deployments") else { throw CompanionError(code: "companion_configuration_changed") }
        return try VoiceTextContext(instructions: policy.instructions, history: history)
    }
    private func slot(_ sessionID: String, _ index: Int, _ turnID: String) async throws -> (CompanionRecord, JSONValue) {
        let current = try await requireRecord(), turns = CompanionJSON.turns(current.document)
        guard current.id == sessionID, turns.indices.contains(index), MediaJSON.member(turns[index], "turn_id") == .string(turnID) else { throw CompanionError(code: "companion_record_unavailable") }
        return (current, turns[index])
    }
    private func nestedLoad(_ sessionID: String, _ index: Int, _ turnID: String) async throws -> Data? {
        let (_, slot) = try await slot(sessionID, index, turnID), value = MediaJSON.member(slot, "record")
        return value == .null ? nil : Data(IntegerJSON.canonical(value).utf8)
    }
    private func nestedSave(_ sessionID: String, _ index: Int, _ turnID: String, data: Data?) async throws {
        let (current, slot) = try await slot(sessionID, index, turnID)
        guard let data else { throw CompanionError(code: "companion_record_unavailable") }
        let turn = try VoiceTurnRecord.parse(String(decoding: data, as: UTF8.self), origin: gateway.origin, space: space, contextual: true)
        guard !current.stopped || turn.stopped else { throw CompanionError(code: "companion_record_unavailable") }
        var turns = CompanionJSON.turns(current.document), next = try MediaJSON.object(slot), body = try MediaJSON.object(current.document)
        next["record"] = turn.document; turns[index] = .object(next); body["turns"] = .array(turns)
        _ = try await save(.object(body))
    }
    private func voice(_ record: CompanionRecord, _ index: Int, context: VoiceTextContext? = nil) throws -> VoiceTurnClient {
        let sessionID = record.id, turnID = MediaJSON.string(CompanionJSON.turns(record.document)[index], "turn_id")
        let nested = CompanionTurnStore(read: { try await self.nestedLoad(sessionID, index, turnID) }, write: { try await self.nestedSave(sessionID, index, turnID, data: $0) })
        return try VoiceTurnClient(gateway: gateway, store: nested, space: space, contextual: true, textContext: context, deadline: record.expiresAt, now: now)
    }
    private func view(_ record: CompanionRecord, turn: VoiceTurnView? = nil) throws -> CompanionView {
        let available = historyAvailable(record), turns = CompanionJSON.turns(record.document), last = turns.last, expired = try now() >= record.expiresAt
        let phase = record.stopped ? "stopped" : expired ? "expired" : turn?.phase ?? (last.map { MediaJSON.member($0, "record") == .null ? "prepared" : MediaJSON.member($0, "completed") == .bool(true) ? "succeeded" : "paused" } ?? "ready")
        let max = try MediaJSON.integer(MediaJSON.member(record.document, "max_turns"), 1, 8)
        return CompanionView(record: record, phase: phase, historyAvailable: available, turnsRemaining: max - turns.count,
            canReply: !record.stopped && !expired && available && policy.map { .string(IntegerJSON.digest($0.document)) == MediaJSON.member(record.document, "policy_digest") } == true && (last == nil || MediaJSON.member(last!, "completed") == .bool(true)) && turns.count < max,
            stopSettled: record.stopped && CompanionJSON.settled(record), turn: ["stopped", "expired"].contains(phase) ? nil : turn)
    }
    private func finish(_ turn: VoiceTurnView) async throws -> CompanionView {
        var record = try await requireRecord(), turns = CompanionJSON.turns(record.document)
        guard let slot = turns.last, turn.record.id == MediaJSON.string(slot, "turn_id"), turn.record.document == MediaJSON.member(slot, "record") else { throw CompanionError(code: "companion_record_unavailable") }
        if !record.stopped, try now() < record.expiresAt, turn.phase == "succeeded", MediaJSON.member(slot, "completed") != .bool(true), let transcript = turn.transcript, let answer = turn.answer, historyAvailable(record), let history {
            let nextHistory = history + [.init(role: "user", content: transcript), .init(role: "assistant", content: answer)]
            var next = try MediaJSON.object(slot), body = try MediaJSON.object(record.document)
            next["completed"] = .bool(true); turns[turns.count - 1] = .object(next); body["turns"] = .array(turns)
            body["history"] = .object(["digest": .string(IntegerJSON.digest(.array(nextHistory.map(\.document)))), "message_count": .integer(nextHistory.count)])
            record = try await save(.object(body)); self.history = nextHistory
        }
        return try view(record, turn: turn)
    }
    public func start(sessionID: String, policy: CompanionPolicy? = nil) async throws -> CompanionView {
        try await locked {
            if let policy { self.policy = policy }
            do { try CompanionJSON.match(.string(sessionID), #"[A-Za-z0-9_-]{1,64}"#) } catch { throw CompanionError(code: "invalid_companion_request") }
            guard let policy = self.policy else { throw CompanionError(code: "invalid_companion_request") }
            let previous = try await load()
            if let previous, !previous.stopped || !CompanionJSON.settled(previous) { throw CompanionError(code: "companion_session_pending") }
            var ids: [JSONValue] = []; if let previous { if case .array(let old) = MediaJSON.member(previous.document, "previous_ids") { ids = old }; ids.append(.string(previous.id)) }
            guard !ids.contains(.string(sessionID)), ids.count <= 256 else { throw CompanionError(code: "companion_session_id_unavailable") }
            let deployments = try await deployments(), created = now()
            let record = try await save(.object(["version": .integer(1), "origin": .string(gateway.origin), "space_id": .string(space), "session_id": .string(sessionID), "previous_ids": .array(ids), "policy_digest": .string(IntegerJSON.digest(policy.document)), "deployments": deployments,
                "created_at": .string(SpeechJSON.timestamp(created)), "expires_at": .string(SpeechJSON.timestamp(created.addingTimeInterval(Double(policy.maxSeconds)))), "max_turns": .integer(policy.maxTurns), "stopped": .bool(false), "history": .object(["digest": .string(IntegerJSON.digest(.array([]))), "message_count": .integer(0)]), "turns": .array([])]))
            history = []; return try view(record)
        }
    }
    public func reply(mediaID: String) async throws -> CompanionView {
        try await locked {
            var record = try await requireRecord(); let context = try await requireLive(record); var turns = CompanionJSON.turns(record.document)
            if let last = turns.last, MediaJSON.member(last, "completed") != .bool(true) { throw CompanionError(code: "companion_turn_pending") }
            guard let policy else { throw CompanionError(code: "companion_policy_changed") }
            guard turns.count < policy.maxTurns else { throw CompanionError(code: "companion_turn_budget_exceeded") }
            do { try CompanionJSON.match(.string(mediaID), #"media-[A-Za-z0-9_-]{1,122}"#) } catch { throw CompanionError(code: "invalid_companion_request") }
            let index = turns.count, turnID = record.id + "_t\(index + 1)"
            turns.append(.object(["turn_id": .string(turnID), "media_id": .string(mediaID), "context_digest": .string(IntegerJSON.digest(context.document)), "completed": .bool(false), "record": .null]))
            var body = try MediaJSON.object(record.document); body["turns"] = .array(turns); record = try await save(.object(body))
            return try await finish(voice(record, index, context: context).start(input: VoiceTurnRequests.input(turnID: turnID, mediaID: mediaID, language: policy.language, voice: policy.voice)))
        }
    }
    public func resolve() async throws -> CompanionView {
        try await locked {
            let record = try await requireRecord(), turns = CompanionJSON.turns(record.document)
            guard let last = turns.last, MediaJSON.member(last, "record") != .null else { return try view(record) }
            return try await finish(voice(record, turns.count - 1).resolve())
        }
    }
    public func continueSession() async throws -> CompanionView {
        try await locked {
            let record = try await requireRecord(), context = try await requireLive(record), turns = CompanionJSON.turns(record.document)
            guard let last = turns.last, MediaJSON.member(last, "record") != .null else { throw CompanionError(code: "companion_preparation_incomplete") }
            let client = try voice(record, turns.count - 1, context: context)
            return try await finish(MediaJSON.member(last, "completed") == .bool(true) ? client.resolve() : client.continueTurn())
        }
    }
    public func stop() async throws -> CompanionView {
        try await locked {
            history = nil; policy = nil
            var record = try await requireRecord()
            if !record.stopped { var body = try MediaJSON.object(record.document); body["stopped"] = .bool(true); record = try await save(.object(body)) }
            for (index, slot) in CompanionJSON.turns(record.document).enumerated() where MediaJSON.member(slot, "record") != .null { _ = try await voice(record, index).stopTurn() }
            return try await view(requireRecord())
        }
    }
}
