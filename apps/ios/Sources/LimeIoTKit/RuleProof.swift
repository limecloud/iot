import Foundation

// 核对同一次规则校验/预演及完整证据，不在客户端授予领域权限。
public enum RuleProof {
    private static func number(_ value: JSONValue) -> Double? { switch value { case .integer(let v): Double(v); case .number(let v): v.isFinite ? v : nil; default: nil } }
    public static func equal(_ a: JSONValue, _ b: JSONValue) -> Bool {
        if let a = number(a), let b = number(b) { return a == b }
        switch (a, b) {
        case (.array(let a), .array(let b)): return a.count == b.count && zip(a, b).allSatisfy { equal($0, $1) }
        case (.object(let a), .object(let b)): return a.keys.sorted() == b.keys.sorted() && a.allSatisfy { key, value in b[key].map { equal(value, $0) } ?? false }
        default: return a == b
        }
    }
    private static func time(_ value: JSONValue?) -> Bool {
        guard case .string(let text) = value else { return false }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text) != nil || ISO8601DateFormatter().date(from: text) != nil
    }
    private static func revision(_ value: JSONValue?) -> Bool { guard case .string(let text) = value else { return false }; return text.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil }
    private static func nodes(_ conditions: [JSONValue], _ results: [JSONValue]) -> Bool {
        guard conditions.count == results.count else { return false }
        return zip(conditions, results).allSatisfy { condition, result in
            guard case .object(let c) = condition, case .object(let n) = result, case .bool(let matched) = n["matched"] else { return false }
            if let children = c["all"] ?? c["any"] {
                guard case .array(let children) = children, case .array(let results) = n["children"], n["observation"] == nil, n["model_revision"] == nil, n["reason"] == nil, nodes(children, results) else { return false }
                let values = results.compactMap { if case .object(let fields) = $0 { fields["matched"]?.bool } else { nil } }
                return matched == (c["all"] != nil ? values.allSatisfy { $0 } : values.contains(true))
            }
            guard revision(n["model_revision"]), n["children"] == nil || n["children"] == .array([]) else { return false }
            if case .string(let reason) = n["reason"] { return !matched && ["device_not_found", "model_authority_unavailable", "device_offline", "invalid_condition", "unconfirmed_observation", "future_observation", "stale_observation", "missing_observation"].contains(reason) }
            guard n["reason"] == nil, case .object(let observation) = n["observation"], observation["quality"] == .string("confirmed"), time(observation["observed_at"]), let a = observation["value"], let b = c["value"], case .string(let op) = c["operator"] else { return false }
            let sameType: Bool
            switch (a, b) { case (.bool, .bool), (.string, .string): sameType = true; default: sameType = number(a) != nil && number(b) != nil }
            guard sameType else { return false }
            let expected: Bool
            switch op {
            case "eq": expected = equal(a, b)
            case "ne": expected = !equal(a, b)
            default:
                guard let a = number(a), let b = number(b) else { return false }
                switch op { case "lt": expected = a < b; case "lte": expected = a <= b; case "gt": expected = a > b; case "gte": expected = a >= b; default: return false }
            }
            return matched == expected
        }
    }
    public static func verify(_ proof: Simulation, rule: Rule, valid: Bool, validationRevision: String) throws {
        guard valid, revision(.string(validationRevision)), proof.revision == validationRevision, !proof.executed, proof.simulation, let proposed = proof.proposedActions else { throw GatewayError.invalidResponse }
        let encoder = JSONEncoder(), decoder = JSONDecoder()
        let actual = try decoder.decode(JSONValue.self, from: encoder.encode(proposed))
        let expected = try decoder.decode(JSONValue.self, from: encoder.encode(proof.matched ? rule.actions : []))
        guard equal(actual, expected) else { throw GatewayError.invalidResponse }
        if rule.conditions.isEmpty { guard proof.matched, proof.conditionEvaluation == nil else { throw GatewayError.invalidResponse }; return }
        guard proof.triggerMatched == true, case .object(let evaluation) = proof.conditionEvaluation, time(evaluation["evaluated_at"]), let conditions = evaluation["conditions"], equal(conditions, .array(rule.conditions)), case .array(let results) = evaluation["results"], nodes(rule.conditions, results), evaluation["matched"] == .bool(proof.matched) else { throw GatewayError.invalidResponse }
        let all = results.allSatisfy { if case .object(let fields) = $0 { fields["matched"] == .bool(true) } else { false } }
        guard all == proof.matched else { throw GatewayError.invalidResponse }
    }
}
