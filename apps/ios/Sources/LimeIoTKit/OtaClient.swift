import Foundation

private actor OtaPersistenceGate {
    static let shared = OtaPersistenceGate()
    private var busy = false
    func begin() throws { guard !busy else { throw OtaError(code: "ota_busy") }; busy = true }
    func end() { busy = false }
}

// 跨 await 和跨实例使用明确互斥，防止 Actor 重入或会话重建时覆盖耐久原记录。
public actor OtaClient {
    private let gateway: GatewayClient
    private let store: any SessionStore
    private let origin: String
    private var previous: Data?
    private var loaded = false
    private var busy = false
    public init(gateway: GatewayClient, store: any SessionStore) {
        self.gateway = gateway; self.store = store; origin = gateway.origin
    }
    private var storageKey: String { origin + "#ota-operations" }
    private func begin() throws { guard !busy else { throw OtaError(code: "ota_busy") }; busy = true }
    private func locked<T: Sendable>(_ action: () async throws -> T) async throws -> T {
        try begin(); defer { busy = false }
        try await OtaPersistenceGate.shared.begin()
        do { let result = try await action(); await OtaPersistenceGate.shared.end(); return result }
        catch { await OtaPersistenceGate.shared.end(); throw error }
    }
    private func load() async throws -> [OtaRecord] {
        let data: Data?
        do { data = try await store.load(origin: storageKey) } catch { throw OtaError(code: "ota_storage_failed") }
        guard !loaded || data == previous else { throw OtaError(code: "ota_record_changed") }
        var records: [OtaRecord] = []
        if let data {
            do {
                guard let text = String(data: data, encoding: .utf8) else { throw OtaJSON.fail() }
                let state = try OtaJSON.fields(OtaJSON.parse(text, response: true), "version,origin,records")
                try OtaJSON.require(state["version"] == .integer(1) && state["origin"] == .string(origin))
                guard case .array(let items) = state["records"], items.count <= 128 else { throw OtaJSON.fail() }
                for value in items {
                    let record = try OtaJSON.fields(value, "request,result"), request = try OtaJSON.fields(record["request"], "space_id,idempotency_key,change")
                    try OtaJSON.id(request["space_id"]); try OtaJSON.id(request["idempotency_key"]); try OtaJSON.change(request["change"]!)
                    let result = record["result"] == .null ? nil : record["result"]
                    if let result { try OtaJSON.operation(result, expected: record["request"]!) }
                    records.append(OtaRecord(request: record["request"]!, result: result))
                }
                let identities = try records.map { try OtaJSON.text(OtaJSON.object($0.request)["space_id"]) + ":" + $0.id }
                try OtaJSON.require(Set(identities).count == records.count)
            } catch { throw OtaError(code: "ota_storage_failed") }
        }
        previous = data; loaded = true; return records
    }
    private func persist(_ records: [OtaRecord]) async throws {
        let value = JSONValue.object(["version": .integer(1), "origin": .string(origin), "records": .array(records.map { .object(["request": $0.request, "result": $0.result ?? .null]) })])
        let data = Data(OtaJSON.canonical(value).utf8)
        // 不写入下一次无法按相同边界读取的状态；结果过大时保留原未决记录。
        do { _ = try OtaJSON.parse(String(decoding: data, as: UTF8.self), response: true) }
        catch { throw OtaError(code: "ota_capacity") }
        do {
            guard try await store.load(origin: storageKey) == previous else { throw OtaError(code: "ota_record_changed") }
            try await store.save(origin: storageKey, data: data)
            guard try await store.load(origin: storageKey) == data else { throw OtaError(code: "ota_storage_failed") }
        } catch { throw OtaError(code: "ota_storage_failed") }
        previous = data; loaded = true
    }
    public func records(space: String) async throws -> [OtaRecord] {
        try await locked { try await load().filter { try OtaJSON.object($0.request)["space_id"] == .string(space) } }
    }
    public func trusts(space: String) async throws -> [FirmwareTrust] {
        try OtaJSON.id(.string(space))
        let page = try OtaJSON.fields(await gateway.otaCall(space: space, suffix: "/firmware-trusts"), "items,next_cursor")
        guard case .array(let items) = page["items"], items.count <= 32, page["next_cursor"] == .null else { throw OtaJSON.fail() }
        let result = try items.map { try OtaJSON.trust($0); return FirmwareTrust(document: $0) }
        try OtaJSON.require(Set(result.map(\.id)).count == result.count); return result
    }
    public func task(space: String, id: String) async throws -> OtaTask {
        try OtaJSON.id(.string(space)); try OtaJSON.id(.string(id), "ota-")
        let value = try await gateway.otaCall(space: space, suffix: "/ota-tasks/" + id)
        try OtaJSON.task(value); let result = OtaTask(document: value); try OtaJSON.require(result.id == id); return result
    }
    public func tasks(space: String) async throws -> [OtaTask] {
        try OtaJSON.id(.string(space)); var result: [OtaTask] = [], cursor: String?
        repeat {
            let page = try OtaJSON.fields(await gateway.otaCall(space: space, suffix: "/ota-tasks" + (cursor.map { "?after=" + $0 } ?? "")), "items,next_cursor")
            guard case .array(let items) = page["items"], items.count <= 16 else { throw OtaJSON.fail() }
            result += try items.map { try OtaJSON.task($0); return OtaTask(document: $0) }
            try OtaJSON.require(result.count <= 128 && Set(result.map(\.id)).count == result.count)
            let next = page["next_cursor"] == .null ? nil : try OtaJSON.text(page["next_cursor"])
            if let next { try OtaJSON.id(.string(next), "ota-"); try OtaJSON.require(!items.isEmpty && next == result.last?.id && next != cursor && result.count < 128) }
            cursor = next
        } while cursor != nil
        return result
    }
    private func scope(space: String, change: JSONValue) async throws -> String {
        let c = try OtaJSON.object(change)
        switch try OtaJSON.text(c["type"]) {
        case "trust.add": return "trust:" + OtaJSON.digest(c["trust"]!)
        case "tasks.plan": return "device:" + (try OtaJSON.text(c["device_id"]))
        default: return "device:" + (try await task(space: space, id: OtaJSON.text(c["task_id"]))).deviceId
        }
    }
    public func submit(space: String, change: JSONValue, key: String = UUID().uuidString.lowercased()) async throws -> OtaRecord {
        try await locked { try await submitSaved(space: space, change: change, key: key) }
    }
    private func submitSaved(space: String, change: JSONValue, key: String) async throws -> OtaRecord {
        let checked = try OtaJSON.change(OtaJSON.canonical(change)), c = try OtaJSON.object(checked)
        try OtaJSON.id(.string(space)); try OtaJSON.id(.string(key))
        if c["type"] == .string("trust.add"), c["expected_signing_key_id"] != (try OtaJSON.object(c["trust"])["signing_key_id"]) { throw OtaError(code: "ota_fingerprint_mismatch") }
        let request = JSONValue.object(["space_id": .string(space), "idempotency_key": .string(key), "change": checked]), records = try await load()
        if let old = try records.first(where: { try $0.id == key && OtaJSON.object($0.request)["space_id"] == .string(space) }) {
            try OtaJSON.require(old.request == request); return try await resolveSaved(records, record: old)
        }
        guard records.count < 128 else { throw OtaError(code: "ota_capacity") }
        if c["type"] != .string("trust.revoke") {
            let pending = try records.filter { try $0.result == nil && OtaJSON.object($0.request)["space_id"] == .string(space) && $0.type != "trust.revoke" }
            if !pending.isEmpty {
                let target = try await scope(space: space, change: checked)
                for record in pending {
                    if try await scope(space: space, change: OtaJSON.object(record.request)["change"]!) == target { throw OtaError(code: "ota_pending_operation") }
                }
            }
        }
        let record = OtaRecord(request: request, result: nil), next = records + [record]
        try await persist(next) // 保存与回读成功后，才允许发出唯一一次 POST。
        try Task.checkCancellation()
        let result = try await gateway.otaCall(space: space, suffix: "/ota-operations", method: "POST", body: checked, key: key)
        try OtaJSON.operation(result, expected: request)
        let resolved = OtaRecord(request: request, result: result)
        try await persist(next.map { $0.request == request ? resolved : $0 }); return resolved
    }
    private func resolveSaved(_ records: [OtaRecord], record: OtaRecord) async throws -> OtaRecord {
        let space = try OtaJSON.text(OtaJSON.object(record.request)["space_id"])
        let result = try await gateway.otaCall(space: space, suffix: "/ota-operations/by-key/" + record.id)
        try OtaJSON.operation(result, expected: record.request)
        try OtaJSON.require(record.result == nil || record.result == result)
        let resolved = OtaRecord(request: record.request, result: result)
        try await persist(records.map { $0.request == record.request ? resolved : $0 }); return resolved
    }
    public func resolve(space: String, key: String) async throws -> OtaRecord {
        try await locked {
            let records = try await load()
            guard let record = try records.first(where: { try $0.id == key && OtaJSON.object($0.request)["space_id"] == .string(space) }) else { throw OtaError(code: "ota_record_missing") }
            return try await resolveSaved(records, record: record)
        }
    }
}
