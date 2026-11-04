import Foundation

public struct ZigbeeError: Error, Sendable {
    public let code: String
    public init(_ code: String) { self.code = code }
    public var message: String { [
        "invalid_zigbee_response": "入网资料未通过核对，请重新读取",
        "invalid_zigbee_change": "请填写1–120秒的开放时长",
        "zigbee_storage_failed": "无法保存或读取入网记录，请查询原操作",
        "zigbee_record_changed": "本机入网记录已变化，请保留原记录后重新连接",
        "zigbee_operation_unresolved": "此前入网结果未确认，请查询原操作或明确关闭",
        "zigbee_operation_capacity": "本机入网记录已满",
        "zigbee_busy": "正在处理入网操作",
        "zigbee_review_changed": "协调器配置已变化，请重新核对",
        "zigbee_review_expired": "入网确认已过期，请重新核对",
        "zigbee_record_missing": "未找到本机原请求"
    ][code] ?? "入网结果待确认，请查询原操作" }
}
public struct ZigbeeCoordinator: Sendable, Equatable, Identifiable {
    public let document: JSONValue
    public var id: String { ObservationJSON.string(document, "coordinator_id") }
    public var ieee: String { ObservationJSON.string(document, "coordinator_ieee") }
    public var revision: String { ObservationJSON.string(document, "revision") }
}
public struct ZigbeePreparation: Sendable, Equatable {
    public let coordinator: ZigbeeCoordinator
    public let change: JSONValue
    public var seconds: Int { ObservationJSON.number(change, "duration_seconds") }
}
public struct ZigbeeRecord: Sendable, Equatable, Identifiable {
    public let request: JSONValue
    public let result: JSONValue?
    public var id: String { ObservationJSON.string(request, "idempotency_key") }
    public var coordinator: String { ObservationJSON.string(ObservationJSON.map(request)["change"], "coordinator_id") }
    public var seconds: Int { ObservationJSON.number(ObservationJSON.map(request)["change"], "duration_seconds") }
    public var accepted: Bool { ObservationJSON.string(result, "status") == "protocol_accepted" }
    public var statusText: String { accepted ? "协议已受理" : "结果未知" }
}

public enum ZigbeeJSON {
    private static func checked<T>(_ work: () throws -> T) throws -> T {
        do { return try work() } catch { throw ZigbeeError("invalid_zigbee_response") }
    }
    public static func parse(_ text: String) throws -> JSONValue { try checked { try IntegerJSON.parse(text, maxBytes: 2_000_000, maxDepth: 12, maxNodes: 65536) } }
    public static func change(_ value: JSONValue) throws {
        try checked {
            let c = try ObservationJSON.fields(value, "coordinator_id,expected_revision,duration_seconds")
            try ObservationJSON.id(c["coordinator_id"]); try ObservationJSON.hash(c["expected_revision"]); try ObservationJSON.integer(c["duration_seconds"], 0...120)
        }
    }
    private static func coordinator(_ value: JSONValue) throws -> ZigbeeCoordinator {
        let c = try ObservationJSON.fields(value, "coordinator_id,coordinator_ieee,revision,timeout_ms")
        try ObservationJSON.id(c["coordinator_id"]); try ObservationJSON.ieee(c["coordinator_ieee"]); try ObservationJSON.hash(c["revision"]); try ObservationJSON.integer(c["timeout_ms"], 100...30000)
        return ZigbeeCoordinator(document: value)
    }
    public static func coordinators(_ value: JSONValue) throws -> [ZigbeeCoordinator] {
        try checked {
            let page = try ObservationJSON.fields(value, "items,next_cursor")
            guard page["next_cursor"] == .null, case .array(let items) = page["items"], items.count <= 4 else { throw ObservationJSON.fail() }
            let result = try items.map(coordinator)
            try ObservationJSON.require(Set(result.map(\.id)).count == result.count && Set(result.map(\.ieee)).count == result.count); return result
        }
    }
    static func request(_ value: JSONValue) throws {
        let r = try ObservationJSON.fields(value, "space_id,idempotency_key,change")
        try ObservationJSON.id(r["space_id"]); try ObservationJSON.id(r["idempotency_key"]); try change(r["change"]!)
    }
    private static func time(_ value: JSONValue?) throws -> Date {
        try ObservationJSON.require(ObservationJSON.text(value).hasSuffix("Z")); return try ObservationJSON.time(value)
    }
    public static func operation(_ value: JSONValue, expected: JSONValue? = nil, previous: JSONValue? = nil) throws -> ZigbeeRecord {
        try checked {
            let o = try ObservationJSON.fields(value, "operation_id,sequence,request,request_digest,coordinator,status,reason,result,created_at,blocked_until,completed_at")
            try ObservationJSON.id(o["operation_id"]); try ObservationJSON.integer(o["sequence"], 1...256); try request(o["request"]!)
            let request = o["request"]!, change = ObservationJSON.map(ObservationJSON.map(request)["change"]), owner = try coordinator(o["coordinator"]!)
            try ObservationJSON.require((expected == nil || request == expected) && o["request_digest"] == .string(IntegerJSON.digest(request))
                && change["coordinator_id"] == .string(owner.id) && change["expected_revision"] == .string(owner.revision))
            let created = try time(o["created_at"]), blocked = try time(o["blocked_until"])
            let duration = ObservationJSON.number(owner.document, "timeout_ms") + ObservationJSON.number(.object(change), "duration_seconds") * 1000
            try ObservationJSON.require(abs(blocked.timeIntervalSince(created) * 1000 - Double(duration)) < 0.001)
            if o["completed_at"] != .null { try ObservationJSON.require(time(o["completed_at"]) >= created) }
            if o["status"] == .string("protocol_accepted") {
                let result = try ObservationJSON.fields(o["result"], "coordinator_ieee,duration_seconds,observed_at")
                _ = try time(o["completed_at"])
                try ObservationJSON.require(o["reason"] == .null && result["coordinator_ieee"] == .string(owner.ieee) && result["duration_seconds"] == change["duration_seconds"] && result["observed_at"] == o["completed_at"])
            } else {
                let reason = try ObservationJSON.text(o["reason"])
                try ObservationJSON.require(o["status"] == .string("unknown") && o["result"] == .null && ObservationJSON.matches(reason, "[a-z0-9_]{1,64}") && (o["completed_at"] != .null || reason == "not_confirmed"))
            }
            if let previous {
                let old = ObservationJSON.map(previous)
                for key in ["operation_id", "sequence", "request", "request_digest", "coordinator", "created_at", "blocked_until"] { try ObservationJSON.require(old[key] == o[key]) }
                if old["completed_at"] != .null { try ObservationJSON.require(previous == value) }
            }
            return ZigbeeRecord(request: request, result: value)
        }
    }
    public static func history(_ value: JSONValue, space: String) throws -> [ZigbeeRecord] {
        try checked {
            let p = try ObservationJSON.fields(value, "items,next_cursor")
            guard p["next_cursor"] == .null, case .array(let items) = p["items"], items.count <= 256 else { throw ObservationJSON.fail() }
            let records = try items.enumerated().map { index, item in
                let record = try operation(item)
                try ObservationJSON.require(ObservationJSON.number(item, "sequence") == index + 1 && ObservationJSON.string(record.request, "space_id") == space); return record
            }
            try ObservationJSON.require(Set(records.map(\.id)).count == records.count && Set(records.map { ObservationJSON.string($0.result, "operation_id") }).count == records.count)
            return records
        }
    }
    static func canOpen(_ preparation: ZigbeePreparation, records: [ZigbeeRecord], history: [ZigbeeRecord], now: Date) throws {
        for record in records {
            if let result = history.first(where: { $0.id == record.id })?.result { _ = try operation(result, expected: record.request, previous: record.result) }
        }
        guard preparation.seconds != 0 else { return }
        for record in records where record.coordinator == preparation.coordinator.id {
            guard history.contains(where: { $0.id == record.id }) else { throw ZigbeeError("zigbee_operation_unresolved") }
        }
        for record in history where record.coordinator == preparation.coordinator.id && !record.accepted {
            if try time(ObservationJSON.map(record.result)["blocked_until"]) > now { throw ZigbeeError("zigbee_operation_unresolved") }
        }
    }
}

private actor ZigbeePersistenceGate {
    static let shared = ZigbeePersistenceGate()
    private var busy = false
    func begin() throws { guard !busy else { throw ZigbeeError("zigbee_busy") }; busy = true }
    func end() { busy = false }
}
public actor ZigbeeClient {
    private let gateway: GatewayClient, store: any SessionStore
    private let now: @Sendable () -> Date
    private var previous: Data?, loaded = false
    private var storageKey: String { gateway.origin + "#zigbee-operations" }
    public init(gateway: GatewayClient, store: any SessionStore, now: @escaping @Sendable () -> Date = Date.init) { self.gateway = gateway; self.store = store; self.now = now }
    private func locked<T: Sendable>(_ action: () async throws -> T) async throws -> T {
        try await ZigbeePersistenceGate.shared.begin()
        do { try Task.checkCancellation(); let value = try await action(); await ZigbeePersistenceGate.shared.end(); return value }
        catch { await ZigbeePersistenceGate.shared.end(); throw error }
    }
    private func load() async throws -> [ZigbeeRecord] {
        do {
            let data = try await store.load(origin: storageKey)
            guard !loaded || data == previous else { throw ZigbeeError("zigbee_record_changed") }
            var records: [ZigbeeRecord] = []
            if let data {
                let v = try ObservationJSON.fields(ZigbeeJSON.parse(String(decoding: data, as: UTF8.self)), "version,origin,records")
                guard v["version"] == .integer(1), v["origin"] == .string(gateway.origin), case .array(let items) = v["records"], items.count <= 256 else { throw ZigbeeError("zigbee_storage_failed") }
                records = try items.map { item in
                    let r = try ObservationJSON.fields(item, "request,result"); try ZigbeeJSON.request(r["request"]!)
                    return r["result"] == .null ? ZigbeeRecord(request: r["request"]!, result: nil) : try ZigbeeJSON.operation(r["result"]!, expected: r["request"]!)
                }
                try ObservationJSON.require(Set(records.map { ObservationJSON.string($0.request, "space_id") + ":" + $0.id }).count == records.count)
            }
            previous = data; loaded = true; return records
        } catch is CancellationError { throw CancellationError() } catch let error as ZigbeeError { throw error } catch { throw ZigbeeError("zigbee_storage_failed") }
    }
    private func persist(_ records: [ZigbeeRecord]) async throws {
        let state = JSONValue.object(["version": .integer(1), "origin": .string(gateway.origin), "records": .array(records.map { .object(["request": $0.request, "result": $0.result ?? .null]) })])
        let data = Data(IntegerJSON.canonical(state).utf8)
        _ = try ZigbeeJSON.parse(String(decoding: data, as: UTF8.self))
        do {
            guard try await store.load(origin: storageKey) == previous else { throw ZigbeeError("zigbee_record_changed") }
            try await store.save(origin: storageKey, data: data)
            guard try await store.load(origin: storageKey) == data else { throw ZigbeeError("zigbee_storage_failed") }
            previous = data; loaded = true
        } catch is CancellationError { throw CancellationError() } catch let error as ZigbeeError { throw error } catch { throw ZigbeeError("zigbee_storage_failed") }
    }
    public func records(space: String) async throws -> [ZigbeeRecord] {
        try ObservationJSON.id(.string(space)); return try await locked { try await load().filter { ObservationJSON.string($0.request, "space_id") == space } }
    }
    public func coordinators(space: String) async throws -> [ZigbeeCoordinator] {
        try ObservationJSON.id(.string(space)); return try ZigbeeJSON.coordinators(await gateway.observationCall(space: space, suffix: "/zigbee-coordinators"))
    }
    public func history(space: String) async throws -> [ZigbeeRecord] {
        try ObservationJSON.id(.string(space)); return try ZigbeeJSON.history(await gateway.observationCall(space: space, suffix: "/zigbee-operations"), space: space)
    }
    public func prepare(space: String, coordinator: String, seconds: Int) async throws -> ZigbeePreparation {
        guard (0...120).contains(seconds) else { throw ZigbeeError("invalid_zigbee_change") }
        return try await locked {
            let saved = try await load().filter { ObservationJSON.string($0.request, "space_id") == space }
            guard let selected = try await coordinators(space: space).first(where: { $0.id == coordinator }) else { throw ZigbeeError("zigbee_review_changed") }
            let preparation = ZigbeePreparation(coordinator: selected, change: .object(["coordinator_id": .string(coordinator), "expected_revision": .string(selected.revision), "duration_seconds": .integer(seconds)]))
            try ZigbeeJSON.canOpen(preparation, records: saved, history: await history(space: space), now: now()); return preparation
        }
    }
    public func submit(space: String, preparation: ZigbeePreparation, expiresAt: Date, key: String = UUID().uuidString.lowercased()) async throws -> ZigbeeRecord {
        try await locked {
            try ObservationJSON.id(.string(space)); try ObservationJSON.id(.string(key)); try ZigbeeJSON.change(preparation.change)
            let request = JSONValue.object(["space_id": .string(space), "idempotency_key": .string(key), "change": preparation.change]), records = try await load()
            if let old = records.first(where: { $0.request == request || $0.id == key && ObservationJSON.string($0.request, "space_id") == space }) {
                guard old.request == request else { throw ZigbeeError("zigbee_record_changed") }; return try await resolveSaved(records, old)
            }
            guard records.count < 256 else { throw ZigbeeError("zigbee_operation_capacity") }
            guard try await coordinators(space: space).contains(preparation.coordinator) else { throw ZigbeeError("zigbee_review_changed") }
            try ZigbeeJSON.canOpen(preparation, records: records.filter { ObservationJSON.string($0.request, "space_id") == space }, history: await history(space: space), now: now())
            try Task.checkCancellation(); guard expiresAt > now() else { throw ZigbeeError("zigbee_review_expired") }
            let record = ZigbeeRecord(request: request, result: nil), next = records + [record]
            try await persist(next); try Task.checkCancellation(); guard expiresAt > now() else { throw ZigbeeError("zigbee_review_expired") }
            let result = try await gateway.observationCall(space: space, suffix: "/zigbee-operations", method: "POST", body: preparation.change, key: key, query: true)
            let resolved = try ZigbeeJSON.operation(result, expected: request)
            try await persist(next.map { $0.request == request ? resolved : $0 }); return resolved
        }
    }
    private func resolveSaved(_ records: [ZigbeeRecord], _ old: ZigbeeRecord) async throws -> ZigbeeRecord {
        let value = try await gateway.observationCall(space: ObservationJSON.string(old.request, "space_id"), suffix: "/zigbee-operations/by-key/" + old.id)
        let result = try ZigbeeJSON.operation(value, expected: old.request, previous: old.result)
        try await persist(records.map { $0.request == old.request ? result : $0 }); return result
    }
    public func resolve(space: String, key: String) async throws -> ZigbeeRecord {
        try ObservationJSON.id(.string(space)); try ObservationJSON.id(.string(key))
        return try await locked {
            let records = try await load()
            if let record = records.first(where: { $0.id == key && ObservationJSON.string($0.request, "space_id") == space }) { return try await resolveSaved(records, record) }
            guard let historical = try await history(space: space).first(where: { $0.id == key }) else { throw ZigbeeError("zigbee_record_missing") }
            let result = try await gateway.observationCall(space: space, suffix: "/zigbee-operations/by-key/" + key)
            return try ZigbeeJSON.operation(result, expected: historical.request, previous: historical.result)
        }
    }
}
