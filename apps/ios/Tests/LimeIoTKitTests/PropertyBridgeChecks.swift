import Foundation
import LimeIoTKit

private enum BridgeCheckError: Error { case failed(String) }
private func bridgeCheck(_ value: Bool, _ name: String) throws {
    if !value { throw BridgeCheckError.failed(name) }
}

// 真实请求完成后丢弃响应，验证调用方只查询原键。
private actor BridgeResponseLoss: HTTPTransport {
    private let transport = URLSessionTransport()
    private var dropped = false
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let response = try await transport.send(request)
        if request.httpMethod == "POST", request.url?.path.hasSuffix("/commands") == true, !dropped {
            dropped = true
            throw URLError(.networkConnectionLost)
        }
        return response
    }
}

func propertyBridgeLiveChecks() async throws {
    let env = ProcessInfo.processInfo.environment
    guard let endpoint = env["LIMEIOT_ENDPOINT"], let token = env["LIMEIOT_TOKEN"],
          let phase = env["LIMEIOT_BRIDGE_PHASE"], let original = env["LIMEIOT_BRIDGE_ORIGINAL"],
          let trace = env["LIMEIOT_BRIDGE_TRACE"], ["create", "restore"].contains(phase) else {
        throw BridgeCheckError.failed("missing fixture configuration")
    }
    let client = try GatewayClient(endpoint: endpoint, transport: phase == "create" ? BridgeResponseLoss() : URLSessionTransport(), allowLoopbackHTTP: true)
    try await client.login(token: token)
    let snapshot = try await client.snapshot()
    guard let device = snapshot.devices.first(where: { $0.deviceId == "zigbee-switch" }) else {
        throw BridgeCheckError.failed("switch missing")
    }
    try bridgeCheck(device.ready && snapshot.models[device.modelRevision] != nil, "model and fresh device")
    let intent: CommandIntent
    let command: Command
    if phase == "create" {
        intent = CommandIntent(device: device, path: "light.power", value: .bool(true))
        let url = URL(fileURLWithPath: original)
        try JSONEncoder().encode(intent).write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: original)
        let saved = try JSONDecoder().decode(CommandIntent.self, from: Data(contentsOf: url))
        try bridgeCheck(saved.key == intent.key, "original saved before POST")
        do { _ = try await client.create(space: snapshot.space, intent: intent); throw BridgeCheckError.failed("response loss expected") }
        catch let error as URLError { try bridgeCheck(error.code == .networkConnectionLost, "response lost") }
    } else {
        intent = try JSONDecoder().decode(CommandIntent.self, from: Data(contentsOf: URL(fileURLWithPath: original)))
    }
    var result = try await client.resolve(space: snapshot.space, key: intent.key)
    for _ in 0..<100 {
        if !["accepted", "dispatched"].contains(result.status) { break }
        try await Task.sleep(for: .milliseconds(100))
        result = try await client.command(space: snapshot.space, id: result.commandId)
    }
    command = result
    try bridgeCheck(command.status == "confirmed", "independent readback confirmed")
    try bridgeCheck(command.request.deviceId == device.deviceId && command.request.operation.value == .bool(true), "original request")
    guard case .object(let evidence) = command.evidence else { throw BridgeCheckError.failed("evidence missing") }
    try bridgeCheck(evidence["type"] == .string("property_observation_result"), "bridge evidence decoded")
    let current = try await client.snapshot()
    try bridgeCheck(current.devices.first(where: { $0.deviceId == device.deviceId })?.reported["light.power"]?.value == .bool(true), "reported readback")
    let report: [String: Any] = ["passed": true, "phase": phase, "key": intent.key, "command_id": command.commandId,
                               "status": command.status, "command_posts": phase == "create" ? 1 : 0]
    try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]).write(to: URL(fileURLWithPath: trace), options: .atomic)
    try await client.logout()
}
