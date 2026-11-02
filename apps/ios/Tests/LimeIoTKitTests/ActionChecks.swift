import Foundation
import LimeIoTKit

private struct ActionCheckFailure: Error { let name: String }
private actor LostActionResponse: HTTPTransport {
    private let base = URLSessionTransport()
    private var dropped = false
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let response = try await base.send(request)
        if request.httpMethod == "POST", request.url!.path.hasSuffix("/commands"), !dropped {
            dropped = true; throw URLError(.networkConnectionLost)
        }
        return response
    }
}
func actualActionChecks() async throws {
    let env = ProcessInfo.processInfo.environment
    let client = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, transport: LostActionResponse(), allowLoopbackHTTP: true)
    try await client.login(token: env["LIMEIOT_TOKEN"]!)
    let snapshot = try await client.snapshot()
    guard let device = snapshot.devices.first(where: { $0.deviceId == "device-lamp" }),
          let model = snapshot.models[device.modelRevision], model.services.flatMap({ $0.actions ?? [] }).count == 2,
          model.services.first(where: { $0.id == "remote" })?.actions?.first?.input.properties?["key"]?.enumValues?.contains(.string("home")) == true else { throw ActionCheckFailure(name: "action model not discovered") }
    let intent = CommandIntent(device: device, path: "remote.press", value: .object(["key": .string("home")]), type: "action.invoke")
    do { _ = try await client.create(space: snapshot.space, intent: intent); throw ActionCheckFailure(name: "expected response loss") } catch is URLError {}
    var command = try await client.resolve(space: snapshot.space, key: intent.key)
    for _ in 0..<50 {
        if command.status == "confirmed" { break }
        try await Task.sleep(for: .milliseconds(100)); command = try await client.command(space: snapshot.space, id: command.id)
    }
    guard command.statusText == "输入已提交", command.request.operation.summary == "遥控：主页" else { throw ActionCheckFailure(name: "wrong action scope") }
    guard try await client.resolve(space: snapshot.space, key: intent.key).id == command.id else { throw ActionCheckFailure(name: "original key changed") }
    let launch = CommandIntent(device: device, path: "apps.launch", value: .object(["application_id": .string("org.example.player")]), type: "action.invoke")
    var application = try await client.create(space: snapshot.space, intent: launch)
    for _ in 0..<50 {
        if application.status == "confirmed" { break }
        try await Task.sleep(for: .milliseconds(100)); application = try await client.command(space: snapshot.space, id: application.id)
    }
    guard application.statusText == "输入已提交", application.request.operation.summary == "启动应用：org.example.player" else { throw ActionCheckFailure(name: "application action failed") }
    try await client.logout()
}
