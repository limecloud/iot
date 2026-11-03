import Foundation
import LimeIoTKit

private struct RuleCheckFailure: Error { let name: String }
func ruleActionContractChecks() throws -> Int {
    let decoder = JSONDecoder()
    let invoke = #"{"device":"tv","invoke":{"path":"remote.press","input":{"key":"home"}}}"#
    let action = try decoder.decode(Rule.Action.self, from: Data(invoke.utf8))
    guard action.operation.type == "action.invoke", action.operation.summary == "遥控：主页",
          try decoder.decode(JSONValue.self, from: JSONEncoder().encode(action)) == decoder.decode(JSONValue.self, from: Data(invoke.utf8)) else { throw RuleCheckFailure(name: "invoke round trip") }
    let legacy = #"{"device":"lamp","set":{"path":"light.power","value":true}}"#
    let set = try decoder.decode(Rule.Action.self, from: Data(legacy.utf8))
    guard set.operation.type == "property.set", try decoder.decode(JSONValue.self, from: JSONEncoder().encode(set)) == decoder.decode(JSONValue.self, from: Data(legacy.utf8)) else { throw RuleCheckFailure(name: "legacy rule changed") }
    for input in [
        #"{"device":"tv"}"#, #"{"device":"tv","invoke":null}"#,
        #"{"device":"tv","invoke":{"path":"remote.press"}}"#,
        #"{"device":"tv","invoke":{"path":"remote.press","input":{}},"set":null}"#,
        #"{"device":"tv","set":{"path":"audio.muted","value":true},"invoke":{"path":"remote.press","input":{}}}"#,
        #"{"device":"tv","invoke":{"path":"remote.press","input":{},"shell":"reboot"}}"#,
        #"{"device":"tv","set":{"path":"audio.muted"}}"#
    ] {
        guard (try? decoder.decode(Rule.Action.self, from: Data(input.utf8))) == nil else { throw RuleCheckFailure(name: "invalid action accepted: " + input) }
    }
    return 9
}
func actualRuleActionChecks() async throws {
    let env = ProcessInfo.processInfo.environment
    let client = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, allowLoopbackHTTP: true)
    try await client.login(token: env["LIMEIOT_TOKEN"]!)
    let snapshot = try await client.snapshot()
    let rule = Rule(id: "swift-action-rule", source: "device-button", event: "button.pressed", target: "device-lamp", path: "remote.press", value: .object(["key": .string("home")]), cooldownMs: 10000, type: "action.invoke")
    let proof = try await client.simulate(space: snapshot.space, rule: rule, eventData: .object(["count": .integer(1)]))
    guard proof.matched && !proof.executed && proof.simulation, try await client.snapshot().commands.items.isEmpty else { throw RuleCheckFailure(name: "simulation had effects") }
    let deployment = try await client.deploy(space: snapshot.space, rule: rule)
    let repeated = try await client.deploy(space: snapshot.space, rule: rule)
    let saved = try await client.snapshot()
    guard deployment.revision == repeated.revision, saved.deployments.first?.rule == rule, saved.commands.items.isEmpty else { throw RuleCheckFailure(name: "action rule deployment round trip") }
}
