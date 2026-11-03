import Foundation

public enum ThresholdEditor {
    public static func scale(_ unit: String) -> Double { ["celsius_x100", "percent_x100"].contains(unit) ? 100 : 1 }
    public static func label(_ unit: String) -> String { unit == "celsius_x100" ? "℃" : unit == "percent_x100" ? "%RH" : unit }
    private static func numeric(_ value: JSONValue) -> Double? {
        switch value { case .integer(let v): Double(v); case .number(let v): v; default: nil }
    }
    public static func display(_ value: JSONValue, unit: String) -> String {
        guard let value = numeric(value) else { return "" }
        return String(value / scale(unit))
    }
    public static func number(_ text: String, schema: ValueSchema, unit: String = "") -> JSONValue? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.range(of: #"^-?(?:\d+(?:\.\d*)?|\.\d+)$"#, options: .regularExpression) != nil,
              var decimal = Decimal(string: text, locale: Locale(identifier: "en_US_POSIX")) else { return nil }
        if scale(unit) == 100 {
            guard (text.split(separator: ".", omittingEmptySubsequences: false).dropFirst().first?.count ?? 0) <= 2 else { return nil }
            decimal *= 100
        }
        let value = NSDecimalNumber(decimal: decimal).doubleValue
        guard value.isFinite, abs(value) <= 9_007_199_254_740_991,
              schema.minimum.map({ value >= $0 }) ?? true, schema.maximum.map({ value <= $0 }) ?? true else { return nil }
        if schema.type == "integer" {
            var rounded = Decimal(); NSDecimalRound(&rounded, &decimal, 0, .plain)
            guard rounded == decimal else { return nil }
            return .integer(Int(value))
        }
        return .number(value)
    }
    public static func property(path: String, unit: String, schema: ValueSchema, edge: Rule.PropertyTrigger.Edge, threshold: String, hysteresis: String) -> Rule.PropertyTrigger? {
        guard let thresholdValue = number(threshold, schema: schema, unit: unit), let t = numeric(thresholdValue) else { return nil }
        let deltaSchema = ValueSchema(type: schema.type, minimum: 0, maximum: nil, properties: nil, required: nil, enumValues: nil)
        guard let deltaValue = number(hysteresis, schema: deltaSchema, unit: unit), let delta = numeric(deltaValue) else { return nil }
        let boundary = edge == .rising ? t - delta : t + delta
        guard boundary.isFinite, schema.minimum.map({ boundary >= $0 }) ?? true, schema.maximum.map({ boundary <= $0 }) ?? true else { return nil }
        return Rule.PropertyTrigger(path: path, unit: unit, edge: edge, threshold: thresholdValue, hysteresis: deltaValue)
    }
    public static func samples(_ property: Rule.PropertyTrigger, schema: ValueSchema, now: Date = .now) -> JSONValue? {
        guard let threshold = numeric(property.threshold), let delta = numeric(property.hysteresis) else { return nil }
        let rising = property.edge == .rising
        let bound = rising ? schema.maximum : schema.minimum
        let step = schema.type == "integer" ? 1 : bound.map { abs($0 - threshold) / 2 } ?? max(1, abs(threshold) * 0.01)
        let current = rising ? threshold + step : threshold - step
        guard current.isFinite, current != threshold, schema.minimum.map({ current >= $0 }) ?? true, schema.maximum.map({ current <= $0 }) ?? true else { return nil }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        func sample(_ value: Double, _ at: Date) -> JSONValue {
            .object(["value": schema.type == "integer" ? .integer(Int(value)) : .number(value), "observed_at": .string(formatter.string(from: at)), "quality": .string("confirmed"), "source": .string("simulation.ui")])
        }
        return .object(["previous": sample(rising ? threshold - delta : threshold + delta, now.addingTimeInterval(-0.001)), "current": sample(current, now)])
    }
}
