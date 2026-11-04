import Foundation

public enum ObservationProfile: String, Sendable, CaseIterable { case environment, onOff = "on_off" }

public struct ObservationError: Error, Sendable {
    public let code: String
    public init(code: String) { self.code = code }
    public var message: String { [
        "invalid_observation_document": "接入资料未通过核对，请重新读取",
        "observation_storage_failed": "无法保存接入记录，请检查本机安全存储",
        "observation_record_changed": "本机接入记录已变化，请重新打开连接",
        "observation_pending_operation": "此设备或来源有未确认操作，请查询原操作",
        "observation_capacity": "本机接入记录已满",
        "observation_busy": "正在处理接入操作",
        "observation_record_missing": "未找到本机原请求",
        "observation_review_expired": "核对已失效，请重新查询设备"
    ][code] ?? "接入操作尚未确认，请查询原操作" }
}

public struct ObservationCandidate: Sendable, Equatable, Identifiable {
    public let document: JSONValue
    public var profile: ObservationProfile { ObservationJSON.map(document)["write_paths"] == nil ? .environment : .onOff }
    public var id: String { ObservationJSON.string(ObservationJSON.map(document)["source"], "adapter_id") }
    public var model: String { ObservationJSON.string(ObservationJSON.map(document)["signature"], "model") }
    public var manufacturer: String { ObservationJSON.string(ObservationJSON.map(document)["signature"], "manufacturer") }
    public var ieee: String { ObservationJSON.string(ObservationJSON.map(document)["target"], "ieee_address") }
    public var endpoint: Int { ObservationJSON.number(ObservationJSON.map(document)["target"], "endpoint") }
    public var expiresAt: Date { try! ObservationJSON.time(ObservationJSON.map(document)["expires_at"]) }
}
public struct ObservationCoordinator: Sendable, Equatable, Identifiable {
    public let document: JSONValue
    public var id: String { ObservationJSON.string(document, "coordinator_id") }
    public var ieee: String { ObservationJSON.string(document, "coordinator_ieee") }
}
public struct ObservationCandidates: Sendable {
    public let coordinators: [ObservationCoordinator]
    public let items: [ObservationCandidate]
}
public struct ObservationBinding: Sendable, Equatable {
    public let document: JSONValue
    public var revision: String { ObservationJSON.string(document, "revision") }
    public var device: String { ObservationJSON.string(document, "device_id") }
    public var managed: Bool { ObservationJSON.map(document)["binding"] != .null }
    public var active: Bool { ObservationJSON.map(ObservationJSON.map(document)["binding"])["active"] == .bool(true) }
    public var profile: ObservationProfile { ObservationJSON.map(ObservationJSON.map(document)["binding"])["write_paths"] == nil ? .environment : .onOff }
    public var target: JSONValue? { ObservationJSON.map(ObservationJSON.map(ObservationJSON.map(document)["binding"])["manifest"])["target"] }
    public var coordinatorIEEE: String { ObservationJSON.string(target, "coordinator_ieee") }
    public var ieee: String { ObservationJSON.string(target, "ieee_address") }
    public var endpoint: Int { ObservationJSON.number(target, "endpoint") }
}
public struct ObservationRecord: Sendable, Equatable, Identifiable {
    public let request: JSONValue
    public let result: JSONValue?
    public var id: String { ObservationJSON.string(request, "idempotency_key") }
    public var device: String { ObservationJSON.string(ObservationJSON.map(request)["change"], "device_id") }
    public var pending: Bool { result == nil }
    public var status: String { result.map { ObservationJSON.string($0, "status") } ?? "unknown" }
    public var statusText: String { ["applied": "已生效", "rejected": "未受理", "conflict": "设备资料已变化", "unknown": "结果待确认"][status] ?? "结果待确认" }
}

// 使用共用的有界JSON与JCS，只在本领域核对字段、来源和耐久决定。
public enum ObservationJSON {
    static let onOffRevision = "sha256:a5ed590038c2d0c13e183a1cc7aeb166fbb9dc529d92366631978943c47433b0"
    static func fail() -> ObservationError { .init(code: "invalid_observation_document") }
    static func require(_ value: Bool) throws { guard value else { throw fail() } }
    static func map(_ value: JSONValue?) -> [String: JSONValue] { if case .object(let items) = value { items } else { [:] } }
    static func string(_ value: JSONValue?, _ key: String) -> String { if case .string(let text) = map(value)[key] { text } else { "" } }
    static func number(_ value: JSONValue?, _ key: String) -> Int { if case .integer(let n) = map(value)[key] { n } else { -1 } }
    static func fields(_ value: JSONValue?, _ names: String) throws -> [String: JSONValue] {
        guard case .object(let items) = value, Set(items.keys) == Set(names.split(separator: ",").map(String.init)) else { throw fail() }; return items
    }
    static func text(_ value: JSONValue?) throws -> String { guard case .string(let text) = value else { throw fail() }; return text }
    static func matches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) == value.startIndex..<value.endIndex }
    static func id(_ value: JSONValue?) throws { try require(matches(try text(value), "[A-Za-z0-9_-]{1,128}")) }
    static func hash(_ value: JSONValue?) throws { try require(matches(try text(value), "sha256:[a-f0-9]{64}")) }
    static func integer(_ value: JSONValue?, _ range: ClosedRange<Int>) throws { guard case .integer(let n) = value, range.contains(n) else { throw fail() } }
    static func ieee(_ value: JSONValue?) throws { let s = try text(value); try require(matches(s, "[a-f0-9]{16}") && !["0000000000000000", "ffffffffffffffff"].contains(s)) }
    static func time(_ value: JSONValue?) throws -> Date {
        let text = try text(value), formatter = ISO8601DateFormatter()
        try require(matches(text, #"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})"#))
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        guard let date = formatter.date(from: text) else { throw fail() }; return date
    }
    static func source(_ value: JSONValue?) throws { let s = try fields(value, "adapter_id,revision"); try id(s["adapter_id"]); try hash(s["revision"]) }
    public static func parse(_ text: String, response: Bool = false) throws -> JSONValue {
        do { return try IntegerJSON.parse(text, maxBytes: response ? 2_000_000 : 4096, maxDepth: response ? 24 : 8, maxNodes: response ? 65536 : 256) } catch { throw fail() }
    }
    public static func canonical(_ value: JSONValue) -> String { IntegerJSON.canonical(value) }
    public static func digest(_ value: JSONValue) -> String { IntegerJSON.digest(value) }
    public static func query(coordinator: String, ieee: String, endpoint: Int, profile: ObservationProfile = .environment) throws -> JSONValue {
        var fields: [String: JSONValue] = ["coordinator_id": .string(coordinator), "ieee_address": .string(ieee), "endpoint": .integer(endpoint)]
        if profile == .onOff { fields["profile"] = .string(profile.rawValue) }
        let value = JSONValue.object(fields)
        try id(.string(coordinator)); try self.ieee(.string(ieee)); try integer(.integer(endpoint), 1...240); return value
    }
    public static func change(_ value: JSONValue) throws {
        let c = map(value), revoke = c["type"] == .string("sources.revoke")
        _ = try fields(value, revoke ? "type,device_id,expected_binding_revision" : "type,device_id,source,expected_binding_revision,expected_model_revision")
        try id(c["device_id"]); try hash(c["expected_binding_revision"])
        if !revoke { try require(c["type"] == .string("sources.bind")); try source(c["source"]); try hash(c["expected_model_revision"]) }
    }
    public static func candidate(_ value: JSONValue) throws -> ObservationCandidate {
        let writable = map(value)["write_paths"] != nil
        let c = try fields(value, "source,model_revision,target,manufacturer_code,signature,observed_at,expires_at,protocol,evidence" + (writable ? ",write_paths" : ""))
        if writable { try require(c["write_paths"] == .array([.string("light.power")]) && c["model_revision"] == .string(onOffRevision)) }
        try source(c["source"]); try hash(c["model_revision"]); try integer(c["manufacturer_code"], 0...65535)
        let target = try fields(c["target"], "coordinator_ieee,ieee_address,endpoint")
        try ieee(target["coordinator_ieee"]); try ieee(target["ieee_address"]); try require(target["coordinator_ieee"] != target["ieee_address"]); try integer(target["endpoint"], 1...240)
        let signature = try fields(c["signature"], "manufacturer,model,application_version,hardware_version")
        for key in ["manufacturer", "model"] {
            let s = try text(signature[key]); try require(!s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && s.utf8.count <= 32 && !s.unicodeScalars.contains { $0.value < 32 || (127...159).contains($0.value) })
        }
        try integer(signature["application_version"], 0...255); try integer(signature["hardware_version"], 0...255)
        let duration = try time(c["expires_at"]).timeIntervalSince(time(c["observed_at"]))
        try require(duration > 0 && duration <= 60 && c["protocol"] == .string("zigbee-znp") && c["evidence"] == .string("unauthenticated_protocol"))
        let manifest = JSONValue.object(["mapping": .string(writable ? "znp-on-off-v1" : "znp-environment-v1"), "target": c["target"]!, "manufacturer_code": c["manufacturer_code"]!, "signature": c["signature"]!, "model_revision": c["model_revision"]!])
        try require(map(c["source"])["adapter_id"] == .string("znp-" + digest(c["target"]!).dropFirst(7)) && map(c["source"])["revision"] == .string(digest(manifest)))
        return ObservationCandidate(document: value)
    }
    public static func candidates(_ value: JSONValue) throws -> ObservationCandidates {
        let p = try fields(value, "coordinators,items,next_cursor")
        guard p["next_cursor"] == .null, case .array(let coordinators) = p["coordinators"], coordinators.count <= 4, case .array(let items) = p["items"], items.count <= 64 else { throw fail() }
        for item in coordinators { let c = try fields(item, "coordinator_id,coordinator_ieee,timeout_ms,protocol"); try id(c["coordinator_id"]); try ieee(c["coordinator_ieee"]); try integer(c["timeout_ms"], 100...30000); try require(c["protocol"] == .string("zigbee-znp")) }
        let cs = coordinators.map { ObservationCoordinator(document: $0) }, checked = try items.map(candidate)
        try require(Set(cs.map(\.id)).count == cs.count && Set(cs.map(\.ieee)).count == cs.count && Set(checked.map(\.id)).count == checked.count)
        for item in checked { try require(cs.contains { $0.ieee == string(map(item.document)["target"], "coordinator_ieee") }) }
        return ObservationCandidates(coordinators: cs, items: checked)
    }
    public static func binding(_ value: JSONValue, device: String? = nil) throws -> ObservationBinding {
        let v = try fields(value, "device_id,revision,binding"); try id(v["device_id"]); try hash(v["revision"])
        if let device { try require(v["device_id"] == .string(device)) }
        if v["binding"] != .null {
            let writable = map(v["binding"])["write_paths"] != nil
            let b = try fields(v["binding"], "policy,manifest,active,generation,changed_at" + (writable ? ",write_paths" : "")), p = try fields(b["policy"], "device_id,model_revision,source")
            if writable { try require(b["write_paths"] == .array([.string("light.power")]) && p["model_revision"] == .string(onOffRevision) && map(b["manifest"])["model_revision"] == .string(onOffRevision) && map(b["manifest"])["mapping"] == .string("znp-on-off-v1")) }
            try require(p["device_id"] == v["device_id"]); try hash(p["model_revision"]); try source(p["source"])
            guard case .bool = b["active"], case .object(let manifest) = b["manifest"], !manifest.isEmpty else { throw fail() }
            _ = try parse(canonical(b["manifest"]!)); try require(matches(try text(b["generation"]), "observationop-[A-Za-z0-9_-]{1,100}")); _ = try time(b["changed_at"])
            try require(digest(b["manifest"]!) == string(p["source"], "revision"))
        }
        try require(digest(.array([.string("observation-binding-v1"), v["device_id"]!, v["binding"]!])) == text(v["revision"]))
        return ObservationBinding(document: value)
    }
    public static func request(_ value: JSONValue) throws {
        let r = try fields(value, "space_id,idempotency_key,change"); try id(r["space_id"]); try id(r["idempotency_key"]); try change(r["change"]!)
    }
    public static func operation(_ value: JSONValue, expected: JSONValue? = nil) throws {
        let o = try fields(value, "operation_id,sequence,request,request_digest,status,reason,result,created_at")
        try require(matches(try text(o["operation_id"]), "observationop-[A-Za-z0-9_-]{1,100}")); try integer(o["sequence"], 1...256); try request(o["request"]!); _ = try time(o["created_at"])
        try require(o["request_digest"] == .string(digest(o["request"]!)) && (expected == nil || o["request"] == expected))
        let c = map(map(o["request"])["change"])
        if o["status"] == .string("applied") {
            let view = try binding(o["result"]!, device: text(c["device_id"])), b = map(map(view.document)["binding"]), p = map(b["policy"])
            try require(o["reason"] == .null && view.managed && b["generation"] == o["operation_id"] && b["changed_at"] == o["created_at"] && view.revision != text(c["expected_binding_revision"]))
            if c["type"] == .string("sources.bind") { try require(view.active && p["source"] == c["source"] && p["model_revision"] == c["expected_model_revision"]) }
            else { try require(!view.active) }
        } else {
            let status = try text(o["status"]), reason = try text(o["reason"])
            try require(["rejected", "conflict"].contains(status) && o["result"] == .null && matches(reason, "[a-z][a-z0-9_]{0,63}") && (status == "conflict") == (reason == "revision_conflict"))
        }
    }
    public static func bind(device: String, candidate: ObservationCandidate, binding: ObservationBinding) throws -> JSONValue {
        try require(device == binding.device)
        let c = map(candidate.document), change = JSONValue.object(["type": .string("sources.bind"), "device_id": .string(device), "source": c["source"]!, "expected_binding_revision": .string(binding.revision), "expected_model_revision": c["model_revision"]!])
        try self.change(change); return change
    }
    public static func revoke(_ binding: ObservationBinding) throws -> JSONValue {
        try require(binding.managed && binding.active)
        return .object(["type": .string("sources.revoke"), "device_id": .string(binding.device), "expected_binding_revision": .string(binding.revision)])
    }
}
