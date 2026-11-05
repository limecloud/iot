import Foundation
import LimeIoTKit

private actor SpaceSelectionTransport: HTTPTransport {
    var paths: [String] = []
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        paths.append(path)
        let body: String
        if path == "/api/v1/auth/session" {
            body = "{\"authenticated\":true,\"csrf_token\":\"csrf\",\"expires_at\":\"2030-01-01T00:00:00Z\"}"
        } else if path == "/api/v1/spaces" {
            body = "{\"items\":[{\"space_id\":\"first\"},{\"space_id\":\"chosen\"}],\"next_cursor\":null}"
        } else if path.hasSuffix("/capabilities") {
            body = "{\"models\":{}}"
        } else { body = "{\"items\":[],\"next_cursor\":null}" }
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Set-Cookie":"__Host-limeiot_session=" + String(repeating:"a",count:64) + "; Secure; HttpOnly"])!)
    }
}
func explicitSpaceSelectionChecks() async throws {
    struct Failure: Error {}
    let transport = SpaceSelectionTransport()
    let client = try GatewayClient(endpoint:"https://gateway.example",transport:transport)
    try await client.login(token:"fixture")
    guard try await client.spaces().map(\.spaceId) == ["first","chosen"] else { throw Failure() }
    guard try await client.snapshot(space:"chosen").space == "chosen" else { throw Failure() }
    let paths = await transport.paths
    guard paths.filter({$0.hasPrefix("/api/v1/spaces/")}).allSatisfy({$0.hasPrefix("/api/v1/spaces/chosen/")}) else { throw Failure() }
    let count = paths.count
    do { _ = try await client.snapshot(space:"../other"); throw Failure() } catch GatewayError.invalidEndpoint {}
    guard await transport.paths.count == count else { throw Failure() }
    print("{\"space_selection_checks\":3,\"passed\":true}")
}
