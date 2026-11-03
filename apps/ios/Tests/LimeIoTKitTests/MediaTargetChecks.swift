import Foundation
import LimeIoTKit

private enum MediaTargetCheckFailure: Error { case failed(String) }
private func targetObject(_ value: JSONValue?) -> [String: JSONValue] { if case .object(let value) = value { value } else { [:] } }
private func targetArray(_ value: JSONValue?) -> [JSONValue] { if case .array(let value) = value { value } else { [] } }
private func targetCheck(_ value: Bool, _ name: String) throws { if !value { throw MediaTargetCheckFailure.failed(name) } }
private actor MediaTargetWire: HTTPTransport {
    let page: JSONValue
    let bindings: [String: JSONValue]
    private(set) var requests: [URLRequest] = []
    init(page: JSONValue, bindings: [String: JSONValue]) { self.page = page; self.bindings = bindings }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        if path.hasSuffix("/auth/session") {
            return (Data(#"{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"])!)
        }
        requests.append(request)
        let document: JSONValue
        if path.hasSuffix("/execution-adapters") { document = page }
        else if path.hasSuffix("/execution-binding"), let id = path.split(separator: "/").dropLast().last, let binding = bindings[String(id)] { document = binding }
        else { throw MediaTargetCheckFailure.failed("unexpected target request") }
        return (Data(OtaJSON.canonical(document).utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
private actor MediaTargetStore: SessionStore {
    func load(origin: String) throws -> Data? { throw MediaTargetCheckFailure.failed("target lookup must not load operation storage") }
    func save(origin: String, data: Data?) throws { throw MediaTargetCheckFailure.failed("target lookup must not save operation storage") }
}
private func readTargets(page: JSONValue, bindings: [String: JSONValue]) async throws -> ([MediaTarget], [URLRequest]) {
    let wire = MediaTargetWire(page: page, bindings: bindings)
    let gateway = try GatewayClient(endpoint: "https://nas.local", transport: wire)
    try await gateway.login(token: "target-fixture")
    let result = try await MediaClient(gateway: gateway, store: MediaTargetStore()).targets(space: "space-demo")
    return (result, await wire.requests)
}
func mediaTargetContractChecks() async throws -> Int {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let vector = targetObject(try OtaJSON.parse(String(contentsOf: root.appendingPathComponent("tests/fixtures/media/targets.json"), encoding: .utf8), response: true))
    let page = vector["page"]!, bindings = targetObject(vector["bindings"])
    let (targets, requests) = try await readTargets(page: page, bindings: bindings)
    try targetCheck(targets.map { JSONValue.string($0.deviceId) } == targetArray(vector["expected"]), "only current matching bound/composed targets")
    try targetCheck(targets.allSatisfy { $0.bindingRevision == "sha256:" + String(repeating: "3", count: 64) && $0.modelRevision == "sha256:" + String(repeating: "2", count: 64) && $0.target == "192.168.50.20:1400" && $0.udn == "uuid:" + $0.deviceId }, "target remains bound to observed revisions")
    let base = "/api/v1/spaces/space-demo"
    let devices = ["speaker-bound", "speaker-composed", "speaker-unbound", "speaker-mismatch"]
    let bindingPaths: [String] = devices.map { base + "/devices/" + $0 + "/execution-binding" }
    let expectedPaths = [base + "/execution-adapters"] + bindingPaths
    try targetCheck(requests.map { $0.url!.path } == expectedPaths, "each eligible candidate reads its current binding")
    try targetCheck(requests.allSatisfy { $0.httpMethod == "GET" && $0.httpBody == nil }, "target lookup never writes or authorizes")
    for item in targetArray(vector["invalid_pages"]) {
        let item = targetObject(item)
        do { _ = try await readTargets(page: item["page"]!, bindings: bindings) }
        catch { continue }
        throw MediaTargetCheckFailure.failed("invalid candidate page accepted")
    }
    for item in targetArray(vector["invalid_bindings"]) {
        var changed = bindings; changed["speaker-bound"] = targetObject(item)["binding"]
        do { _ = try await readTargets(page: page, bindings: changed) }
        catch { continue }
        throw MediaTargetCheckFailure.failed("invalid current binding accepted")
    }
    return 4
}
