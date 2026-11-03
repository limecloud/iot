import Foundation
import LimeIoTKit

private struct EnvironmentCheckFailure: Error { let name: String }
func environmentContractChecks() throws -> Int {
    let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
    let temperature = try decoder.decode(Property.self, from: Data("{\"id\":\"temperature\",\"semantic_id\":\"urn:limeiot:property:temperature:1\",\"unit\":\"celsius_x100\",\"schema\":{\"type\":\"integer\"},\"access\":[\"read\",\"notify\"]}".utf8))
    for (input, expected) in [(2500, "25.00 ℃"), (-123, "-1.23 ℃"), (0, "0.00 ℃")] {
        guard temperature.displayValue(.integer(input)) == expected else { throw EnvironmentCheckFailure(name: "scaled temperature") }
    }
    guard temperature.displayName == "温度", temperature.displayValue(nil) == "暂无状态", !temperature.access.contains("write") else { throw EnvironmentCheckFailure(name: "readonly metadata") }
    let legacy = try decoder.decode(Property.self, from: Data("{\"id\":\"brightness\",\"schema\":{\"type\":\"integer\"},\"access\":[\"read\",\"write\"]}".utf8))
    guard legacy.displayValue(.integer(50)) == "50", legacy.unit == nil else { throw EnvironmentCheckFailure(name: "legacy property") }
    return 3
}
func actualEnvironmentChecks() async throws {
    let env = ProcessInfo.processInfo.environment
    let client = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, allowLoopbackHTTP: true)
    try await client.login(token: env["LIMEIOT_TOKEN"]!)
    let snapshot = try await client.snapshot()
    guard let device = snapshot.devices.first(where: { $0.id == "device-environment" }),
          let service = snapshot.models[device.modelRevision]?.services.first(where: { $0.id == "environment" }) else { throw EnvironmentCheckFailure(name: "environment missing") }
    let expected = ["temperature": "25.00 ℃", "humidity": "50.00 %RH"]
    for property in service.properties {
        guard !property.access.contains("write"), property.displayValue(device.reported["environment." + property.id]?.value) == expected[property.id] else { throw EnvironmentCheckFailure(name: "actual readonly sample") }
    }
    guard service.properties.count == 2 else { throw EnvironmentCheckFailure(name: "incomplete sample") }
}
