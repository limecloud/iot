import Foundation
import LimeIoTKit

private struct RecoveryFailure: Error { let name: String }
private struct RecoveryFixture: Decodable {
    struct Row: Decodable { let name: String; let valid: Bool; let expected: JSONValue; let response: JSONValue }
    let cases: [Row]
}
private actor RecoveryTransport: HTTPTransport {
    let response: JSONValue
    var methods: [String] = []
    init(_ response: JSONValue) { self.response = response }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        methods.append(request.httpMethod!)
        if request.url!.path == "/api/v1/auth/session" {
            return (Data(#"{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Set-Cookie": "__Host-limeiot_session=fixture; Secure; HttpOnly"])!)
        }
        return (try JSONEncoder().encode(response), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
func commandRecoveryContractChecks() async throws -> Int {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let file = ProcessInfo.processInfo.environment["LIMEIOT_COMMAND_RECOVERY_FIXTURE"].map { URL(fileURLWithPath: $0) } ?? root.appendingPathComponent("tests/fixtures/commands/recovery.json")
    let fixture = try JSONDecoder().decode(RecoveryFixture.self, from: Data(contentsOf: file))
    for row in fixture.cases {
        guard case .object(let expected) = row.expected, case .string(let space) = expected["space_id"], let key = expected["idempotency_key"] else { throw RecoveryFailure(name: row.name) }
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        let intent = try decoder.decode(CommandIntent.self, from: JSONEncoder().encode(JSONValue.object(["key": key, "input": row.expected])))
        let transport = RecoveryTransport(row.response), client = try GatewayClient(endpoint: "https://nas.local:8443", transport: transport)
        try await client.login(token: "fixture")
        for resolve in [false, true] {
            do {
                let result: Command
                if resolve { result = try await client.resolve(space: space, intent: intent) }
                else { result = try await client.create(space: space, intent: intent) }
                guard row.valid, result.commandId == "command-original" else { throw RecoveryFailure(name: row.name) }
            } catch GatewayError.invalidResponse {
                if row.valid { throw RecoveryFailure(name: row.name) }
            }
        }
        guard await transport.methods == ["POST", "POST", "GET"] else { throw RecoveryFailure(name: "request replay: " + row.name) }
    }
    return fixture.cases.count
}
