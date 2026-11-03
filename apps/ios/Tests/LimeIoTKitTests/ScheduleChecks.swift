import Foundation
import LimeIoTKit

private struct ScheduleCheckFailure: Error {}
func scheduleContractChecks() throws -> Int {
    let decoder = JSONDecoder(), encoder = JSONEncoder()
    let source = Data(#"{"schedule":{"time":"22:00","time_zone":"Asia/Shanghai","weekdays":[1,3,7]}}"#.utf8)
    let trigger = try decoder.decode(Rule.Trigger.self, from: source)
    guard trigger.device.isEmpty, trigger.event == nil, trigger.property == nil,
          trigger.schedule?.timeZone == "Asia/Shanghai",
          try decoder.decode(JSONValue.self, from: encoder.encode(trigger)) == decoder.decode(JSONValue.self, from: source) else { throw ScheduleCheckFailure() }
    for text in [#"{"schedule":null}"#, #"{"schedule":{"time":"24:00","time_zone":"UTC","weekdays":[1]}}"#,
        #"{"schedule":{"time":"22:00","time_zone":"UTC","weekdays":[]}}"#,
        #"{"schedule":{"time":"22:00","time_zone":"UTC","weekdays":[1,1]}}"#,
        #"{"schedule":{"time":"22:00","time_zone":"UTC","weekdays":[0]}}"#,
        #"{"device":"","schedule":{"time":"22:00","time_zone":"UTC","weekdays":[1]}}"#,
        #"{"event":null,"schedule":{"time":"22:00","time_zone":"UTC","weekdays":[1]}}"#,
        #"{"schedule":{"time":"22:00","time_zone":"UTC","weekdays":[1],"extra":true}}"#] {
        if (try? decoder.decode(Rule.Trigger.self, from: Data(text.utf8))) != nil { throw ScheduleCheckFailure() }
    }
    guard Rule.Trigger.Schedule.fromForm(time: "22:00", timeZone: "Asia/Shanghai", weekdays: [7,1])?.weekdays == [7,1],
          Rule.Trigger.Schedule.fromForm(time: "22:00\n", timeZone: "UTC", weekdays: [1]) == nil,
          Rule.Trigger.Schedule.fromForm(time: "22:00", timeZone: "Unknown/Zone", weekdays: [1]) == nil,
          Rule.Trigger.Schedule.fromForm(time: "22:00", timeZone: "UTC", weekdays: []) == nil else { throw ScheduleCheckFailure() }
    return 13
}
func actualScheduleChecks() async throws {
    let env = ProcessInfo.processInfo.environment
    let client = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, allowLoopbackHTTP: true)
    try await client.login(token: env["LIMEIOT_TOKEN"]!)
    func rule(_ time: String) -> Rule { Rule(id: "native-schedule", trigger: .init(schedule: .init(time: time, timeZone: "Asia/Shanghai", weekdays: [1,3,7])), target: "device-lamp", path: "light.power", value: .bool(true), cooldownMs: 1001) }
    let snapshot = try await client.snapshot(), original = rule("22:00")
    let preview = try await client.simulate(space: snapshot.space, rule: original, eventData: .null)
    guard preview.matched, !preview.executed, try await client.snapshot().commands.items.isEmpty else { throw ScheduleCheckFailure() }
    _ = try await client.deploy(space: snapshot.space, rule: original)
    guard try await client.snapshot().deployments.first?.rule == original else { throw ScheduleCheckFailure() }
    let edited = rule("23:00")
    _ = try await client.simulate(space: snapshot.space, rule: edited, eventData: .null)
    let deployment = try await client.deploy(space: snapshot.space, rule: edited)
    guard try await client.snapshot().deployments.first?.rule == edited else { throw ScheduleCheckFailure() }
    try await client.stop(space: snapshot.space, deployment: deployment)
    guard try await client.snapshot().deployments.isEmpty, try await client.snapshot().commands.items.isEmpty else { throw ScheduleCheckFailure() }
}
