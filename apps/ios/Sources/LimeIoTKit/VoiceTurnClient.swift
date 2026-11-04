import Foundation

private actor VoiceTurnPersistenceGate {
    static let shared = VoiceTurnPersistenceGate()
    private var busy = false
    func begin() throws { guard !busy else { throw VoiceTurnError(code: "voice_turn_busy") }; busy = true }
    func end() { busy = false }
}

// 调用者拥有前台Task；取消后不接受迟到结果，也不创建后续阶段。
public actor VoiceTurnClient {
    private let gateway: GatewayClient, store: any SessionStore, space: String, origin: String
    private let contextual: Bool, textContext: VoiceTextContext?, deadline: Date?
    private let now: @Sendable () -> Date
    private var previous: Data?, unconfirmedWrite: Data?
    private var loaded = false, busy = false
    private var storageKey: String { origin + "#voice-turns:" + space }
    public init(gateway: GatewayClient, store: any SessionStore, space: String, contextual: Bool = false, textContext: VoiceTextContext? = nil, deadline: Date? = nil, now: @escaping @Sendable () -> Date = Date.init) throws {
        self.contextual = contextual || textContext != nil; self.textContext = textContext; self.deadline = deadline
        try MediaJSON.id(.string(space)); self.gateway = gateway; self.store = store; self.space = space; self.now = now; origin = gateway.origin
    }
    private func locked<T: Sendable>(_ work: () async throws -> T) async throws -> T {
        guard !busy else { throw VoiceTurnError(code: "voice_turn_busy") }; busy = true; defer { busy = false }
        try await VoiceTurnPersistenceGate.shared.begin()
        do { try Task.checkCancellation(); let result = try await work(); await VoiceTurnPersistenceGate.shared.end(); return result }
        catch {
            await VoiceTurnPersistenceGate.shared.end()
            if error is MediaError || error is TextGenerationError || error is TranscriptionError || error is SpeechError { throw VoiceTurnError(code: "invalid_voice_turn_response") }
            throw error
        }
    }
    private func load() async throws -> VoiceTurnRecord? {
        try Task.checkCancellation()
        let data = try await store.load(origin: storageKey); try Task.checkCancellation()
        guard !loaded || data == previous || unconfirmedWrite != nil && data == unconfirmedWrite else { throw VoiceTurnError(code: "voice_turn_record_unavailable") }
        let record = try data.map { try VoiceTurnRecord.parse(String(decoding: $0, as: UTF8.self), origin: origin, space: space, contextual: contextual) }
        previous = data; unconfirmedWrite = nil; loaded = true; return record
    }
    private func save(_ value: JSONValue) async throws -> VoiceTurnRecord {
        try Task.checkCancellation()
        var body = try MediaJSON.object(value); body.removeValue(forKey: "checksum"); body["checksum"] = .string(IntegerJSON.digest(.object(body)))
        let text = IntegerJSON.canonical(.object(body)), next = try VoiceTurnRecord.parse(text, origin: origin, space: space, contextual: contextual), data = Data(text.utf8)
        do {
            guard try await store.load(origin: storageKey) == previous else { throw VoiceTurnError(code: "voice_turn_record_unavailable") }
            try Task.checkCancellation(); unconfirmedWrite = data; try await store.save(origin: storageKey, data: data); try Task.checkCancellation()
            guard try await store.load(origin: storageKey) == data else { throw VoiceTurnError(code: "voice_turn_record_unavailable") }
            try Task.checkCancellation()
        } catch is CancellationError { throw CancellationError() }
        catch { throw VoiceTurnError(code: "voice_turn_record_unavailable") }
        previous = data; unconfirmedWrite = nil; loaded = true; return next
    }
    private func call(_ suffix: String, input: JSONValue? = nil, key: String? = nil) async throws -> JSONValue {
        try Task.checkCancellation(); let value = try await gateway.mediaCall(space: space, suffix: suffix, method: input == nil ? "GET" : "POST", body: input, key: key); try Task.checkCancellation(); return value
    }
    public func capabilities() async throws -> VoiceTurnCapabilities {
        let value = try await call("/capabilities")
        return try VoiceTurnCapabilities(transcription: TranscriptionJSON.capabilities(MediaJSON.member(value, "transcription")), text: TextGenerationJSON.capabilities(MediaJSON.member(value, "text")), speech: SpeechJSON.capabilities(MediaJSON.member(value, "speech")))
    }
    public func record() async throws -> VoiceTurnRecord? { try await locked { try await load() } }
    private func source(_ record: VoiceTurnRecord) async throws {
        let page = try MediaJSON.page(await call("/media"), space: space), source = MediaJSON.member(record.document, "source")
        guard let item = page.items.first(where: { $0.id == MediaJSON.string(source, "media_id") }), item.available,
              MediaJSON.member(item.metadata, "content_digest") == MediaJSON.member(source, "content_digest"),
              try SpeechJSON.timestamp(MediaJSON.time(.string(item.expiresAt))) == MediaJSON.string(source, "expires_at"),
              try MediaJSON.time(.string(item.expiresAt)) > now() else { throw VoiceTurnError(code: "voice_turn_source_unavailable") }
    }
    private func accept(_ record: VoiceTurnRecord, kind: String, task: JSONValue) async throws -> VoiceTurnRecord {
        let job = VoiceTurnJSON.job(record.document, kind), original = MediaJSON.member(job, "original")
        if kind == "transcription" { try TranscriptionJSON.task(task, original: original) }
        else if kind == "text" { try TextGenerationJSON.task(task, original: original) }
        else { try SpeechJSON.task(task, original: original) }
        guard MediaJSON.member(MediaJSON.member(task, "deployment"), "revision") == MediaJSON.member(MediaJSON.member(record.document, "deployments"), kind) else { throw VoiceTurnError(code: "invalid_voice_turn_response") }
        var entry = try MediaJSON.object(job)
        entry["observation"] = try VoiceTurnJSON.observe(task, kind: kind, previous: entry["observation"]!)
        return try await save(VoiceTurnJSON.settingJob(record.document, kind, .object(entry)))
    }
    private func resolveRecord(_ record: VoiceTurnRecord) async throws -> (VoiceTurnRecord, [String: JSONValue]) {
        var current = record, tasks: [String: JSONValue] = [:]
        for kind in VoiceTurnJSON.kinds {
            let job = VoiceTurnJSON.job(current.document, kind)
            if job == .null || MediaJSON.member(job, "rejected_code") != .null { continue }
            let key = MediaJSON.string(MediaJSON.member(job, "original"), "idempotency_key")
            let task = try await call("/" + VoiceTurnJSON.family(kind) + "/by-key/" + key)
            current = try await accept(current, kind: kind, task: task); tasks[kind] = task
        }
        return (current, tasks)
    }
    private func view(_ record: VoiceTurnRecord, tasks: [String: JSONValue] = [:]) throws -> VoiceTurnView {
        let expired = try now() >= record.expiresAt, visible = !record.stopped && !expired
        var phase = record.stopped ? "stopped" : expired ? "expired" : "ready"
        if visible {
            for kind in VoiceTurnJSON.kinds {
                let job = VoiceTurnJSON.job(record.document, kind), observation = MediaJSON.member(job, "observation")
                if job != .null && MediaJSON.member(job, "rejected_code") != .null { phase = "failed"; break }
                if job != .null && MediaJSON.member(observation, "status") != .string("succeeded") { phase = observation == .null ? "unknown" : MediaJSON.string(observation, "status"); break }
                if job == .null { phase = "ready"; break }
                if kind == "speech" { phase = "succeeded" }
            }
        }
        func text(_ kind: String) throws -> String? {
            let output = MediaJSON.member(tasks[kind] ?? .null, "output")
            guard visible, output != .null, try MediaJSON.time(MediaJSON.member(output, "expires_at")) > now(), case .string(let text) = MediaJSON.member(output, "text") else { return nil }
            return text
        }
        return try VoiceTurnView(record: record, phase: phase, stage: VoiceTurnJSON.kinds.reversed().first { VoiceTurnJSON.job(record.document, $0) != .null }, transcript: text("transcription"), answer: text("text"), mediaID: visible && phase == "succeeded" ? MediaJSON.string(MediaJSON.member(VoiceTurnJSON.job(record.document, "speech"), "observation"), "media_id") : nil)
    }
    public func start(input: JSONValue) async throws -> VoiceTurnView {
        try await locked {
            let input = try VoiceTurnRequests.checked(input), previous = try await load(), turn = MediaJSON.string(input, "turn_id")
            if let previous {
                let jobs = VoiceTurnJSON.kinds.map { VoiceTurnJSON.job(previous.document, $0) }
                let unresolved = VoiceTurnJSON.kinds.contains { kind in
                    let job = VoiceTurnJSON.job(previous.document, kind)
                    guard job != .null && MediaJSON.member(job, "rejected_code") == .null else { return false }
                    let observed = MediaJSON.member(job, "observation")
                    return VoiceTurnJSON.pending(observed) || MediaJSON.member(job, "discard_attempted") == .bool(true) && kind == "text" && MediaJSON.member(observed, "status") == .string("succeeded") && MediaJSON.member(MediaJSON.member(observed, "output"), "cleared_at") == .null
                }
                let failed = jobs.contains { $0 != .null && (MediaJSON.member($0, "rejected_code") != .null || ["failed", "discarded"].contains(MediaJSON.string(MediaJSON.member($0, "observation"), "status"))) }
                guard !unresolved, previous.id != turn, previous.stopped || MediaJSON.member(MediaJSON.member(VoiceTurnJSON.job(previous.document, "speech"), "observation"), "status") == .string("succeeded") || failed else { throw VoiceTurnError(code: "voice_turn_pending") }
            }
            let capability = try await capabilities(), voice = MediaJSON.string(input, "voice")
            guard capability.configured, capability.speech.voices.contains(voice) else { throw VoiceTurnError(code: "voice_turn_not_configured") }
            let page = try MediaJSON.page(await call("/media"), space: space), mediaID = MediaJSON.string(input, "media_id")
            guard let source = page.items.first(where: { $0.id == mediaID }), source.available, try MediaJSON.time(.string(source.expiresAt)).timeIntervalSince(now()) >= 1 else { throw VoiceTurnError(code: "voice_turn_source_unavailable") }
            let created = now(), expires = try min(created.addingTimeInterval(300), MediaJSON.time(.string(source.expiresAt)), deadline ?? .distantFuture)
            guard expires.timeIntervalSince(created) >= 1 else { throw VoiceTurnError(code: "voice_turn_source_unavailable") }
            if contextual && textContext == nil { throw VoiceTurnError(code: "voice_turn_context_unavailable") }
            var body: [String: JSONValue] = ["version": .integer(contextual ? 2 : 1), "origin": .string(origin), "space_id": .string(space), "turn_id": .string(turn), "created_at": .string(SpeechJSON.timestamp(created)), "expires_at": .string(SpeechJSON.timestamp(expires)), "source": .object(["media_id": .string(mediaID), "content_digest": MediaJSON.member(source.metadata, "content_digest"), "expires_at": .string(try SpeechJSON.timestamp(MediaJSON.time(.string(source.expiresAt))))]), "language": MediaJSON.member(input, "language"), "voice": .string(voice), "retain_seconds": .integer(600), "deployments": .object(Dictionary(uniqueKeysWithValues: VoiceTurnJSON.kinds.map { ($0, capability.revision($0)) })), "jobs": .object(Dictionary(uniqueKeysWithValues: VoiceTurnJSON.kinds.map { ($0, .null) })), "stopped": .bool(false)]
            if let textContext, contextual { body["text_context"] = .object(["digest": .string(IntegerJSON.digest(textContext.document)), "history_messages": .integer(textContext.history.count)]) }
            let record = try await save(.object(body))
            return try await advance(record)
        }
    }
    public func resolve() async throws -> VoiceTurnView {
        try await locked { guard let record = try await load() else { throw VoiceTurnError(code: "voice_turn_not_found") }; let (next, tasks) = try await resolveRecord(record); return try view(next, tasks: tasks) }
    }
    public func continueTurn() async throws -> VoiceTurnView {
        try await locked { guard let record = try await load() else { throw VoiceTurnError(code: "voice_turn_not_found") }; return try await advance(record) }
    }
    private func advance(_ record: VoiceTurnRecord) async throws -> VoiceTurnView {
        var (current, tasks) = try await resolveRecord(record)
        let expires = try current.expiresAt
        if current.stopped || now() >= expires { return try view(current, tasks: tasks) }
        if MediaJSON.member(current.document, "version") == .integer(2) {
            guard let textContext, MediaJSON.member(MediaJSON.member(current.document, "text_context"), "digest") == .string(IntegerJSON.digest(textContext.document)) else { throw VoiceTurnError(code: "voice_turn_context_unavailable") }
        }
        for kind in VoiceTurnJSON.kinds {
            let job = VoiceTurnJSON.job(current.document, kind)
            if job != .null { if MediaJSON.member(job, "rejected_code") != .null || MediaJSON.member(MediaJSON.member(job, "observation"), "status") != .string("succeeded") { break }; continue }
            try await source(current); let capability = try await capabilities()
            guard capability.configured, VoiceTurnJSON.kinds.allSatisfy({ capability.revision($0) == MediaJSON.member(MediaJSON.member(current.document, "deployments"), $0) }) else { throw VoiceTurnError(code: "voice_turn_configuration_changed") }
            let deadline = try SpeechJSON.timestamp(min(now().addingTimeInterval(85), current.expiresAt))
            func text(_ stage: String) throws -> String {
                let output = MediaJSON.member(tasks[stage] ?? .null, "output")
                guard output != .null, case .string(let text) = MediaJSON.member(output, "text"), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, try MediaJSON.time(MediaJSON.member(output, "expires_at")) > now() else { throw VoiceTurnError(code: "voice_turn_text_unavailable") }
                return text
            }
            let input: JSONValue, original: JSONValue, key = current.id + "-" + kind
            if kind == "transcription" {
                let source = MediaJSON.member(current.document, "source")
                input = .object(["media_id": MediaJSON.member(source, "media_id"), "media_digest": MediaJSON.member(source, "content_digest"), "language": MediaJSON.member(current.document, "language"), "expires_at": .string(deadline)])
                original = try TranscriptionJSON.original(origin: origin, space: space, key: key, input: input)
            } else if kind == "text" {
                let context = MediaJSON.member(current.document, "version") == .integer(2) ? textContext : nil
                input = try TextGenerationRequests.input(messages: (context?.history ?? []) + [.init(role: "user", content: text("transcription"))], instructions: context?.instructions ?? VoiceTurnJSON.instructions, expiresAt: deadline)
                original = try TextGenerationJSON.original(origin: origin, space: space, key: key, input: TextGenerationJSON.summarize(input))
            } else {
                do { input = try SpeechRequests.parse(IntegerJSON.canonical(.object(["text": .string(try text("text")), "voice": MediaJSON.member(current.document, "voice"), "retain_seconds": .integer(600), "expires_at": .string(deadline)]))) }
                catch let error as VoiceTurnError { throw error }
                catch { throw VoiceTurnError(code: "voice_turn_answer_not_speakable") }
                original = try SpeechJSON.original(origin: origin, space: space, key: key, input: input)
            }
            try Task.checkCancellation(); if now() >= (try current.expiresAt) { return try view(current, tasks: tasks) }
            current = try await save(VoiceTurnJSON.settingJob(current.document, kind, .object(["original": original, "observation": .null, "rejected_code": .null, "discard_attempted": .bool(false)])))
            if now() >= (try current.expiresAt) { return try view(current, tasks: tasks) }
            let task: JSONValue
            do { task = try await call("/" + VoiceTurnJSON.family(kind), input: input, key: key) }
            catch let error as GatewayError {
                if error.definitiveRejection {
                    let code: String; if case .server(let value, _) = error { code = value } else { code = "unauthenticated" }
                    var rejected = try MediaJSON.object(VoiceTurnJSON.job(current.document, kind)); rejected["rejected_code"] = .string(code)
                    _ = try await save(VoiceTurnJSON.settingJob(current.document, kind, .object(rejected)))
                }
                throw error
            }
            current = try await accept(current, kind: kind, task: task); tasks[kind] = task
            if MediaJSON.member(task, "status") != .string("succeeded") { break }
        }
        return try view(current, tasks: tasks)
    }
    public func stopTurn() async throws -> VoiceTurnView {
        try await locked {
            guard var record = try await load() else { throw VoiceTurnError(code: "voice_turn_not_found") }
            if !record.stopped { var body = try MediaJSON.object(record.document); body["stopped"] = .bool(true); record = try await save(.object(body)) }
            for kind in VoiceTurnJSON.kinds {
                let job = VoiceTurnJSON.job(record.document, kind), observed = MediaJSON.member(job, "observation")
                if job == .null || MediaJSON.member(job, "rejected_code") != .null || kind == "text" && MediaJSON.member(MediaJSON.member(observed, "output"), "cleared_at") != .null || !VoiceTurnJSON.pending(observed) && !(kind == "text" && MediaJSON.member(observed, "status") == .string("succeeded")) { continue }
                let key = MediaJSON.string(MediaJSON.member(job, "original"), "idempotency_key"), suffix = "/" + VoiceTurnJSON.family(kind) + "/by-key/" + key
                let task: JSONValue
                if MediaJSON.member(job, "discard_attempted") != .bool(true) {
                    var entry = try MediaJSON.object(job); entry["discard_attempted"] = .bool(true); record = try await save(VoiceTurnJSON.settingJob(record.document, kind, .object(entry)))
                    task = try await call(suffix + "/discard", input: .object([:]))
                } else { task = try await call(suffix) }
                record = try await accept(record, kind: kind, task: task)
            }
            return try view(record)
        }
    }
}
