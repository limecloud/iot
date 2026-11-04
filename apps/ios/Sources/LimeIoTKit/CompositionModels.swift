import Foundation
import CryptoKit

public struct CompositionError: Error, Sendable, Equatable {
    public let code: String
    public init(code: String) { self.code = code }
    public var message: String { ["invalid_composition": "组合包格式不正确", "invalid_composition_bindings": "请为每个模块选择不同的兼容设备", "composition_model_mismatch": "设备能力已变化，请重新选择并预演", "composition_record_unavailable": "无法核对本地提交记录，已暂停新提交", "composition_busy": "组合操作正在进行，请稍后查询", "composition_preview_required": "请重新预演组合", "composition_pending": "原提交结果待核实", "composition_not_found": "未找到本地组合记录"][code] ?? "组合操作未完成" }
}

// 组合包沿用有界JSON解析；小数的摘要采用ECMAScript数值表示，不改变媒体/OTA整数合同。
enum CompositionJSON {
    static func canonical(_ value: JSONValue) -> String {
        switch value {
        case .object(let v): return "{" + v.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }.map { JSONValue.string($0).jsonText + ":" + canonical(v[$0]!) }.joined(separator: ",") + "}"
        case .array(let v): return "[" + v.map(canonical).joined(separator: ",") + "]"
        case .number(let v):
            if v == 0 { return "0" }
            let sign = v < 0 ? "-" : "", parts = String(abs(v)).lowercased().split(separator: "e")
            let mantissa = String(parts[0]), exponent = parts.count == 2 ? Int(parts[1])! : 0
            let segments = mantissa.split(separator: "."), leading = segments[0].count
            var digits = segments.joined(); while digits.last == "0" && digits.count > 1 { digits.removeLast() }
            let point = leading + exponent
            if abs(v) >= 0.000001 && abs(v) < 1e21 {
                if point <= 0 { return sign + "0." + String(repeating: "0", count: -point) + digits }
                if point >= digits.count { return sign + digits + String(repeating: "0", count: point - digits.count) }
                let i = digits.index(digits.startIndex, offsetBy: point); return sign + digits[..<i] + "." + digits[i...]
            }
            let e = point - 1, tail = digits.dropFirst()
            return sign + String(digits.first!) + (tail.isEmpty ? "" : "." + tail) + "e" + (e >= 0 ? "+" : "") + String(e)
        default: return value.jsonText
        }
    }
    static func digest(_ value: JSONValue) -> String { "sha256:" + SHA256.hash(data: Data(canonical(value).utf8)).map { String(format: "%02x", $0) }.joined() }
    static func parse(_ text: String, bytes: Int, depth: Int, nodes: Int) throws -> JSONValue { try IntegerJSON.parse(text, maxBytes: bytes, maxDepth: depth, maxNodes: nodes, allowFractionalNumbers: true) }
    static func require(_ value: Bool, _ code: String = "invalid_composition") throws { if !value { throw CompositionError(code: code) } }
    static func match(_ value: JSONValue?, _ pattern: String) throws { try require(MediaJSON.text(value).range(of: "^(?:" + pattern + ")$", options: .regularExpression) != nil) }
    static func decode<T: Decodable>(_ value: JSONValue) throws -> T { let d = JSONDecoder(); d.keyDecodingStrategy = .convertFromSnakeCase; return try d.decode(T.self, from: Data(canonical(value).utf8)) }
}

public struct CompositionPackage: Sendable {
    public let document: JSONValue
    public var name: String { MediaJSON.string(document, "name") }
    public var roles: [String] { (try? MediaJSON.object(MediaJSON.member(document, "modules")).keys.sorted()) ?? [] }
    public func modelRevision(_ role: String) -> String { MediaJSON.string(MediaJSON.member(MediaJSON.member(document, "modules"), role), "model_revision") }
    public static func readingCompanionJSON() throws -> String {
        guard let url = Bundle.module.url(forResource: "reading-companion", withExtension: "json") else { throw CompositionError(code: "invalid_composition") }
        return try String(contentsOf: url, encoding: .utf8)
    }
    public static func parse(_ text: String) throws -> Self {
        do {
            let document = try CompositionJSON.parse(text, bytes: 32768, depth: 8, nodes: 2048)
            let v = try MediaJSON.fields(document, "schema_version,package_id,version,name,modules,rule,sample_event_data")
            try CompositionJSON.require(v["schema_version"] == .integer(1))
            try CompositionJSON.match(v["package_id"], "[a-z][a-z0-9-]{0,63}")
            try CompositionJSON.match(v["version"], #"(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})"#)
            let name = try MediaJSON.text(v["name"]); try CompositionJSON.require((1...80).contains(name.unicodeScalars.count))
            let modules = try MediaJSON.object(v["modules"]); try CompositionJSON.require((1...8).contains(modules.count))
            for (role, value) in modules { try CompositionJSON.match(.string(role), "[a-z][a-z0-9_]{0,31}"); let m = try MediaJSON.fields(value, "model_revision"); try MediaJSON.hash(m["model_revision"]) }
            let r = try MediaJSON.fields(v["rule"], "version,id,trigger,conditions,actions,cooldown_ms")
            try CompositionJSON.require(r["version"] == .integer(1) && r["conditions"] == .array([]))
            let id = try MediaJSON.text(r["id"]); try CompositionJSON.require((1...128).contains(id.unicodeScalars.count))
            _ = try MediaJSON.integer(r["cooldown_ms"], 0, 86400000)
            let trigger = try MediaJSON.fields(r["trigger"], "device,event"); _ = try MediaJSON.text(trigger["event"])
            let source = try MediaJSON.text(trigger["device"]); try CompositionJSON.require((1...128).contains(source.unicodeScalars.count))
            guard case .array(let actions) = r["actions"], (1...16).contains(actions.count) else { throw CompositionError(code: "invalid_composition") }
            var used = Set([source])
            for action in actions {
                let a = try MediaJSON.fields(action, "device,set"), device = try MediaJSON.text(a["device"])
                try CompositionJSON.require((1...128).contains(device.unicodeScalars.count)); used.insert(device)
                let set = try MediaJSON.fields(a["set"], "path,value"); _ = try MediaJSON.text(set["path"])
            }
            try CompositionJSON.require(used == Set(modules.keys), "composition_role_mismatch")
            _ = try MediaJSON.object(v["sample_event_data"])
            return Self(document: document)
        } catch let error as CompositionError { throw error } catch { throw CompositionError(code: "invalid_composition") }
    }
    public func compile(bindings: [String: String], instanceID: String) throws -> CompositionCompiled {
        do {
            try MediaJSON.id(.string(instanceID))
            try CompositionJSON.require(Set(bindings.keys) == Set(roles) && Set(bindings.values).count == roles.count, "invalid_composition_bindings")
            for value in bindings.values { try MediaJSON.id(.string(value)) }
            let map = JSONValue.object(bindings.mapValues(JSONValue.string)); try CompositionJSON.require(CompositionJSON.canonical(map).utf8.count <= 4096, "invalid_composition_bindings")
            var rule = try MediaJSON.object(MediaJSON.member(document, "rule")), trigger = try MediaJSON.object(rule["trigger"])
            rule["id"] = .string(instanceID); trigger["device"] = .string(bindings[try MediaJSON.text(trigger["device"])]!); rule["trigger"] = .object(trigger)
            guard case .array(let actions) = rule["actions"] else { throw CompositionError(code: "invalid_composition") }
            let bound = try actions.map { value -> JSONValue in var a = try MediaJSON.object(value); a["device"] = .string(bindings[try MediaJSON.text(a["device"])]!); return .object(a) }; rule["actions"] = .array(bound)
            var permissions: [JSONValue] = [.object(["kind": .string("event.read"), "device_id": trigger["device"]!, "path": trigger["event"]!])]
            for action in bound {
                let item = JSONValue.object(["kind": .string("property.write"), "device_id": MediaJSON.member(action, "device"), "path": MediaJSON.member(MediaJSON.member(action, "set"), "path")])
                if !permissions.contains(item) { permissions.append(item) }
            }
            return CompositionCompiled(document: .object([
                "schema_version": .integer(1), "package_id": MediaJSON.member(document, "package_id"), "package_version": MediaJSON.member(document, "version"),
                "package_digest": .string(CompositionJSON.digest(document)), "bindings_digest": .string(CompositionJSON.digest(map)), "rule_revision": .string(CompositionJSON.digest(.object(rule))),
                "expected_models": .array(roles.map { .object(["role": .string($0), "device_id": .string(bindings[$0]!), "model_revision": .string(modelRevision($0))]) }),
                "required_permissions": .array(permissions), "rule": .object(rule),
                "simulation_input": .object(["rule": .object(rule), "event": .object(["device_id": trigger["device"]!, "path": trigger["event"]!, "historical": .bool(false), "data": MediaJSON.member(document, "sample_event_data")])]),
                "gateway_checked": .bool(false), "deployed": .bool(false)
            ]), package: self, bindings: bindings)
        } catch let error as CompositionError { throw error } catch { throw CompositionError(code: "invalid_composition_bindings") }
    }
}
public struct CompositionCompiled: Sendable {
    public let document: JSONValue; public let package: CompositionPackage; public let bindings: [String: String]
    public var rule: JSONValue { MediaJSON.member(document, "rule") }
    public var typedRule: Rule { get throws { try CompositionJSON.decode(rule) } }
    public var instanceID: String { MediaJSON.string(rule, "id") }
    public var revision: String { MediaJSON.string(document, "rule_revision") }
    public var json: String { CompositionJSON.canonical(document) }
}
public struct CompositionRecord: Sendable {
    public let document: JSONValue; public let compiled: CompositionCompiled
    public var state: String { MediaJSON.string(document, "state") }
    public var json: String { CompositionJSON.canonical(document) }
    public static func parse(_ text: String, origin: String, space: String) throws -> Self {
        do {
            let document = try CompositionJSON.parse(text, bytes: 65536, depth: 12, nodes: 4096)
            var v = try MediaJSON.fields(document, "version,origin,space_id,package,bindings,instance_id,rule_revision,state,checksum")
            try CompositionJSON.require(v["version"] == .integer(1) && v["origin"] == .string(origin) && v["space_id"] == .string(space))
            try CompositionJSON.require(["attempted", "acknowledged", "rejected"].contains(MediaJSON.string(document, "state")))
            let checksum = v.removeValue(forKey: "checksum"); try CompositionJSON.require(checksum == .string(CompositionJSON.digest(.object(v))))
            let package = try CompositionPackage.parse(CompositionJSON.canonical(v["package"]!)), map = try MediaJSON.object(v["bindings"])
            let bindings = try map.mapValues { try MediaJSON.text($0) }
            let compiled = try package.compile(bindings: bindings, instanceID: MediaJSON.text(v["instance_id"]))
            try CompositionJSON.require(v["rule_revision"] == .string(compiled.revision)); return Self(document: document, compiled: compiled)
        } catch { throw CompositionError(code: "composition_record_unavailable") }
    }
}
