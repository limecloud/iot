import Foundation
import LimeIoTKit

private enum Failure: Error { case check(String) }
private func check(_ value: Bool, _ message: String) throws { if !value { throw Failure.check(message) } }
private func fixture() throws -> [String: JSONValue] {
    let url = URL(fileURLWithPath: "../../tests/fixtures/ai-catalog/contract.json")
    guard case .object(let value) = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url)) else { throw Failure.check("fixture") }; return value
}
private func changed(_ value: JSONValue, _ path: [String], _ replacement: JSONValue) -> JSONValue {
    guard let key = path.first else { return replacement }; let tail = Array(path.dropFirst())
    switch value {
    case .array(let items): return .array(items.enumerated().map { i, child in String(i) == key ? changed(child, tail, replacement) : child })
    case .object(var fields): fields[key] = changed(fields[key] ?? .null, tail, replacement); return .object(fields)
    default: return replacement
    }
}
private actor Wire: HTTPTransport {
    var raw: String; var status = 200; var gets = 0; var posts = 0; var hold = false; var waiting = false
    var release: CheckedContinuation<Void, Never>?
    init(_ raw: String) { self.raw = raw }
    func configure(raw: String? = nil, status: Int = 200, hold: Bool = false) { if let raw { self.raw = raw }; self.status = status; self.hold = hold }
    func resume() { release?.resume(); release = nil }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        if path.hasSuffix("/auth/session") { return (Data(#"{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"])!) }
        try check(request.httpMethod == "GET" && path == "/api/v1/spaces/space-demo/ai-catalog", "unexpected effect or path"); try check(request.value(forHTTPHeaderField: "Cookie") != nil, "session reused")
        gets += 1; let response = (Data(raw.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        if hold { waiting = true; await withCheckedContinuation { release = $0 }; waiting = false }; return response
    }
}
private actor LiveWire: HTTPTransport {
    let upstream = URLSessionTransport(); var gets = 0; var posts = 0
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        if request.url!.path.hasSuffix("/ai-catalog") { try check(request.httpMethod == "GET", "GET only"); gets += 1 }
        else { try check(request.url!.path.hasSuffix("/auth/session"), "unexpected API"); if request.httpMethod == "POST" { posts += 1 } }
        return try await upstream.send(request)
    }
}
@main struct AiCatalogChecks {
    @MainActor static func live(_ env: [String: String]) async throws {
        let wire = LiveWire(); let gateway = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, transport: wire, allowLoopbackHTTP: true)
        try await gateway.login(token: env["LIMEIOT_TOKEN"]!)
        let s = AiCatalogStore(load: { try await gateway.aiCatalog(space: "space-demo") }, authFailure: { _ in })
        s.refresh(); await s.waitForIdle(); guard let catalog = s.catalog else { throw Failure.check(s.message) }
        try check(catalog.entries.count == 5, "five definitions"); s.pause(); try check(s.catalog == nil, "clear on pause")
        let trace: JSONValue = .object(["passed": .bool(true), "host_ui_state": .bool(true), "catalog": catalog.document, "cleared_after_pause": .bool(s.catalog == nil), "discovery_gets": .integer(await wire.gets), "business_posts": .integer(0)])
        try check(await wire.posts == 1, "only session POST")
        try Data(trace.jsonText.utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_AI_NATIVE_TRACE"]!))
    }
    @MainActor static func main() async throws {
        let env = ProcessInfo.processInfo.environment
        if env["LIMEIOT_AI_NATIVE_TRACE"] != nil { try await live(env); return }
        let f = try fixture(), full = f["configured"]!, empty = f["unconfigured"]!
        for (raw, configured) in [(full, true), (empty, false)] {
            let catalog = try AiCatalog.parse(raw.jsonText, space: "space-demo")
            try check(catalog.document == raw && catalog.entries.count == 5 && catalog.entries.allSatisfy { $0.configured == configured }, "shared contract")
        }
        let configured = try AiCatalog.parse(full.jsonText, space: "space-demo")
        try check(configured.entries.first?.revision == nil && configured.entries.first?.model == "fixture:rules", "rule identity")
        guard case .object(let invalid) = f["invalid"] else { throw Failure.check("invalid vectors") }
        for (name, vector) in invalid {
            guard case .object(let v) = vector, case .array(let path) = v["path"] else { throw Failure.check("vector") }
            do { _ = try AiCatalog.parse(changed(full, path.map(\.text), v["value"]!).jsonText, space: "space-demo"); throw Failure.check("accepted " + name) } catch is AiCatalogError {}
        }
        let raw = full.jsonText
        _ = try AiCatalog.parse(raw.replacingOccurrences(of: "\"schema_version\":1", with: "\"schema_version\":1.0"), space: "space-demo")
        for bad in [raw.replacingOccurrences(of: "\"schema_version\":1", with: "\"schema_version\":1,\"schema_version\":1"), String(repeating: " ", count: 32769), raw + "{}", raw.replacingOccurrences(of: "\"schema_version\":1", with: "\"schema_version\":1.5")] {
            do { _ = try AiCatalog.parse(bad, space: "space-demo"); throw Failure.check("accepted raw JSON") } catch is AiCatalogError {}
        }
        let wire = Wire(raw); let gateway = try GatewayClient(endpoint: "https://nas.local", transport: wire); try await gateway.login(token: "fixture")
        var auth = 0; let s = AiCatalogStore(load: { try await gateway.aiCatalog(space: "space-demo") }, authFailure: { _ in auth += 1 })
        s.refresh(); s.refresh(); await s.waitForIdle(); try check(await wire.gets == 1 && s.catalog != nil, "one read")
        await wire.configure(raw: empty.jsonText); s.refresh(); await s.waitForIdle(); try check(s.catalog?.entries.allSatisfy { !$0.configured } == true, "unconfigured removes entries")
        await wire.configure(raw: raw.replacingOccurrences(of: "space-demo", with: "foreign")); s.refresh(); await s.waitForIdle(); try check(s.catalog == nil && s.message.contains("未通过校验"), "invalid clears")
        await wire.configure(raw: raw, hold: true); s.refresh()
        while !(await wire.waiting) { await Task.yield() }
        s.pause(); await wire.resume(); await Task.yield(); try check(s.catalog == nil && !s.busy, "late response ignored")
        await wire.configure(raw: raw); s.refresh(); await s.waitForIdle(); try check(s.catalog != nil, "fresh read")
        s.setOnline(false); let before = await wire.gets; s.refresh(); await s.waitForIdle(); let after = await wire.gets; try check(s.catalog == nil && after == before, "offline no reads")
        s.setOnline(true); await wire.configure(raw: #"{"error":{"code":"unauthenticated"}}"#, status: 401); s.refresh(); await s.waitForIdle(); try check(auth == 1 && s.catalog == nil, "auth delegated")
        s.close(); s.refresh(); try check(!s.busy && s.catalog == nil, "closed")
        print("Swift AI目录：共享合同、28组损坏、4组原始JSON及8组状态检查通过")
    }
}
