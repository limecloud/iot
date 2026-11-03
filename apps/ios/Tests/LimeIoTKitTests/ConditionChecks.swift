import Foundation
import LimeIoTKit

private struct ConditionCheckFailure: Error { let name: String }
func conditionContractChecks() throws -> Int {
    var checks = 0
    func check(_ valid: Bool, _ name: String) throws { if !valid { throw ConditionCheckFailure(name: name) }; checks += 1 }
    let sources = [ConditionSource(device: "sensor", path: "environment.temperature", name: "温度", schema: .init(type: "integer", minimum: -4500, maximum: 13000), unit: "celsius_x100"), ConditionSource(device: "lamp", path: "light.power", name: "电源", schema: .init(type: "boolean")), ConditionSource(device: "pet", path: "voice.mode", name: "模式", schema: .init(type: "string", minLength: 1, maxLength: 8))]
    var temperature = ConditionForm(source: sources[0]); temperature.comparison = "gte"; temperature.value = "28.03"
    var group = ConditionForm(source: sources[0]); group.kind = "any"; group.children = [ConditionForm(source: sources[1]), ConditionForm(source: sources[2])]; group.children[1].value = " Talk "
    var all = ConditionForm(source: sources[0]); all.kind = "all"; all.children = [temperature, group]
    guard let tree = ConditionEditor.compile([all], sources: sources), let restored = ConditionEditor.restore(tree, sources: sources) else { throw ConditionCheckFailure(name: "restore") }
    try check(RuleProof.equal(.array(tree), .array(ConditionEditor.compile(restored, sources: sources)!)), "full tree round trip")
    guard case .object(let fields) = tree[0], case .array(let children) = fields["all"], case .object(let comparison) = children[0] else { throw ConditionCheckFailure(name: "shape") }
    try check(comparison["value"] == .integer(2803), "decimal precision")
    for text in ["28.001", "NaN", "131", "1e2", ""] { var form = temperature; form.value = text; try check(ConditionEditor.compile([form], sources: sources) == nil, "invalid value: " + text) }
    try check(ConditionEditor.restore(tree, sources: Array(sources.dropFirst())) == nil, "missing source")
    var extra = comparison; extra["extra"] = .bool(true); try check(ConditionEditor.restore([.object(extra)], sources: sources) == nil, "unknown field")
    extra = comparison; extra["unit"] = .string("kelvin"); try check(ConditionEditor.restore([.object(extra)], sources: sources) == nil, "wrong unit")
    try check(ConditionEditor.compile(Array(repeating: temperature, count: 17), sources: sources) == nil, "group limit")
    var deep = temperature; for _ in 0..<4 { var next = group; next.children = [deep]; deep = next }; try check(ConditionEditor.compile([deep], sources: sources) == nil, "depth limit")
    try check(ConditionEditor.cooldown("1.001") == 1001 && ConditionEditor.cooldownText(1001) == "1.001" && ConditionEditor.cooldown("0.0001") == nil, "millisecond cooldown")
    let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
    let condition = JSONValue.object(["device": .string("lamp"), "property": .string("light.power"), "operator": .string("eq"), "value": .bool(true)])
    let rule = Rule(id: "test", trigger: .init(device: "button", event: "button.pressed"), target: "lamp", path: "light.power", value: .bool(true), cooldownMs: 1001, conditions: [condition])
    let revision = "sha256:" + String(repeating: "a", count: 64), now = "2026-11-03T00:00:00.000Z"
    let observation: JSONValue = .object(["value": .bool(false), "observed_at": .string(now), "quality": .string("confirmed"), "source": .string("device")])
    let node: JSONValue = .object(["matched": .bool(false), "model_revision": .string(revision), "observation": observation])
    let evaluation: JSONValue = .object(["evaluated_at": .string(now), "conditions": .array(rule.conditions), "matched": .bool(false), "results": .array([node])])
    var proof: [String: JSONValue] = ["revision": .string(revision), "matched": .bool(false), "executed": .bool(false), "simulation": .bool(true), "trigger_matched": .bool(true), "condition_evaluation": evaluation, "proposed_actions": .array([])]
    func decode(_ fields: [String: JSONValue]) throws -> Simulation { try decoder.decode(Simulation.self, from: Data(JSONValue.object(fields).jsonText.utf8)) }
    let valid = try decode(proof); try RuleProof.verify(valid, rule: rule, valid: true, validationRevision: revision); try check(valid.canDeploy, "unmet conditions can be reviewed")
    let metObservation = JSONValue.object(["value": .bool(true), "observed_at": .string(now), "quality": .string("confirmed"), "source": .string("device")])
    let metNode = JSONValue.object(["matched": .bool(true), "model_revision": .string(revision), "observation": metObservation])
    var met = proof; met["matched"] = .bool(true); met["proposed_actions"] = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(rule.actions)); met["condition_evaluation"] = .object(["evaluated_at": .string(now), "conditions": .array(rule.conditions), "matched": .bool(true), "results": .array([metNode])])
    try RuleProof.verify(try decode(met), rule: rule, valid: true, validationRevision: revision); checks += 1
    var corrupted = proof
    corrupted["condition_evaluation"] = .object(["evaluated_at": .string(now), "conditions": .array(rule.conditions), "matched": .bool(false), "results": .array([metNode])])
    do { try RuleProof.verify(try decode(corrupted), rule: rule, valid: true, validationRevision: revision); throw ConditionCheckFailure(name: "inconsistent node accepted") } catch is ConditionCheckFailure { throw ConditionCheckFailure(name: "node mismatch") } catch { checks += 1 }
    for (field, value) in [("trigger_matched", JSONValue.bool(false)), ("executed", .bool(true)), ("revision", .string("wrong")), ("condition_evaluation", .null), ("proposed_actions", .array([.object(["device": .string("lamp"), "set": .object(["path": .string("light.power"), "value": .bool(true)])])]))] {
        var changed = proof; changed[field] = value
        do { try RuleProof.verify(try decode(changed), rule: rule, valid: true, validationRevision: revision); throw ConditionCheckFailure(name: "bad proof accepted: " + field) } catch is ConditionCheckFailure { throw ConditionCheckFailure(name: field) } catch {}
        checks += 1
    }
    proof.removeValue(forKey: "trigger_matched")
    do { try RuleProof.verify(try decode(proof), rule: rule, valid: true, validationRevision: revision); throw ConditionCheckFailure(name: "missing trigger accepted") } catch is ConditionCheckFailure { throw ConditionCheckFailure(name: "missing trigger") } catch {}
    checks += 1
    return checks
}
func actualConditionChecks() async throws {
    let env = ProcessInfo.processInfo.environment, client = try GatewayClient(endpoint: ProcessInfo.processInfo.environment["LIMEIOT_ENDPOINT"]!, allowLoopbackHTTP: true)
    try await client.login(token: env["LIMEIOT_TOKEN"]!)
    let snapshot = try await client.snapshot()
    if env["LIMEIOT_CONDITION_PHASE"] == "read" {
        guard let run = snapshot.runs.first(where: { $0.eventId == "native-condition-met" }), run.error == nil, run.commandIds.count == 1,
              case .object(let evaluation) = run.conditionEvaluation, case .array(let results) = evaluation["results"], case .object(let group) = results.first,
              case .array(let children) = group["children"], case .object(let first) = children.first, case .object(let observation) = first["observation"], observation["value"] == .integer(50),
              let skipped = snapshot.runs.first(where: { $0.error == "rule_conditions_not_met" }), skipped.commandIds.isEmpty,
              ConditionEditor.evidenceRows(run.conditionEvaluation!).contains(where: { $0.contains("观测值 50.0") }) else { throw ConditionCheckFailure(name: "run evidence") }
        return
    }
    guard let original = snapshot.deployments.first?.rule, var forms = ConditionEditor.restore(original.conditions, sources: ConditionEditor.sources(snapshot)) else { throw ConditionCheckFailure(name: "gateway form") }
    forms[0].children[0].value = "45"
    guard let conditions = ConditionEditor.compile(forms, sources: ConditionEditor.sources(snapshot)), let first = original.actions.first else { throw ConditionCheckFailure(name: "compiled form") }
    let rule = Rule(id: original.id, trigger: original.trigger, target: first.device, path: first.operation.path, value: first.operation.value, cooldownMs: original.cooldownMs, type: first.operation.type, conditions: conditions)
    let proof = try await client.simulate(space: snapshot.space, rule: rule, eventData: .object(["count": .integer(1)]))
    guard !proof.matched, proof.canDeploy, proof.triggerMatched == true, proof.conditionEvaluation != nil, try await client.snapshot().commands.items.isEmpty else { throw ConditionCheckFailure(name: "unmet preview") }
    let deployment = try await client.deploy(space: snapshot.space, rule: rule)
    guard deployment.rule == rule, deployment.rule.cooldownMs == 1001 else { throw ConditionCheckFailure(name: "gateway deployment") }
}
