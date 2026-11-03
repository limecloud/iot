import Foundation

private actor VisionPersistenceGate {
    static let shared = VisionPersistenceGate()
    private var busy = false
    func begin() throws { guard !busy else { throw VisionError(code: "vision_busy") }; busy = true }
    func end() { busy = false }
}
// 观察正文只随当次返回值交付；本机仅保存原请求摘要、去正文观测及明确清除意图。
public actor VisionClient {
    private let gateway: GatewayClient
    private let store: any SessionStore
    private let origin: String
    private var previous: Data?
    private var unconfirmedWrite: Data?
    private var loaded = false, busy = false
    private var storageKey: String { origin + "#vision-observations" }
    public init(gateway: GatewayClient, store: any SessionStore) { self.gateway = gateway; self.store = store; origin = gateway.origin }
    private func locked<T: Sendable>(_ work: () async throws -> T) async throws -> T {
        guard !busy else { throw VisionError(code: "vision_busy") }; busy = true; defer { busy = false }
        try await VisionPersistenceGate.shared.begin()
        do { let result = try await work(); await VisionPersistenceGate.shared.end(); return result }
        catch { await VisionPersistenceGate.shared.end(); if error is MediaError { throw VisionError(code: "invalid_vision_response") }; throw error }
    }
    private func load() async throws -> [VisionRecord] {
        do {
            let data = try await store.load(origin: storageKey)
            guard !loaded || data == previous || unconfirmedWrite != nil && data == unconfirmedWrite else { throw VisionError(code: "vision_record_changed") }
            var records: [VisionRecord] = []
            if let data {
                guard let text = String(data: data, encoding: .utf8) else { throw MediaJSON.fail() }
                let v = try MediaJSON.fields(IntegerJSON.parse(text), "version,origin,records")
                try MediaJSON.require(v["version"] == .integer(1) && v["origin"] == .string(origin))
                guard case .array(let items) = v["records"], items.count <= 128 else { throw MediaJSON.fail() }
                for item in items {
                    let r = try MediaJSON.fields(item, "original,observation,rejected_code,discard_intents"), original = r["original"]!
                    try VisionJSON.original(original, origin: origin)
                    let result = r["observation"] == .null ? nil : r["observation"]
                    if let result { try VisionJSON.task(result, original: original, stored: true) }
                    let rejected = r["rejected_code"] == .null ? nil : try MediaJSON.text(r["rejected_code"])
                    try MediaJSON.require(rejected == nil || rejected!.range(of: #"^[a-z][a-z0-9_]{0,63}$"#, options: .regularExpression) != nil && result == nil)
                    guard case .array(let intents) = r["discard_intents"], intents.count <= 8 else { throw MediaJSON.fail() }
                    for id in intents { try MediaJSON.id(id) }; let ids = try intents.map { try MediaJSON.text($0) }
                    try MediaJSON.require(Set(ids).count == ids.count && (rejected == nil || ids.isEmpty))
                    records.append(VisionRecord(original: original, observation: result, rejectedCode: rejected, discardIntents: ids, text: nil))
                }
                try MediaJSON.require(Set(records.map { $0.space + ":" + $0.id }).count == records.count)
            }
            previous = data; unconfirmedWrite = nil; loaded = true; return records
        } catch { throw VisionError(code: "vision_storage_failed") }
    }
    private func persist(_ records: [VisionRecord]) async throws {
        let document = JSONValue.object(["version": .integer(1), "origin": .string(origin), "records": .array(records.map { .object(["original": $0.original, "observation": $0.observation ?? .null, "rejected_code": $0.rejectedCode.map(JSONValue.string) ?? .null, "discard_intents": .array($0.discardIntents.map(JSONValue.string))]) })])
        let data = Data(IntegerJSON.canonical(document).utf8)
        do { _ = try IntegerJSON.parse(String(decoding: data, as: UTF8.self)); guard try await store.load(origin: storageKey) == previous else { throw MediaJSON.fail() }; unconfirmedWrite = data; try await store.save(origin: storageKey, data: data); guard try await store.load(origin: storageKey) == data else { throw MediaJSON.fail() } }
        catch { throw VisionError(code: "vision_storage_failed") }
        previous = data; unconfirmedWrite = nil; loaded = true
    }
    public func capabilities(space: String) async throws -> VisionCapabilities {
        do { let value = try await gateway.mediaCall(space: space, suffix: "/capabilities"); return try VisionJSON.capabilities(MediaJSON.member(value, "vision")) }
        catch is MediaError { throw VisionError(code: "invalid_vision_response") }
    }
    public func records(space: String) async throws -> [VisionRecord] { try MediaJSON.id(.string(space)); return try await locked { try await load().filter { $0.space == space } } }
    private func accept(_ result: JSONValue, record: VisionRecord, records: [VisionRecord]) async throws -> VisionRecord {
        try VisionJSON.task(result, original: record.original, previous: record.observation)
        guard record.rejectedCode == nil else { throw MediaJSON.fail() }
        let text = MediaJSON.member(MediaJSON.member(result, "output"), "text")
        let next = VisionRecord(original: record.original, observation: try VisionJSON.metadata(result), rejectedCode: nil, discardIntents: record.discardIntents, text: { if case .string(let value) = text { value } else { nil } }())
        try await persist(records.map { $0.space == record.space && $0.id == record.id ? next : $0 }); return next
    }
    private func resolveSaved(_ record: VisionRecord, records: [VisionRecord]) async throws -> VisionRecord {
        do { return try await accept(gateway.mediaCall(space: record.space, suffix: "/vision-observations/by-key/" + record.id), record: record, records: records) }
        catch GatewayError.server(_, 404) { throw VisionError(code: "vision_unknown") }
    }
    public func submit(space: String, input: JSONValue, key: String = UUID().uuidString.lowercased()) async throws -> VisionRecord {
        try await locked {
            let checked = try VisionRequests.checked(input), original = try VisionJSON.original(origin: origin, space: space, key: key, input: VisionJSON.summarize(checked)), records = try await load()
            if let old = records.first(where: { $0.space == space && $0.id == key }) { try MediaJSON.require(old.original == original); return try await resolveSaved(old, records: records) }
            guard records.count < 128 else { throw VisionError(code: "vision_capacity") }
            guard !records.contains(where: { $0.space == space && $0.pending }) else { throw VisionError(code: "vision_pending") }
            let record = VisionRecord(original: original, observation: nil, rejectedCode: nil, discardIntents: [], text: nil), next = records + [record]
            try await persist(next); try Task.checkCancellation()
            let result: JSONValue
            do { result = try await gateway.mediaCall(space: space, suffix: "/vision-observations", method: "POST", body: checked, key: key) }
            catch let error as GatewayError {
                if error.definitiveRejection {
                    let code: String; if case .server(let value, _) = error { code = value } else { code = "unauthenticated" }
                    try MediaJSON.require(code.range(of: #"^[a-z][a-z0-9_]{0,63}$"#, options: .regularExpression) != nil)
                    try await persist(next.map { $0.id == key && $0.space == space ? VisionRecord(original: original, observation: nil, rejectedCode: code, discardIntents: [], text: nil) : $0 })
                }
                throw error
            }
            return try await accept(result, record: record, records: next)
        }
    }
    public func resolve(space: String, key: String) async throws -> VisionRecord {
        try await locked { try MediaJSON.id(.string(space)); try MediaJSON.id(.string(key)); let records = try await load(); guard let record = records.first(where: { $0.space == space && $0.id == key }) else { throw VisionError(code: "vision_record_missing") }; return try await resolveSaved(record, records: records) }
    }
    public func discard(space: String, key: String, intent: String = UUID().uuidString.lowercased()) async throws -> VisionRecord {
        try await locked {
            try MediaJSON.id(.string(space)); try MediaJSON.id(.string(key)); try MediaJSON.id(.string(intent))
            let records = try await load(); guard let record = records.first(where: { $0.space == space && $0.id == key }) else { throw VisionError(code: "vision_record_missing") }
            if record.discardIntents.contains(intent) { return try await resolveSaved(record, records: records) }
            guard record.canDiscard else { throw VisionError(code: "vision_pending") }
            guard record.discardIntents.count < 8 else { throw VisionError(code: "vision_capacity") }
            let next = VisionRecord(original: record.original, observation: record.observation, rejectedCode: nil, discardIntents: record.discardIntents + [intent], text: nil), updated = records.map { $0.id == key && $0.space == space ? next : $0 }
            try await persist(updated); try Task.checkCancellation()
            return try await accept(gateway.mediaCall(space: space, suffix: "/vision-observations/by-key/" + key + "/discard", method: "POST", body: .object([:])), record: next, records: updated)
        }
    }
}
