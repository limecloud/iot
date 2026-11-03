import Foundation

private actor MediaPersistenceGate {
    static let shared = MediaPersistenceGate()
    private var busy = false
    func begin() throws { guard !busy else { throw MediaError(code: "media_busy") }; busy = true }
    func end() { busy = false }
}

// 上传正文只活在本次请求内；耐久原记录不含正文、下载URL或授权令牌。
public actor MediaClient {
    private let gateway: GatewayClient
    private let store: any SessionStore
    private let origin: String
    private var previous: Data?
    private var loaded = false
    private var busy = false
    private var storageKey: String { origin + "#media-operations" }
    public init(gateway: GatewayClient, store: any SessionStore) { self.gateway = gateway; self.store = store; origin = gateway.origin }
    private func locked<T: Sendable>(_ operation: () async throws -> T) async throws -> T {
        guard !busy else { throw MediaError(code: "media_busy") }; busy = true; defer { busy = false }
        try await MediaPersistenceGate.shared.begin()
        do { let result = try await operation(); await MediaPersistenceGate.shared.end(); return result }
        catch { await MediaPersistenceGate.shared.end(); throw error }
    }
    private func load() async throws -> [MediaRecord] {
        let data: Data?
        do { data = try await store.load(origin: storageKey) } catch { throw MediaError(code: "media_storage_failed") }
        guard !loaded || data == previous else { throw MediaError(code: "media_record_changed") }
        var records: [MediaRecord] = []
        if let data {
            do {
                guard let text = String(data: data, encoding: .utf8) else { throw MediaJSON.fail() }
                let state = try MediaJSON.fields(IntegerJSON.parse(text), "version,origin,records")
                try MediaJSON.require(state["version"] == .integer(1) && state["origin"] == .string(origin))
                guard case .array(let items) = state["records"], items.count <= 128 else { throw MediaJSON.fail() }
                for value in items {
                    let item = try MediaJSON.fields(value, "original,result"), original = item["original"]!
                    try MediaJSON.original(original, origin: origin)
                    let result = item["result"] == .null ? nil : item["result"]
                    if let result { try MediaJSON.operation(result, original: original) }
                    records.append(MediaRecord(original: original, result: result))
                }
                try MediaJSON.require(Set(records.map { $0.space + ":" + $0.id }).count == records.count)
            } catch { throw MediaError(code: "media_storage_failed") }
        }
        previous = data; loaded = true; return records
    }
    private func persist(_ records: [MediaRecord]) async throws {
        let state = JSONValue.object(["version": .integer(1), "origin": .string(origin), "records": .array(records.map { .object(["original": $0.original, "result": $0.result ?? .null]) })])
        let data = Data(IntegerJSON.canonical(state).utf8)
        do { _ = try IntegerJSON.parse(String(decoding: data, as: UTF8.self)) } catch { throw MediaError(code: "media_capacity") }
        do {
            guard try await store.load(origin: storageKey) == previous else { throw MediaError(code: "media_record_changed") }
            try await store.save(origin: storageKey, data: data)
            guard try await store.load(origin: storageKey) == data else { throw MediaError(code: "media_storage_failed") }
        } catch { throw MediaError(code: "media_storage_failed") }
        previous = data; loaded = true
    }
    public func records(space: String) async throws -> [MediaRecord] {
        try MediaJSON.id(.string(space))
        return try await locked { try await load().filter { $0.space == space } }
    }
    public func list(space: String) async throws -> MediaPage {
        try MediaJSON.id(.string(space))
        return try MediaJSON.page(await gateway.mediaCall(space: space, suffix: "/media"), space: space)
    }
    public func targets(space: String) async throws -> [MediaTarget] {
        try MediaJSON.id(.string(space))
        let candidates = try MediaTargets.candidates(await gateway.mediaCall(space: space, suffix: "/execution-adapters"))
        var result: [MediaTarget] = []
        for candidate in candidates {
            let device = MediaJSON.string(candidate, "device_id")
            let binding = try await gateway.mediaCall(space: space, suffix: "/devices/" + device + "/execution-binding")
            if let target = try MediaTargets.current(binding, candidate: candidate) { result.append(target) }
        }
        return result
    }
    public func submit(space: String, change: JSONValue, key: String = UUID().uuidString.lowercased()) async throws -> MediaRecord {
        try await locked {
            let original = try MediaJSON.original(origin: origin, space: space, key: key, change: change), records = try await load()
            if let old = records.first(where: { $0.space == space && $0.id == key }) {
                try MediaJSON.require(old.original == original)
                return try await resolveSaved(records, record: old)
            }
            guard records.count < 128 else { throw MediaError(code: "media_capacity") }
            guard !records.contains(where: { $0.space == space && $0.result == nil && MediaJSON.scope($0.change) == MediaJSON.scope(change) }) else { throw MediaError(code: "media_pending_operation") }
            let record = MediaRecord(original: original, result: nil), next = records + [record]
            try await persist(next)
            try Task.checkCancellation()
            let result = try await gateway.mediaCall(space: space, suffix: "/media-operations", method: "POST", body: change, key: key)
            try MediaJSON.operation(result, original: original)
            let resolved = MediaRecord(original: original, result: result)
            try await persist(next.map { $0.original == original ? resolved : $0 }); return resolved
        }
    }
    private func resolveSaved(_ records: [MediaRecord], record: MediaRecord) async throws -> MediaRecord {
        let result: JSONValue
        do { result = try await gateway.mediaCall(space: record.space, suffix: "/media-operations/by-key/" + record.id) }
        catch GatewayError.server(_, 404) { throw MediaError(code: "media_unknown") }
        try MediaJSON.operation(result, original: record.original)
        if let old = record.result { try MediaJSON.require(MediaJSON.stable(old) == MediaJSON.stable(result)) }
        let resolved = MediaRecord(original: record.original, result: result)
        try await persist(records.map { $0.original == record.original ? resolved : $0 }); return resolved
    }
    public func resolve(space: String, key: String) async throws -> MediaRecord {
        try MediaJSON.id(.string(space)); try MediaJSON.id(.string(key))
        return try await locked {
            let records = try await load()
            guard let record = records.first(where: { $0.space == space && $0.id == key }) else { throw MediaError(code: "media_record_missing") }
            return try await resolveSaved(records, record: record)
        }
    }
}
