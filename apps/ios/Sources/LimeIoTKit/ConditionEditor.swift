import Foundation

public struct ConditionSource: Sendable, Identifiable {
    public let device: String; public let path: String; public let name: String; public let schema: ValueSchema; public let unit: String?
    public var id: String { device + "/" + path }
    public init(device: String, path: String, name: String, schema: ValueSchema, unit: String? = nil) { self.device = device; self.path = path; self.name = name; self.schema = schema; self.unit = unit }
}
public struct ConditionForm: Sendable, Equatable, Identifiable {
    public var id = UUID()
    public var kind = "compare"
    public var source = ""
    public var comparison = "eq"
    public var value = ""
    public var children: [ConditionForm] = []
    public init(source: ConditionSource) {
        self.source = source.id
        let sample = source.schema.sample
        switch sample { case .integer, .number: value = ThresholdEditor.display(sample, unit: source.unit ?? ""); case .bool(let item): value = String(item); case .string(let item): value = item; default: break }
    }
}
public enum ConditionEditor {
    public static func count(_ forms: [ConditionForm]) -> Int { forms.reduce(0) { $0 + 1 + count($1.children) } }
    public static let operators = ["eq", "ne", "lt", "lte", "gt", "gte"]
    public static func label(_ op: String) -> String { ["eq": "等于", "ne": "不等于", "lt": "小于", "lte": "小于或等于", "gt": "大于", "gte": "大于或等于"][op] ?? op }
    public static func operators(_ schema: ValueSchema) -> [String] { ["integer", "number"].contains(schema.type) ? operators : ["eq", "ne"] }
    public static func sources(_ snapshot: Snapshot?) -> [ConditionSource] {
        guard let snapshot else { return [] }
        return snapshot.devices.flatMap { device in (snapshot.models[device.modelRevision]?.services ?? []).flatMap { service in service.properties.filter { $0.access.contains("read") && ["integer", "number", "boolean", "string"].contains($0.schema.type) }.map { property in ConditionSource(device: device.id, path: service.id + "." + property.id, name: snapshot.name(device) + " " + property.displayName, schema: property.schema, unit: property.unit) } } }
    }
    public static func compile(_ forms: [ConditionForm], sources: [ConditionSource]) -> [JSONValue]? {
        var count = 0
        func walk(_ nodes: [ConditionForm], _ depth: Int) -> [JSONValue]? {
            guard nodes.count <= 16, nodes.isEmpty || depth <= 4 else { return nil }
            var result: [JSONValue] = []
            for node in nodes {
                count += 1; guard count <= 32 else { return nil }
                if node.kind != "compare" {
                    guard ["all", "any"].contains(node.kind), !node.children.isEmpty, let children = walk(node.children, depth + 1) else { return nil }
                    result.append(.object([node.kind: .array(children)])); continue
                }
                guard node.children.isEmpty, let source = sources.first(where: { $0.id == node.source }), operators(source.schema).contains(node.comparison) else { return nil }
                let value: JSONValue
                switch source.schema.type {
                case "integer", "number": guard let number = ThresholdEditor.number(node.value, schema: source.schema, unit: source.unit ?? "") else { return nil }; value = number
                case "boolean": guard ["true", "false"].contains(node.value) else { return nil }; value = .bool(node.value == "true")
                case "string": guard node.value.unicodeScalars.count >= (source.schema.minLength ?? 0), node.value.unicodeScalars.count <= (source.schema.maxLength ?? 4096) else { return nil }; value = .string(node.value)
                default: return nil
                }
                if let values = source.schema.enumValues, !values.contains(where: { RuleProof.equal($0, value) }) { return nil }
                var comparison: [String: JSONValue] = ["device": .string(source.device), "property": .string(source.path), "operator": .string(node.comparison), "value": value]
                if let unit = source.unit { comparison["unit"] = .string(unit) }
                result.append(.object(comparison))
            }
            return result
        }
        return walk(forms, 1)
    }
    public static func restore(_ conditions: [JSONValue], sources: [ConditionSource]) -> [ConditionForm]? {
        func walk(_ values: [JSONValue], _ depth: Int) -> [ConditionForm]? {
            guard depth <= 4 || values.isEmpty, values.count <= 16 else { return nil }
            var forms: [ConditionForm] = []
            for value in values {
                guard case .object(let fields) = value else { return nil }
                let group = fields["all"] != nil ? "all" : "any"
                if case .array(let values) = fields[group] {
                    guard let children = walk(values, depth + 1), let first = sources.first else { return nil }
                    var form = ConditionForm(source: first); form.kind = group; form.children = children; forms.append(form)
                } else {
                    guard case .string(let device) = fields["device"], case .string(let path) = fields["property"], case .string(let op) = fields["operator"], let value = fields["value"], let source = sources.first(where: { $0.device == device && $0.path == path }) else { return nil }
                    var form = ConditionForm(source: source); form.comparison = op
                    switch value { case .integer, .number: form.value = ThresholdEditor.display(value, unit: source.unit ?? ""); case .bool(let value): form.value = String(value); case .string(let value): form.value = value; default: return nil }
                    forms.append(form)
                }
            }
            return forms
        }
        guard let forms = walk(conditions, 1), let compiled = compile(forms, sources: sources), RuleProof.equal(.array(compiled), .array(conditions)) else { return nil }
        return forms
    }
    public static func cooldown(_ text: String) -> Int? {
        guard text.range(of: #"^\d+(?:\.\d{0,3})?$"#, options: .regularExpression) != nil, let value = Decimal(string: text, locale: Locale(identifier: "en_US_POSIX")), value >= 0, value <= 86400 else { return nil }
        return NSDecimalNumber(decimal: value * 1000).intValue
    }
    public static func cooldownText(_ milliseconds: Int) -> String { NSDecimalNumber(decimal: Decimal(milliseconds) / 1000).stringValue }
    public static func rows(_ conditions: [JSONValue], results: [JSONValue] = [], prefix: String = "") -> [String] {
        conditions.enumerated().flatMap { index, condition -> [String] in
            guard case .object(let fields) = condition else { return [] }
            let result = index < results.count ? results[index] : .null
            let node: [String: JSONValue]; if case .object(let value) = result { node = value } else { node = [:] }
            let number = prefix + String(index + 1), status = node["matched"].flatMap { $0.bool }.map { $0 ? "，已满足" : "，未满足" } ?? ""
            if case .array(let children) = fields["all"] ?? fields["any"] {
                let values: [JSONValue]; if case .array(let array) = node["children"] { values = array } else { values = [] }
                return [number + " " + (fields["all"] == nil ? "任一满足" : "全部满足") + status] + rows(children, results: values, prefix: number + "-")
            }
            let unit = fields["unit"]?.text ?? ""
            func display(_ value: JSONValue) -> String { switch value { case .integer, .number: return ThresholdEditor.display(value, unit: unit) + (unit.isEmpty ? "" : " " + ThresholdEditor.label(unit)); default: return value.jsonText } }
            var row = number + " " + (fields["device"]?.text ?? "") + " " + (fields["property"]?.text ?? "") + " " + label(fields["operator"]?.text ?? "") + " " + display(fields["value"] ?? .null) + status
            if case .object(let observation) = node["observation"] { row += "；观测值 " + display(observation["value"] ?? .null) + "，" + (observation["observed_at"]?.text ?? "") }
            if let reason = node["reason"]?.text { row += "；" + (["device_offline": "设备离线", "stale_observation": "观测已过期", "missing_observation": "暂无观测", "future_observation": "观测时间超前", "unconfirmed_observation": "观测尚未确认", "model_authority_unavailable": "设备能力未获授权", "invalid_condition": "属性与条件不兼容", "device_not_found": "未找到设备"][reason] ?? reason) }
            return [row]
        }
    }
    public static func evidenceRows(_ evaluation: JSONValue) -> [String] { guard case .object(let fields) = evaluation, case .array(let conditions) = fields["conditions"], case .array(let results) = fields["results"] else { return [] }; return rows(conditions, results: results) }
}
