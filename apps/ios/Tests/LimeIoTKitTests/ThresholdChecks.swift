import Foundation
import LimeIoTKit

private struct ThresholdCheckFailure: Error {}
func thresholdContractChecks() throws -> Int {
    let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
    let encoder = JSONEncoder(); encoder.keyEncodingStrategy = .convertToSnakeCase
    let source = Data(#"{"device":"sensor","property":{"path":"environment.temperature","unit":"celsius_x100","edge":"rising","threshold":2800,"hysteresis":100}}"#.utf8)
    let trigger = try decoder.decode(Rule.Trigger.self, from: source)
    guard trigger.event == nil, trigger.property?.summary == "温度上升越过 28.00 ℃，滞回 1.00 ℃",
          try decoder.decode(JSONValue.self, from: encoder.encode(trigger)) == decoder.decode(JSONValue.self, from: source) else { throw ThresholdCheckFailure() }
    let legacy = Rule.Trigger(device: "button", event: "button.pressed")
    guard try decoder.decode(JSONValue.self, from: encoder.encode(legacy)) == .object(["device": .string("button"), "event": .string("button.pressed")]) else { throw ThresholdCheckFailure() }
    for input in [#"{"device":"sensor"}"#, #"{"device":"sensor","property":null}"#,
        #"{"device":"sensor","event":"button.pressed","property":null}"#,
        #"{"device":"sensor","event":null}"#] {
        if (try? decoder.decode(Rule.Trigger.self, from: Data(input.utf8))) != nil { throw ThresholdCheckFailure() }
    }
    let schema = try decoder.decode(ValueSchema.self, from: Data(#"{"type":"integer","minimum":-4500,"maximum":13000}"#.utf8))
    guard let edited = ThresholdEditor.property(path: "environment.temperature", unit: "celsius_x100", schema: schema, edge: .rising, threshold: "28.03", hysteresis: "1"),
          edited.threshold == .integer(2803), edited.hysteresis == .integer(100),
          case .object(let samples) = ThresholdEditor.samples(edited, schema: schema),
          case .object(let current) = samples["current"], current["value"] == .integer(2804) else { throw ThresholdCheckFailure() }
    for text in ["", "NaN", "Infinity", "28.001", "1e2", "131"] {
        guard ThresholdEditor.property(path: edited.path, unit: edited.unit, schema: schema, edge: .rising, threshold: text, hysteresis: "1") == nil else { throw ThresholdCheckFailure() }
    }
    guard ThresholdEditor.number("0.29", schema: schema, unit: edited.unit) == .integer(29),
          ThresholdEditor.property(path: edited.path, unit: edited.unit, schema: schema, edge: .rising, threshold: "-45", hysteresis: "1") == nil,
          let ceiling = ThresholdEditor.property(path: edited.path, unit: edited.unit, schema: schema, edge: .rising, threshold: "130", hysteresis: "1"),
          ThresholdEditor.samples(ceiling, schema: schema) == nil else { throw ThresholdCheckFailure() }
    let changed = Rule(id: "edited", trigger: .init(device: "sensor", property: edited), target: "lamp", path: "light.brightness", value: .integer(30), cooldownMs: 10000)
    guard try decoder.decode(Rule.self, from: encoder.encode(changed)) == changed else { throw ThresholdCheckFailure() }
    return 4
}
func actualThresholdChecks() async throws {
    let env = ProcessInfo.processInfo.environment
    let client = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, allowLoopbackHTTP: true)
    try await client.login(token: env["LIMEIOT_TOKEN"]!)
    let snapshot = try await client.snapshot()
    guard let deployment = snapshot.deployments.first(where: { $0.rule.trigger.property != nil }),
          deployment.rule.trigger.summary == "温度上升越过 28.00 ℃，滞回 1.00 ℃" else { throw ThresholdCheckFailure() }
    guard let device = snapshot.devices.first(where: { $0.id == deployment.rule.trigger.device }),
          let model = snapshot.models[device.modelRevision],
          let schema = model.services.flatMap({ service in service.properties.filter { service.id + "." + $0.id == deployment.rule.trigger.property?.path }.map(\.schema) }).first,
          let samples = ThresholdEditor.samples(deployment.rule.trigger.property!, schema: schema) else { throw ThresholdCheckFailure() }
    let simulation = try await client.simulate(space: snapshot.space, rule: deployment.rule,
        eventData: samples)
    guard simulation.matched, !simulation.executed else { throw ThresholdCheckFailure() }
}
