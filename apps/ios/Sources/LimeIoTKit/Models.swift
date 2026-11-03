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
    public let minLength: Int?
    public let maxLength: Int?
    public init(type: String, minimum: Double? = nil, maximum: Double? = nil, properties: [String: ValueSchema]? = nil, required: [String]? = nil, enumValues: [JSONValue]? = nil, minLength: Int? = nil, maxLength: Int? = nil) {
        self.type = type; self.minimum = minimum; self.maximum = maximum; self.properties = properties; self.required = required; self.enumValues = enumValues; self.minLength = minLength; self.maxLength = maxLength
    }
    private enum CodingKeys: String, CodingKey { case type, minimum, maximum, properties, required, minLength, maxLength; case enumValues = "enum" }
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
public struct Property: Decodable, Sendable {
    public let id: String; public let schema: ValueSchema; public let access: [String]
    public let semanticId: String?; public let unit: String?
    public var displayName: String {
        if semanticId == "urn:limeiot:property:temperature:1" { return "温度" }
        if semanticId == "urn:limeiot:property:relative-humidity:1" { return "相对湿度" }
        return id == "power" ? "电源" : id == "brightness" ? "亮度" : id
    }
    public func displayValue(_ value: JSONValue?) -> String {
        guard let value else { return "暂无状态" }
        if case .integer(let number) = value, unit == "celsius_x100" || unit == "percent_x100" {
            return String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), Double(number)/100) + (unit == "celsius_x100" ? " ℃" : " %RH")
        }
        return value.text
    }
}
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
    public struct PropertyTrigger: Codable, Sendable, Equatable {
        public enum Edge: String, Codable, Sendable { case rising, falling }
        public let path: String; public let unit: String; public let edge: Edge
        public let threshold: JSONValue; public let hysteresis: JSONValue
        public var summary: String {
            let name = path == "environment.temperature" ? "温度" : path == "environment.humidity" ? "相对湿度" : path
            func value(_ input: JSONValue) -> String {
                let number: Double
                switch input { case .integer(let v): number = Double(v); case .number(let v): number = v; default: return input.text }
                if unit == "celsius_x100" || unit == "percent_x100" {
                    return String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), number / 100) + (unit == "celsius_x100" ? " ℃" : " %RH")
                }
                return input.text + " " + unit
            }
            return name + (edge == .rising ? "上升越过 " : "下降越过 ") + value(threshold) + "，滞回 " + value(hysteresis)
        }
    }
    public struct Trigger: Codable, Sendable, Equatable {
        public struct Schedule: Sendable, Equatable {
            public let time: String; public let timeZone: String; public let weekdays: [Int]
            public init(time: String, timeZone: String, weekdays: [Int]) { self.time = time; self.timeZone = timeZone; self.weekdays = weekdays }
            public static func fromForm(time: String, timeZone: String, weekdays: [Int]) -> Schedule? {
                guard time.utf8.count == 5, time.range(of: #"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$"#, options: .regularExpression) != nil,
                      !timeZone.isEmpty, timeZone.utf8.count <= 128, TimeZone(identifier: timeZone) != nil,
                      !weekdays.isEmpty, weekdays.count <= 7, Set(weekdays).count == weekdays.count, weekdays.allSatisfy({ (1...7).contains($0) }) else { return nil }
                return Schedule(time: time, timeZone: timeZone, weekdays: weekdays)
            }
            var json: JSONValue { .object(["time": .string(time), "time_zone": .string(timeZone), "weekdays": .array(weekdays.map { .integer($0) })]) }
            public var summary: String { time + "，" + timeZone + "，周" + weekdays.map(String.init).joined(separator: "、") }
        }
        public let device: String; public let event: String?; public let property: PropertyTrigger?; public let schedule: Schedule?
        public init(device: String, event: String) { self.device = device; self.event = event; property = nil; schedule = nil }
        public init(device: String, property: PropertyTrigger) { self.device = device; self.property = property; event = nil; schedule = nil }
        public init(schedule: Schedule) { device = ""; event = nil; property = nil; self.schedule = schedule }
        public init(from decoder: Decoder) throws {
            let value = try JSONValue(from: decoder)
            if case .object(let fields) = value, Set(fields.keys) == ["schedule"], case .object(let payload) = fields["schedule"],
               Set(payload.keys) == ["time", "time_zone", "weekdays"], case .string(let time) = payload["time"], case .string(let zone) = payload["time_zone"], case .array(let days) = payload["weekdays"] {
                let weekdays = days.compactMap { value -> Int? in if case .integer(let day) = value, (1...7).contains(day) { return Int(day) }; return nil }
                guard !weekdays.isEmpty, weekdays.count == days.count, Set(weekdays).count == weekdays.count,
                      time.utf8.count == 5, time.range(of: #"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$"#, options: .regularExpression) != nil, !zone.isEmpty, zone.utf8.count <= 128 else {
                    throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "invalid_rule_trigger"))
                }
                self.init(schedule: Schedule(time: time, timeZone: zone, weekdays: weekdays)); return
            }
            guard case .object(let fields) = value, case .string(let device) = fields["device"], fields.count == 2 else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "invalid_rule_trigger"))
            }
            if case .string(let event) = fields["event"] { self.init(device: device, event: event); return }
            guard case .object(let payload) = fields["property"], Set(payload.keys) == Set(["path", "unit", "edge", "threshold", "hysteresis"]) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "invalid_rule_trigger"))
            }
            let property = try JSONDecoder().decode(PropertyTrigger.self, from: JSONEncoder().encode(JSONValue.object(payload)))
            self.init(device: device, property: property)
        }
        public func encode(to encoder: Encoder) throws {
            if let schedule { try JSONValue.object(["schedule": schedule.json]).encode(to: encoder); return }
            var result: [String: JSONValue] = ["device": .string(device)]
            if let event { result["event"] = .string(event) }
            if let property { result["property"] = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(property)) }
            try JSONValue.object(result).encode(to: encoder)
        }
        public var summary: String { schedule?.summary ?? property?.summary ?? (event == "button.pressed" ? "按下时" : "发生 " + (event ?? "")) }
    }
    public struct SetValue: Codable, Sendable, Equatable { public let path: String; public let value: JSONValue }
    public struct InvokeValue: Codable, Sendable, Equatable { public let path: String; public let input: JSONValue }
    public struct Action: Codable, Sendable, Equatable {
        public enum Body: Sendable, Equatable { case set(SetValue), invoke(InvokeValue) }
        public let device: String
        public let body: Body
        public init(device: String, set: SetValue) { self.device = device; body = .set(set) }
        public init(device: String, invoke: InvokeValue) { self.device = device; body = .invoke(invoke) }
        public var operation: Operation {
            switch body {
            case .set(let set): return Operation(path: set.path, value: set.value)
            case .invoke(let invoke): return Operation(path: invoke.path, value: invoke.input, type: "action.invoke")
            }
        }
        public init(from decoder: Decoder) throws {
            let value = try JSONValue(from: decoder)
            guard case .object(let fields) = value, case .string(let device) = fields["device"],
                  fields.count == 2, let key = fields["set"] != nil ? "set" : fields["invoke"] != nil ? "invoke" : nil,
                  case .object(let payload) = fields[key], payload.count == 2,
                  case .string(let path) = payload["path"], let input = payload[key == "set" ? "value" : "input"] else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "invalid_rule_action"))
            }
            self.device = device
            body = key == "set" ? .set(SetValue(path: path, value: input)) : .invoke(InvokeValue(path: path, input: input))
        }
        public func encode(to encoder: Encoder) throws {
            let field: String; let payload: JSONValue
            switch body {
            case .set(let set): field = "set"; payload = .object(["path": .string(set.path), "value": set.value])
            case .invoke(let invoke): field = "invoke"; payload = .object(["path": .string(invoke.path), "input": invoke.input])
            }
            try JSONValue.object(["device": .string(device), field: payload]).encode(to: encoder)
        }
    }
    public let version: Int
    public let id: String
    public let trigger: Trigger
    public let conditions: [JSONValue]
    public let actions: [Action]
    public let cooldownMs: Int
    public init(id: String, source: String, event: String, target: String, path: String, value: JSONValue, cooldownMs: Int, type: String = "property.set") {
        self.init(id: id, trigger: Trigger(device: source, event: event), target: target, path: path, value: value, cooldownMs: cooldownMs, type: type)
    }
    public init(id: String, trigger: Trigger, target: String, path: String, value: JSONValue, cooldownMs: Int, type: String = "property.set", conditions: [JSONValue] = []) {
        version = 1; self.id = id; self.trigger = trigger; self.conditions = conditions
        actions = [type == "action.invoke" ? Action(device: target, invoke: InvokeValue(path: path, input: value)) : Action(device: target, set: SetValue(path: path, value: value))]; self.cooldownMs = cooldownMs
    }
}
public struct Deployment: Decodable, Sendable, Identifiable { public let revision: String; public let rule: Rule; public let lastRun: String?; public var id: String { rule.id } }
public struct Run: Decodable, Sendable, Identifiable { public let runId: String; public let commandIds: [String]; public let eventId: String; public let error: String?; public let conditionEvaluation: JSONValue?; public var id: String { runId } }
public struct Simulation: Decodable, Sendable {
    public let revision: String; public let matched: Bool; public let executed: Bool; public let simulation: Bool
    public let triggerMatched: Bool?; public let conditionEvaluation: JSONValue?; public let proposedActions: [Rule.Action]?
    public var canDeploy: Bool { !executed && simulation && (conditionEvaluation == nil ? matched : triggerMatched == true) }
}
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
