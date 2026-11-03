import Foundation

private actor SpeechPersistenceGate {
    static let shared = SpeechPersistenceGate()
    private var busy = false
    func begin() throws { guard !busy else { throw SpeechError(code: "speech_busy") }; busy = true }
    func end() { busy = false }
}
// 正文只参与当次摘要和POST；本机只保存原身份、状态及明确放弃意图。
public actor SpeechClient {
    private let gateway: GatewayClient
    private let store: any SessionStore
    private let origin: String
    private var previous: Data?
    private var unconfirmedWrite: Data?
    private var loaded = false, busy = false
    private var storageKey: String { origin + "#speech-syntheses" }
    public init(gateway: GatewayClient, store: any SessionStore) { self.gateway = gateway; self.store = store; origin = gateway.origin }
    private func locked<T: Sendable>(_ work: () async throws -> T) async throws -> T {
        guard !busy else { throw SpeechError(code: "speech_busy") }; busy = true; defer { busy = false }
        try await SpeechPersistenceGate.shared.begin()
        do { let result = try await work(); await SpeechPersistenceGate.shared.end(); return result }
        catch { await SpeechPersistenceGate.shared.end(); if error is MediaError { throw SpeechError(code: "invalid_speech_response") }; throw error }
    }
    private func load() async throws -> [SpeechRecord] {
        do {
            let data = try await store.load(origin: storageKey)
            guard !loaded || data == previous || unconfirmedWrite != nil && data == unconfirmedWrite else { throw SpeechError(code: "speech_record_changed") }
            var records: [SpeechRecord] = []
            if let data {
                guard let text = String(data: data, encoding: .utf8) else { throw MediaJSON.fail() }
                let v = try MediaJSON.fields(IntegerJSON.parse(text), "version,origin,records")
                try MediaJSON.require(v["version"] == .integer(1) && v["origin"] == .string(origin))
                guard case .array(let items) = v["records"], items.count <= 128 else { throw MediaJSON.fail() }
                for item in items {
                    let r = try MediaJSON.fields(item, "original,result,rejected_code,discard_intents"), original = r["original"]!
                    try SpeechJSON.original(original, origin: origin)
                    let result = r["result"] == .null ? nil : r["result"]
                    if let result { try SpeechJSON.task(result, original: original) }
                    let rejected = r["rejected_code"] == .null ? nil : try MediaJSON.text(r["rejected_code"])
                    try MediaJSON.require(rejected == nil || rejected!.range(of: #"^[a-z][a-z0-9_]{0,63}$"#, options: .regularExpression) != nil && result == nil)
                    guard case .array(let intents) = r["discard_intents"], intents.count <= 8 else { throw MediaJSON.fail() }
                    for id in intents { try MediaJSON.id(id) }; let ids = try intents.map { try MediaJSON.text($0) }
                    try MediaJSON.require(Set(ids).count == ids.count && (rejected == nil || ids.isEmpty))
                    records.append(SpeechRecord(original: original, result: result, rejectedCode: rejected, discardIntents: ids))
                }
                try MediaJSON.require(Set(records.map { $0.space + ":" + $0.id }).count == records.count)
            }
            previous = data; unconfirmedWrite = nil; loaded = true; return records
        } catch { throw SpeechError(code: "speech_storage_failed") }
    }
    private func persist(_ records: [SpeechRecord]) async throws {
        let document = JSONValue.object(["version": .integer(1), "origin": .string(origin), "records": .array(records.map { .object(["original": $0.original, "result": $0.result ?? .null, "rejected_code": $0.rejectedCode.map(JSONValue.string) ?? .null, "discard_intents": .array($0.discardIntents.map(JSONValue.string))]) })])
        let data = Data(IntegerJSON.canonical(document).utf8)
        do { _ = try IntegerJSON.parse(String(decoding: data, as: UTF8.self)); guard try await store.load(origin: storageKey) == previous else { throw MediaJSON.fail() }; unconfirmedWrite = data; try await store.save(origin: storageKey, data: data); guard try await store.load(origin: storageKey) == data else { throw MediaJSON.fail() } }
        catch { throw SpeechError(code: "speech_storage_failed") }
        previous = data; unconfirmedWrite = nil; loaded = true
    }
    public func capabilities(space: String) async throws -> SpeechCapabilities {
        do { let value = try await gateway.mediaCall(space: space, suffix: "/capabilities"); return try SpeechJSON.capabilities(MediaJSON.member(value, "speech")) }
        catch is MediaError { throw SpeechError(code: "invalid_speech_response") }
    }
    public func records(space: String) async throws -> [SpeechRecord] { try MediaJSON.id(.string(space)); return try await locked { try await load().filter { $0.space == space } } }
    private func accept(_ result: JSONValue, record: SpeechRecord, records: [SpeechRecord]) async throws -> SpeechRecord {
        try SpeechJSON.task(result, original: record.original, previous: record.result)
        guard record.rejectedCode == nil else { throw MediaJSON.fail() }
        let next = SpeechRecord(original: record.original, result: result, rejectedCode: nil, discardIntents: record.discardIntents)
        try await persist(records.map { $0.space == record.space && $0.id == record.id ? next : $0 }); return next
    }
    private func resolveSaved(_ record: SpeechRecord, records: [SpeechRecord]) async throws -> SpeechRecord {
        do { return try await accept(gateway.mediaCall(space: record.space, suffix: "/speech-syntheses/by-key/" + record.id), record: record, records: records) }
        catch GatewayError.server(_, 404) { throw SpeechError(code: "speech_unknown") }
    }
    public func submit(space: String, input: JSONValue, key: String = UUID().uuidString.lowercased()) async throws -> SpeechRecord {
        try await locked {
            let checked = try SpeechRequests.parse(IntegerJSON.canonical(input)), original = try SpeechJSON.original(origin: origin, space: space, key: key, input: checked), records = try await load()
            if let old = records.first(where: { $0.space == space && $0.id == key }) { try MediaJSON.require(old.original == original); return try await resolveSaved(old, records: records) }
            guard records.count < 128 else { throw SpeechError(code: "speech_capacity") }
            guard !records.contains(where: { $0.space == space && $0.pending }) else { throw SpeechError(code: "speech_pending") }
            let record = SpeechRecord(original: original, result: nil, rejectedCode: nil, discardIntents: []), next = records + [record]
            try await persist(next); try Task.checkCancellation()
            let result: JSONValue
            do { result = try await gateway.mediaCall(space: space, suffix: "/speech-syntheses", method: "POST", body: checked, key: key) }
            catch let error as GatewayError {
                if error.definitiveRejection {
                    let code: String; if case .server(let value, _) = error { code = value } else { code = "unauthenticated" }
                    try MediaJSON.require(code.range(of: #"^[a-z][a-z0-9_]{0,63}$"#, options: .regularExpression) != nil)
                    try await persist(next.map { $0.id == key && $0.space == space ? SpeechRecord(original: original, result: nil, rejectedCode: code, discardIntents: []) : $0 })
                }
                throw error
            }
            return try await accept(result, record: record, records: next)
        }
    }
    public func resolve(space: String, key: String) async throws -> SpeechRecord {
        try await locked { try MediaJSON.id(.string(space)); try MediaJSON.id(.string(key)); let records = try await load(); guard let record = records.first(where: { $0.space == space && $0.id == key }) else { throw SpeechError(code: "speech_record_missing") }; return try await resolveSaved(record, records: records) }
    }
    public func discard(space: String, key: String, intent: String = UUID().uuidString.lowercased()) async throws -> SpeechRecord {
        try await locked {
            try MediaJSON.id(.string(space)); try MediaJSON.id(.string(key)); try MediaJSON.id(.string(intent))
            let records = try await load(); guard let record = records.first(where: { $0.space == space && $0.id == key }) else { throw SpeechError(code: "speech_record_missing") }
            if record.discardIntents.contains(intent) { return try await resolveSaved(record, records: records) }
            guard ["running", "unknown"].contains(record.status) else { throw SpeechError(code: "speech_pending") }
            guard record.discardIntents.count < 8 else { throw SpeechError(code: "speech_capacity") }
            let next = SpeechRecord(original: record.original, result: record.result, rejectedCode: nil, discardIntents: record.discardIntents + [intent]), updated = records.map { $0.id == key && $0.space == space ? next : $0 }
            try await persist(updated); try Task.checkCancellation()
            return try await accept(gateway.mediaCall(space: space, suffix: "/speech-syntheses/by-key/" + key + "/discard", method: "POST", body: .object([:])), record: next, records: updated)
        }
    }
}
