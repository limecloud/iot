import Foundation

public struct OtaError: Error, Sendable {
    public let code: String
    public var message: String {
        switch code {
        case "ota_storage_failed", "ota_record_changed": "无法保存或读取本机升级记录，请检查安全存储"
        case "ota_pending_operation": "请先查询同一设备或任务的原操作"
        case "ota_capacity": "本机升级记录已满"
        case "ota_fingerprint_mismatch": "公钥指纹与独立核对值不一致"
        case "ota_unknown": "结果未知，请查询升级原操作"
        case "ota_busy": "已有升级操作正在处理"
        default: "升级材料或响应未通过校验"
        }
    }
}

// OTA 合同只含安全整数。严格边界与摘要用于绑定原请求，验签及设备策略由 Rust 执行。
public enum OtaJSON {
    static func fail() -> OtaError { OtaError(code: "invalid_ota_document") }
    public static func parse(_ text: String, response: Bool = false) throws -> JSONValue {
        do { return try IntegerJSON.parse(text, maxBytes: response ? 2_000_000 : 16384, maxDepth: response ? 24 : 16, maxNodes: response ? 65536 : 2048) }
        catch { throw fail() }
    }
    public static func canonical(_ value: JSONValue) -> String { IntegerJSON.canonical(value) }
    public static func digest(_ value: JSONValue) -> String { IntegerJSON.digest(value) }
    static func require(_ valid: @autoclosure () throws -> Bool) throws { guard try valid() else { throw fail() } }
    static func object(_ v: JSONValue?) throws -> [String: JSONValue] { guard case .object(let o) = v else { throw fail() }; return o }
    static func fields(_ v: JSONValue?, _ names: String) throws -> [String: JSONValue] { let o = try object(v); try require(Set(o.keys) == Set(names.split(separator: ",").map(String.init))); return o }
    static func text(_ v: JSONValue?) throws -> String { guard case .string(let s) = v else { throw fail() }; return s }
    static func id(_ v: JSONValue?, _ prefix: String = "") throws { let s = try text(v); try require(s.range(of: #"^[A-Za-z0-9_-]{1,128}$"#, options: .regularExpression) != nil && s.hasPrefix(prefix)) }
    static func hex(_ v: JSONValue?, _ prefix: String = "sha256:") throws { let s = try text(v); try require(s.hasPrefix(prefix) && s.dropFirst(prefix.count).count == 64 && s.dropFirst(prefix.count).allSatisfy { "abcdef0123456789".contains($0) }) }
    static func time(_ v: JSONValue?) throws -> Date {
        let s = try text(v); let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }; f.formatOptions = [.withInternetDateTime]
        guard let d = f.date(from: s) else { throw fail() }; return d
    }
    static func bool(_ v: JSONValue?) throws -> Bool { guard case .bool(let b) = v else { throw fail() }; return b }
    static func integer(_ v: JSONValue?) throws -> Int { guard case .integer(let n) = v, n >= 0, n <= 9007199254740991 else { throw fail() }; return n }
    static func reason(_ v: JSONValue?) throws { if v != .null { try require(text(v).range(of: #"^[a-z][a-z0-9_]{0,63}$"#, options: .regularExpression) != nil) } }
    public static func change(_ text: String) throws -> JSONValue { let v = try parse(text); try change(v); return v }
    static func change(_ value: JSONValue) throws {
        let v = try object(value)
        switch try text(v["type"]) {
        case "trust.add": _ = try fields(value, "type,trust,expected_signing_key_id"); _ = try object(v["trust"]); try hex(v["expected_signing_key_id"])
        case "trust.revoke": _ = try fields(value, "type,trust_id,expected_revision"); try hex(v["trust_id"], "fwtrust-"); try id(v["expected_revision"])
        case "tasks.plan": _ = try fields(value, "type,device_id,trust_id,manifest,expires_at"); try id(v["device_id"]); try hex(v["trust_id"], "fwtrust-"); _ = try object(v["manifest"]); _ = try time(v["expires_at"])
        case "tasks.approve", "tasks.execute", "tasks.reconcile", "tasks.cancel": _ = try fields(value, "type,task_id,expected_revision"); try id(v["task_id"], "ota-"); try id(v["expected_revision"])
        default: throw fail()
        }
    }
    static func operation(_ value: JSONValue, expected: JSONValue) throws {
        let v = try fields(value, "operation_id,request,request_digest,status,reason,resource,created_at")
        try id(v["operation_id"], "otaop-"); _ = try time(v["created_at"])
        try require(v["request"] == expected && v["request_digest"] == .string(digest(expected)))
        let change = try object(object(expected)["change"]), type = try text(change["type"]), status = try text(v["status"])
        if status != "applied" {
            try require(["rejected", "conflict"].contains(status) && v["resource"] == .null && v["reason"] != .null)
            try reason(v["reason"]); try require((status == "conflict") == (v["reason"] == .string("revision_conflict"))); return
        }
        try require(v["reason"] == .null)
        let r = try fields(v["resource"], "kind,id,revision"); try id(r["revision"])
        if type.hasPrefix("trust.") {
            try require(r["kind"] == .string("firmware_trust")); try hex(r["id"], "fwtrust-")
            if type == "trust.add" { try require(r["id"] == .string("fwtrust-" + digest(change["trust"]!).dropFirst(7)) && change["expected_signing_key_id"] == object(change["trust"])["signing_key_id"]) }
            else { try require(r["id"] == change["trust_id"]) }
        } else {
            try require(r["kind"] == .string("ota_task")); try id(r["id"], "ota-")
            if type != "tasks.plan" { try require(r["id"] == change["task_id"]) }
        }
    }
    static func trust(_ value: JSONValue) throws {
        let v = try fields(value, "trust_id,revision,trust,active,created_at,revoked_at"); try id(v["revision"])
        let t = try fields(v["trust"], "schema,version,purpose,signing_key_id,public_key,product_ids,download_origins,minimum_security_epoch,minimum_battery_percent,revoked_artifact_ids,not_before,expires_at")
        try require(t["schema"] == .string("limeiot.ota-trust") && t["version"] == .integer(1) && t["purpose"] == .string("device-firmware"))
        try hex(t["signing_key_id"]); _ = try text(t["public_key"])
        for key in ["product_ids", "download_origins", "revoked_artifact_ids"] {
            guard case .array(let values) = t[key], values.count <= 128 else { throw fail() }
            let strings = try values.map(text); try require(Set(strings).count == strings.count && (key == "revoked_artifact_ids" || !values.isEmpty))
        }
        _ = try integer(t["minimum_security_epoch"]); try require(integer(t["minimum_battery_percent"]) <= 100)
        try require(time(t["expires_at"]) > time(t["not_before"]))
        try require(v["trust_id"] == .string("fwtrust-" + digest(v["trust"]!).dropFirst(7)))
        try require(bool(v["active"]) == (v["revoked_at"] == .null))
        let created = try time(v["created_at"]); if try !bool(v["active"]) { try require(time(v["revoked_at"]) >= created) }
    }
    static func info(_ value: JSONValue?, device: JSONValue?) throws {
        let v = try fields(value, "device,boot_id,session_id,seq,received_at"); try id(v["boot_id"]); try id(v["session_id"]); _ = try integer(v["seq"]); _ = try time(v["received_at"])
        let d = try fields(v["device"], "device_id,product_id,architecture,chip,board,hardware_revision,firmware_version,bootloader_version,protocol_version,model_revision,security_epoch,ota_capacity_bytes,external_power,battery_percent,safe_to_update,pending_update")
        try require(d["device_id"] == device && d["protocol_version"] == .integer(1)); try hex(d["model_revision"])
        for key in ["product_id", "architecture", "chip", "board", "hardware_revision", "firmware_version", "bootloader_version"] { _ = try text(d[key]) }
        for key in ["external_power", "safe_to_update", "pending_update"] { _ = try bool(d[key]) }
        _ = try integer(d["security_epoch"]); _ = try integer(d["ota_capacity_bytes"])
        if d["battery_percent"] != .null { try require(integer(d["battery_percent"]) <= 100) }
    }
    static func manifest(_ value: JSONValue?) throws {
        let v = try fields(value, "schema,version,algorithm,signing_key_id,statement,signature")
        try require(v["schema"] == .string("limeiot.ota-manifest") && v["version"] == .integer(1) && v["algorithm"] == .string("Ed25519")); try hex(v["signing_key_id"]); _ = try text(v["signature"])
        let s = try fields(v["statement"], "artifact_id,kind,target,version,compatibility,size_bytes,sha256,security_epoch,download,issued_at,expires_at")
        try hex(s["artifact_id"], "artifact-"); try require(s["kind"] == .string("device-firmware")); _ = try text(s["version"]); try hex(s["sha256"]); _ = try integer(s["security_epoch"])
        try require((1...33554432).contains(integer(s["size_bytes"])) && time(s["expires_at"]) > time(s["issued_at"]))
        let t = try fields(s["target"], "product_id,architecture,chip,board,hardware_revisions")
        for key in ["product_id", "architecture", "chip", "board"] { _ = try text(t[key]) }
        let c = try fields(s["compatibility"], "protocol_version,model_revisions,minimum_bootloader_version,from_versions"); try require(c["protocol_version"] == .integer(1)); _ = try text(c["minimum_bootloader_version"])
        for values in [t["hardware_revisions"], c["model_revisions"], c["from_versions"]] {
            guard case .array(let items) = values, (1...16).contains(items.count) else { throw fail() }; for item in items { _ = try text(item) }
        }
        let d = try fields(s["download"], "url,redirects"); _ = try text(d["url"]); try require(d["redirects"] == .bool(false))
    }
    static func task(_ value: JSONValue) throws {
        let v = try fields(value, "task_id,revision,device_id,trust_id,trust_revision,manifest,manifest_digest,baseline,created_at,expires_at,status,approval,execution,reason")
        try id(v["task_id"], "ota-"); try id(v["revision"]); try id(v["device_id"]); try hex(v["trust_id"], "fwtrust-"); try id(v["trust_revision"])
        try manifest(v["manifest"]); try require(v["manifest_digest"] == .string(digest(v["manifest"]!)))
        try require(time(v["expires_at"]) > time(v["created_at"])); try reason(v["reason"])
        let status = try text(v["status"]); try require(OtaTask.statuses[status] != nil)
        try info(v["baseline"], device: v["device_id"])
        try require((status == "approved" || v["execution"] != .null) == (v["approval"] != .null))
        if v["approval"] != .null { let a = try fields(v["approval"], "approved_at,device_info"); _ = try time(a["approved_at"]); try info(a["device_info"], device: v["device_id"]) }
        try execution(v)
    }
    static func envelope(_ value: JSONValue?, kind: String, task: [String: JSONValue], upstream: Bool = false) throws -> [String: JSONValue] {
        let v = try fields(value, "v,kind,message_id,device_id,model_revision,boot_id,session_id,body" + (upstream ? ",seq" : ""))
        try require(v["v"] == .integer(1) && v["kind"] == .string(kind) && v["device_id"] == task["device_id"] && v["model_revision"] == object(object(task["baseline"])["device"])["model_revision"])
        try id(v["message_id"]); try id(v["boot_id"]); try id(v["session_id"]); _ = try object(v["body"]); if upstream { _ = try integer(v["seq"]) }; return v
    }
    static func execution(_ t: [String: JSONValue]) throws {
        let status = try text(t["status"])
        if t["execution"] == .null { try require(!["executing", "unknown", "succeeded", "failed"].contains(status)); return }
        try require(["executing", "unknown", "succeeded", "failed"].contains(status))
        let x = try fields(t["execution"], "envelope,request_digest,prepared_at,attempted_at,receipt,query,query_count"), approval = try object(t["approval"]), prepared = try time(x["prepared_at"])
        try require(prepared >= time(approval["approved_at"]) && prepared < time(t["expires_at"]))
        if x["attempted_at"] != .null { try require(time(x["attempted_at"]) >= prepared && time(x["attempted_at"]) < time(t["expires_at"])) }
        try require(integer(x["query_count"]) <= 32 && (integer(x["query_count"]) > 0) == (x["query"] != .null))
        let install = try envelope(x["envelope"], kind: "ota_install", task: t), body = try fields(install["body"], "task_id,execution_id,manifest_digest,manifest,expires_at"), info = try object(approval["device_info"])
        try require(x["request_digest"] == .string(digest(x["envelope"]!)) && install["boot_id"] == info["boot_id"] && install["session_id"] == info["session_id"])
        try id(body["execution_id"], "otaexec-")
        try require(body["task_id"] == t["task_id"] && body["manifest_digest"] == t["manifest_digest"] && body["manifest"] == t["manifest"] && body["expires_at"] == t["expires_at"] && (status != "unknown" || x["attempted_at"] != .null))
        if x["receipt"] != .null {
            let receipt = try fields(x["receipt"], "envelope,received_at")
            try require(x["attempted_at"] != .null && time(receipt["received_at"]) >= time(x["attempted_at"]))
            let report = try envelope(receipt["envelope"], kind: "ota_result", task: t, upstream: true), r = try fields(report["body"], "task_id,execution_id,request_digest,manifest_digest,status,firmware_version,security_epoch,image_sha256,pending_update,error")
            let rs = try text(r["status"]), success = rs == "succeeded", failed = ["rejected", "failed", "rolled_back"].contains(rs)
            try require(["installing", "awaiting_boot", "succeeded", "rejected", "failed", "rolled_back"].contains(rs))
            try require(r["task_id"] == t["task_id"] && r["execution_id"] == body["execution_id"] && r["request_digest"] == x["request_digest"] && r["manifest_digest"] == t["manifest_digest"])
            try hex(r["image_sha256"]); try require(r["pending_update"] == .bool(false) && failed == (r["error"] != .null)); try reason(r["error"])
            let expected = try success ? object(object(t["manifest"])["statement"]) : object(object(t["baseline"])["device"])
            try require(r["firmware_version"] == expected[success ? "version" : "firmware_version"] && r["security_epoch"] == expected["security_epoch"])
            if success { try require(r["image_sha256"] == expected["sha256"] && report["boot_id"] != install["boot_id"]) }
            if rs == "rolled_back" { try require(report["boot_id"] != install["boot_id"]) }
            if !success && !failed { try require(report["boot_id"] == install["boot_id"]) }
            try require(status == (success ? "succeeded" : failed ? "failed" : "executing") || (status == "unknown" && !success && !failed))
        } else { try require(status != "succeeded" && !(status == "failed" && x["attempted_at"] != .null)) }
        if x["query"] != .null {
            let q = try fields(x["query"], "envelope,prepared_at,attempted"); _ = try bool(q["attempted"])
            try require(x["attempted_at"] != .null && time(q["prepared_at"]) >= time(x["attempted_at"]))
            let e = try envelope(q["envelope"], kind: "ota_query", task: t), b = try fields(e["body"], "task_id,execution_id,request_digest,manifest_digest,expires_at")
            try require(b["task_id"] == t["task_id"] && b["execution_id"] == body["execution_id"] && b["request_digest"] == x["request_digest"] && b["manifest_digest"] == t["manifest_digest"] && time(b["expires_at"]) == time(q["prepared_at"]).addingTimeInterval(30))
        }
    }
}

public struct OtaTask: Sendable, Identifiable {
    public let document: JSONValue
    public var id: String { (try? OtaJSON.text(OtaJSON.object(document)["task_id"])) ?? "" }
    public var revision: String { (try? OtaJSON.text(OtaJSON.object(document)["revision"])) ?? "" }
    public var deviceId: String { (try? OtaJSON.text(OtaJSON.object(document)["device_id"])) ?? "" }
    public var status: String { (try? OtaJSON.text(OtaJSON.object(document)["status"])) ?? "" }
    public var statusText: String { Self.statuses[status] ?? "结果未知" }
    public var targetVersion: String { (try? OtaJSON.text(OtaJSON.object(OtaJSON.object(OtaJSON.object(document)["manifest"])["statement"])["version"])) ?? "" }
    public var allowedActions: [String] {
        switch status {
        case "planned": ["tasks.approve", "tasks.cancel"]
        case "approved": ["tasks.execute", "tasks.cancel"]
        case "executing", "unknown": ((try? OtaJSON.integer(OtaJSON.object(OtaJSON.object(document)["execution"])["query_count"])) ?? 32) < 32 ? ["tasks.reconcile"] : []
        default: []
        }
    }
    static let statuses = ["planned": "待批准", "approved": "已批准，尚未安装", "executing": "正在安装", "unknown": "结果未知", "succeeded": "升级成功", "failed": "升级失败", "cancelled": "已取消", "expired": "已过期", "invalidated": "已失效"]
}
public struct FirmwareTrust: Sendable, Identifiable {
    public let document: JSONValue
    public var id: String { (try? OtaJSON.text(OtaJSON.object(document)["trust_id"])) ?? "" }
    public var revision: String { (try? OtaJSON.text(OtaJSON.object(document)["revision"])) ?? "" }
    public var active: Bool { (try? OtaJSON.bool(OtaJSON.object(document)["active"])) ?? false }
}
public struct OtaRecord: Sendable, Identifiable {
    public let request: JSONValue
    public let result: JSONValue?
    public var id: String { (try? OtaJSON.text(OtaJSON.object(request)["idempotency_key"])) ?? "" }
    public var type: String { (try? OtaJSON.text(OtaJSON.object(OtaJSON.object(request)["change"])["type"])) ?? "" }
    public var statusText: String {
        guard let result, let v = try? OtaJSON.object(result) else { return "结果未知" }
        return v["status"] == .string("applied") ? "决定已保存" : v["status"] == .string("rejected") ? "操作已拒绝" : "修订冲突"
    }
}

public enum OtaChanges {
    public static let labels = ["tasks.approve": "批准升级", "tasks.execute": "开始安装", "tasks.reconcile": "查询设备结果", "tasks.cancel": "取消计划"]
    public static func trust(material: String, fingerprint: String) throws -> JSONValue {
        let v = JSONValue.object(["type": .string("trust.add"), "trust": try OtaJSON.parse(material), "expected_signing_key_id": .string(fingerprint.trimmingCharacters(in: .whitespacesAndNewlines))]); try OtaJSON.change(v); return v
    }
    public static func plan(deviceId: String, trustId: String, manifest: String, now: Date = .now) throws -> JSONValue {
        let v = JSONValue.object(["type": .string("tasks.plan"), "device_id": .string(deviceId), "trust_id": .string(trustId), "manifest": try OtaJSON.parse(manifest), "expires_at": .string(ISO8601DateFormatter().string(from: now.addingTimeInterval(600)))]); try OtaJSON.change(v); return v
    }
    public static func transition(task: OtaTask, type: String) throws -> JSONValue {
        try OtaJSON.require(task.allowedActions.contains(type))
        return .object(["type": .string(type), "task_id": .string(task.id), "expected_revision": .string(task.revision)])
    }
    public static func revoke(trust: FirmwareTrust) -> JSONValue { .object(["type": .string("trust.revoke"), "trust_id": .string(trust.id), "expected_revision": .string(trust.revision)]) }
}
