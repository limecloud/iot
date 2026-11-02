import Foundation

public enum JSONValue: Codable, Sendable, Equatable {
    case null, bool(Bool), integer(Int), number(Double), string(String), array([JSONValue]), object([String: JSONValue])
    public init(from decoder: any Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let item = try? value.decode(Bool.self) { self = .bool(item) }
        else if let item = try? value.decode(Int.self) { self = .integer(item) }
        else if let item = try? value.decode(Double.self) { self = .number(item) }
        else if let item = try? value.decode(String.self) { self = .string(item) }
        else if let item = try? value.decode([String: JSONValue].self) { self = .object(item) }
        else { self = .array(try value.decode([JSONValue].self)) }
    }
    public func encode(to encoder: any Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .null: try value.encodeNil()
        case .bool(let item): try value.encode(item)
        case .integer(let item): try value.encode(item)
        case .number(let item): try value.encode(item)
        case .string(let item): try value.encode(item)
        case .array(let item): try value.encode(item)
        case .object(let item): try value.encode(item)
        }
    }
    public var bool: Bool? { if case .bool(let value) = self { value } else { nil } }
    public var integer: Int? { if case .integer(let value) = self { value } else { nil } }
    public var text: String {
        switch self {
        case .bool(let value): value ? "开启" : "关闭"
        case .integer(let value): String(value)
        case .number(let value): String(value)
        case .string(let value): value
        case .null: "null"
        default: jsonText
        }
    }
    public var jsonText: String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? "null"
    }
}
public struct Page<Item: Decodable & Sendable>: Decodable, Sendable {
    public let items: [Item]
    public let nextCursor: String?
}
public struct Session: Codable, Sendable { public let authenticated: Bool; public let csrfToken: String; public let expiresAt: String }
public struct Space: Decodable, Sendable { public let spaceId: String }
public struct Observation: Decodable, Sendable { public let value: JSONValue; public let observedAt: String; public let quality: String; public let source: String }
public struct Device: Decodable, Sendable, Identifiable {
    public let deviceId: String
    public let modelRevision: String
    public let ready: Bool
    public let lastSeen: String?
    public let reported: [String: Observation]
    public var id: String { deviceId }
}
public struct ValueSchema: Codable, Sendable {
    public let type: String
    public let minimum: Double?
    public let maximum: Double?
    public let properties: [String: ValueSchema]?
    public let required: [String]?
    public let enumValues: [JSONValue]?
    private enum CodingKeys: String, CodingKey { case type, minimum, maximum, properties, required; case enumValues = "enum" }
    public var sample: JSONValue {
        if let first = enumValues?.first { return first }
        return switch type {
        case "boolean": .bool(true)
        case "integer": .integer(Int(minimum ?? 0))
        case "number": .number(minimum ?? 0)
        case "object": .object(Dictionary(uniqueKeysWithValues: (required ?? []).map { ($0, properties?[$0]?.sample ?? .null) }))
        default: .string("")
        }
    }
}
public struct Property: Decodable, Sendable { public let id: String; public let schema: ValueSchema; public let access: [String] }
public struct ModelEvent: Decodable, Sendable { public let id: String; public let schema: ValueSchema }
public struct ModelAction: Decodable, Sendable { public let id: String; public let input: ValueSchema; public let output: ValueSchema; public let idempotent: Bool; public let risk: String; public let completion: String }
public struct Service: Decodable, Sendable { public let id: String; public let properties: [Property]; public let events: [ModelEvent]; public let actions: [ModelAction]? }
public struct Model: Decodable, Sendable { public let modelId: String; public let services: [Service] }
public struct Inference: Decodable, Sendable { public let configured: Bool; public let model: String? }
public struct Capabilities: Decodable, Sendable { public let models: [String: Model]; public let inference: Inference? }
public struct DraftReference: Codable, Sendable, Equatable {
    public let space: String
    public let key: String
    public init(space: String, key: String = UUID().uuidString.lowercased()) { self.space = space; self.key = key }
}
public struct DraftInput: Codable, Sendable {
    public let prompt: String
    public let expiresAt: String
    public init(prompt: String, now: Date = .now) { self.prompt = prompt; expiresAt = ISO8601DateFormatter().string(from: now.addingTimeInterval(120)) }
}
public struct RuleDraft: Decodable, Sendable, Identifiable {
    public let draftId: String
    public let request: DraftInput
    public let status: String
    public let rule: Rule?
    public let ruleRevision: String?
    public let error: String?
    public var id: String { draftId }
    public var statusText: String { ["running": "正在生成草案", "completed": "草案已生成", "rejected": "草案未通过", "unknown": "生成结果未知", "expired": "生成请求已过期"][status] ?? status }
}
public struct Operation: Codable, Sendable, Equatable {
    public let type: String
    public let path: String
    public let value: JSONValue
    public init(path: String, value: JSONValue, type: String = "property.set") { self.type = type; self.path = path; self.value = value }
    public var summary: String {
        if type == "action.invoke", path == "remote.press", case .object(let input) = value, case .string(let key) = input["key"] { return "遥控：" + (Self.keyLabels[key] ?? key) }
        if type == "action.invoke", path == "apps.launch", case .object(let input) = value, case .string(let app) = input["application_id"] { return "启动应用：" + app }
        return path + "：" + value.text
    }
    public static let keyLabels = ["up": "向上", "down": "向下", "left": "向左", "right": "向右", "select": "确认", "back": "返回", "home": "主页", "menu": "菜单", "play_pause": "播放/暂停"]
}
public struct CommandInput: Codable, Sendable {
    public let deviceId: String
    public let modelRevision: String
    public let expiresAt: String
    public let operation: Operation
}
public struct CommandIntent: Codable, Sendable {
    public let key: String
    public let input: CommandInput
    public init(device: Device, path: String, value: JSONValue, now: Date = .now, type: String = "property.set") {
        key = UUID().uuidString.lowercased()
        input = CommandInput(deviceId: device.deviceId, modelRevision: device.modelRevision, expiresAt: ISO8601DateFormatter().string(from: now.addingTimeInterval(5)), operation: Operation(path: path, value: value, type: type))
    }
}
public struct Command: Decodable, Sendable, Identifiable {
    public struct Input: Decodable, Sendable { public let deviceId: String; public let operation: Operation; public let expiresAt: String }
    public let commandId: String
    public let status: String
    public let request: Input
    public let runId: String?
    public let error: String?
    public let evidence: JSONValue?
    public var id: String { commandId }
    public var statusText: String {
        if status == "confirmed", request.operation.type == "action.invoke" { return Self.actionStatus(evidence) }
        return ["accepted": "已受理", "dispatched": "已发送", "confirmed": "已确认", "unknown": "结果未知", "failed": "执行失败", "expired": "已过期", "rejected": "已拒绝"][status] ?? status
    }
    public static func actionStatus(_ evidence: JSONValue?) -> String {
        guard case .object(let result) = evidence, result["type"] == .string("action_result") else { return "完成范围未知" }
        switch result["completion"] { case .string("submitted"): return "输入已提交"; case .string("observed"): return "效果已观测"; default: return "完成范围未知" }
    }
}
public struct Rule: Codable, Sendable, Equatable {
    public struct Trigger: Codable, Sendable, Equatable { public let device: String; public let event: String }
    public struct SetValue: Codable, Sendable, Equatable { public let path: String; public let value: JSONValue }
    public struct Action: Codable, Sendable, Equatable { public let device: String; public let set: SetValue }
    public let version: Int
    public let id: String
    public let trigger: Trigger
    public let conditions: [JSONValue]
    public let actions: [Action]
    public let cooldownMs: Int
    public init(id: String, source: String, event: String, target: String, path: String, value: JSONValue, cooldownMs: Int) {
        version = 1; self.id = id; trigger = Trigger(device: source, event: event); conditions = []
        actions = [Action(device: target, set: SetValue(path: path, value: value))]; self.cooldownMs = cooldownMs
    }
}
public struct Deployment: Decodable, Sendable, Identifiable { public let revision: String; public let rule: Rule; public let lastRun: String?; public var id: String { rule.id } }
public struct Run: Decodable, Sendable, Identifiable { public let runId: String; public let commandIds: [String]; public let eventId: String; public let error: String?; public var id: String { runId } }
public struct Simulation: Decodable, Sendable { public let revision: String; public let matched: Bool; public let executed: Bool; public let simulation: Bool }
public struct Snapshot: Sendable {
    public let space: String
    public let devices: [Device]
    public let models: [String: Model]
    public let inference: Inference?
    public let commands: Page<Command>
    public let deployments: [Deployment]
    public let runs: [Run]
    public func eventSample(_ rule: Rule) -> JSONValue? {
        guard let device = devices.first(where: { $0.id == rule.trigger.device }) else { return nil }
        for service in models[device.modelRevision]?.services ?? [] {
            if let event = service.events.first(where: { service.id + "." + $0.id == rule.trigger.event }) { return event.schema.sample }
        }
        return nil
    }
    public func name(_ device: Device) -> String {
        let services = models[device.modelRevision]?.services ?? []
        if services.contains(where: { $0.id == "light" }) { return "环境灯" }
        if services.contains(where: { $0.id == "button" }) { return "无线按钮" }
        return device.deviceId
    }
}
