import Foundation

private actor TranscriptionPersistenceGate {
    static let shared = TranscriptionPersistenceGate()
    private var busy = false
    func begin() throws { guard !busy else { throw TranscriptionError(code: "transcription_busy") }; busy = true }
    func end() { busy = false }
}
// 识别正文只随当次返回值交付；本机仅保存原请求、去正文观测及明确放弃意图。
public actor TranscriptionClient {
    private let gateway: GatewayClient
    private let store: any SessionStore
    private let origin: String
    private var previous: Data?
    private var unconfirmedWrite: Data?
    private var loaded = false, busy = false
    private var storageKey: String { origin + "#audio-transcriptions" }
    public init(gateway: GatewayClient, store: any SessionStore) { self.gateway = gateway; self.store = store; origin = gateway.origin }
    private func locked<T: Sendable>(_ work: () async throws -> T) async throws -> T {
        guard !busy else { throw TranscriptionError(code: "transcription_busy") }; busy = true; defer { busy = false }
        try await TranscriptionPersistenceGate.shared.begin()
        do { let result = try await work(); await TranscriptionPersistenceGate.shared.end(); return result }
        catch { await TranscriptionPersistenceGate.shared.end(); if error is MediaError { throw TranscriptionError(code: "invalid_transcription_response") }; throw error }
    }
    private func load() async throws -> [TranscriptionRecord] {
        do {
            let data = try await store.load(origin: storageKey)
            guard !loaded || data == previous || unconfirmedWrite != nil && data == unconfirmedWrite else { throw TranscriptionError(code: "transcription_record_changed") }
            var records: [TranscriptionRecord] = []
            if let data {
                guard let text = String(data: data, encoding: .utf8) else { throw MediaJSON.fail() }
                let v = try MediaJSON.fields(IntegerJSON.parse(text), "version,origin,records")
                try MediaJSON.require(v["version"] == .integer(1) && v["origin"] == .string(origin))
                guard case .array(let items) = v["records"], items.count <= 128 else { throw MediaJSON.fail() }
                for item in items {
                    let r = try MediaJSON.fields(item, "original,observation,rejected_code,discard_intents"), original = r["original"]!
                    try TranscriptionJSON.original(original, origin: origin)
                    let result = r["observation"] == .null ? nil : r["observation"]
                    if let result { try TranscriptionJSON.task(result, original: original, stored: true) }
                    let rejected = r["rejected_code"] == .null ? nil : try MediaJSON.text(r["rejected_code"])
                    try MediaJSON.require(rejected == nil || rejected!.range(of: #"^[a-z][a-z0-9_]{0,63}$"#, options: .regularExpression) != nil && result == nil)
                    guard case .array(let intents) = r["discard_intents"], intents.count <= 8 else { throw MediaJSON.fail() }
                    for id in intents { try MediaJSON.id(id) }; let ids = try intents.map { try MediaJSON.text($0) }
                    try MediaJSON.require(Set(ids).count == ids.count && (rejected == nil || ids.isEmpty))
                    records.append(TranscriptionRecord(original: original, observation: result, rejectedCode: rejected, discardIntents: ids, text: nil))
                }
                try MediaJSON.require(Set(records.map { $0.space + ":" + $0.id }).count == records.count)
            }
            previous = data; unconfirmedWrite = nil; loaded = true; return records
        } catch { throw TranscriptionError(code: "transcription_storage_failed") }
    }
    private func persist(_ records: [TranscriptionRecord]) async throws {
        let document = JSONValue.object(["version": .integer(1), "origin": .string(origin), "records": .array(records.map { .object(["original": $0.original, "observation": $0.observation ?? .null, "rejected_code": $0.rejectedCode.map(JSONValue.string) ?? .null, "discard_intents": .array($0.discardIntents.map(JSONValue.string))]) })])
        let data = Data(IntegerJSON.canonical(document).utf8)
        do { _ = try IntegerJSON.parse(String(decoding: data, as: UTF8.self)); guard try await store.load(origin: storageKey) == previous else { throw MediaJSON.fail() }; unconfirmedWrite = data; try await store.save(origin: storageKey, data: data); guard try await store.load(origin: storageKey) == data else { throw MediaJSON.fail() } }
        catch { throw TranscriptionError(code: "transcription_storage_failed") }
        previous = data; unconfirmedWrite = nil; loaded = true
    }
    public func capabilities(space: String) async throws -> TranscriptionCapabilities {
        do { let value = try await gateway.mediaCall(space: space, suffix: "/capabilities"); return try TranscriptionJSON.capabilities(MediaJSON.member(value, "transcription")) }
        catch is MediaError { throw TranscriptionError(code: "invalid_transcription_response") }
    }
    public func records(space: String) async throws -> [TranscriptionRecord] { try MediaJSON.id(.string(space)); return try await locked { try await load().filter { $0.space == space } } }
    private func accept(_ result: JSONValue, record: TranscriptionRecord, records: [TranscriptionRecord]) async throws -> TranscriptionRecord {
        try TranscriptionJSON.task(result, original: record.original, previous: record.observation)
        guard record.rejectedCode == nil else { throw MediaJSON.fail() }
        let text = MediaJSON.member(MediaJSON.member(result, "output"), "text")
        let next = TranscriptionRecord(original: record.original, observation: try TranscriptionJSON.metadata(result), rejectedCode: nil, discardIntents: record.discardIntents, text: { if case .string(let value) = text { value } else { nil } }())
        try await persist(records.map { $0.space == record.space && $0.id == record.id ? next : $0 }); return next
    }
    private func resolveSaved(_ record: TranscriptionRecord, records: [TranscriptionRecord]) async throws -> TranscriptionRecord {
        do { return try await accept(gateway.mediaCall(space: record.space, suffix: "/audio-transcriptions/by-key/" + record.id), record: record, records: records) }
        catch GatewayError.server(_, 404) { throw TranscriptionError(code: "transcription_unknown") }
    }
    public func submit(space: String, input: JSONValue, key: String = UUID().uuidString.lowercased()) async throws -> TranscriptionRecord {
        try await locked {
            let checked = try TranscriptionRequests.parse(IntegerJSON.canonical(input)), original = try TranscriptionJSON.original(origin: origin, space: space, key: key, input: checked), records = try await load()
            if let old = records.first(where: { $0.space == space && $0.id == key }) { try MediaJSON.require(old.original == original); return try await resolveSaved(old, records: records) }
            guard records.count < 128 else { throw TranscriptionError(code: "transcription_capacity") }
            guard !records.contains(where: { $0.space == space && $0.pending }) else { throw TranscriptionError(code: "transcription_pending") }
            let record = TranscriptionRecord(original: original, observation: nil, rejectedCode: nil, discardIntents: [], text: nil), next = records + [record]
            try await persist(next); try Task.checkCancellation()
            let result: JSONValue
            do { result = try await gateway.mediaCall(space: space, suffix: "/audio-transcriptions", method: "POST", body: checked, key: key) }
            catch let error as GatewayError {
                if error.definitiveRejection {
                    let code: String; if case .server(let value, _) = error { code = value } else { code = "unauthenticated" }
                    try MediaJSON.require(code.range(of: #"^[a-z][a-z0-9_]{0,63}$"#, options: .regularExpression) != nil)
                    try await persist(next.map { $0.id == key && $0.space == space ? TranscriptionRecord(original: original, observation: nil, rejectedCode: code, discardIntents: [], text: nil) : $0 })
                }
                throw error
            }
            return try await accept(result, record: record, records: next)
        }
    }
    public func resolve(space: String, key: String) async throws -> TranscriptionRecord {
        try await locked { try MediaJSON.id(.string(space)); try MediaJSON.id(.string(key)); let records = try await load(); guard let record = records.first(where: { $0.space == space && $0.id == key }) else { throw TranscriptionError(code: "transcription_record_missing") }; return try await resolveSaved(record, records: records) }
    }
    public func discard(space: String, key: String, intent: String = UUID().uuidString.lowercased()) async throws -> TranscriptionRecord {
        try await locked {
            try MediaJSON.id(.string(space)); try MediaJSON.id(.string(key)); try MediaJSON.id(.string(intent))
            let records = try await load(); guard let record = records.first(where: { $0.space == space && $0.id == key }) else { throw TranscriptionError(code: "transcription_record_missing") }
            if record.discardIntents.contains(intent) { return try await resolveSaved(record, records: records) }
            guard ["running", "unknown"].contains(record.status) else { throw TranscriptionError(code: "transcription_pending") }
            guard record.discardIntents.count < 8 else { throw TranscriptionError(code: "transcription_capacity") }
            let next = TranscriptionRecord(original: record.original, observation: record.observation, rejectedCode: nil, discardIntents: record.discardIntents + [intent], text: nil), updated = records.map { $0.id == key && $0.space == space ? next : $0 }
            try await persist(updated); try Task.checkCancellation()
            return try await accept(gateway.mediaCall(space: space, suffix: "/audio-transcriptions/by-key/" + key + "/discard", method: "POST", body: .object([:])), record: next, records: updated)
        }
    }
}
