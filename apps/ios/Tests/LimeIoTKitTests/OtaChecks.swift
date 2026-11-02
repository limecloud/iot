import Foundation
import LimeIoTKit

private enum OtaCheckFailure: Error { case failed(String), lost, storage }
private func otaCheck(_ result: Bool, _ name: String) throws { if !result { throw OtaCheckFailure.failed(name) } }
private func otaMustFail(_ operation: () async throws -> Void) async throws {
    do { try await operation() } catch { return }; throw OtaCheckFailure.failed("expected rejection")
}
private actor OtaMemoryStore: SessionStore {
    var data: [String: Data] = [:]; var saves = 0; var failAt = 0
    func configure(failAt: Int) { self.failAt = failAt }
    func replace(_ value: Data?) { data["https://nas.local#ota-operations"] = value }
    func load(origin: String) -> Data? { data[origin] }
    func save(origin: String, data: Data?) throws { saves += 1; if saves == failAt { throw OtaCheckFailure.storage }; self.data[origin] = data }
}
private actor OtaFixtureTransport: HTTPTransport {
    var requests: [URLRequest] = [], results: [String: JSONValue] = [:]
    var drop = false, misbind = false, missing = false, delayPost = false
    func configure(drop: Bool = false, misbind: Bool = false, missing: Bool = false, delayPost: Bool = false) { self.drop = drop; self.misbind = misbind; self.missing = missing; self.delayPost = delayPost }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        func response(_ data: Data, _ status: Int = 200, _ headers: [String: String]? = nil) -> (Data, HTTPURLResponse) { (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!) }
        if request.url!.path.hasSuffix("/auth/session") { return response(Data(#"{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}"#.utf8), 200, ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"]) }
        if request.httpMethod == "POST" {
            if delayPost { try await Task.sleep(for: .milliseconds(100)) }
            let key = request.value(forHTTPHeaderField: "Idempotency-Key")!, change = try OtaJSON.change(String(data: request.httpBody!, encoding: .utf8)!)
            guard case .object(let c) = change else { throw OtaCheckFailure.failed("change") }
            let original = JSONValue.object(["space_id": .string("space-demo"), "idempotency_key": .string(key), "change": change])
            let revoke = c["type"] == .string("trust.revoke")
            let resource = JSONValue.object(["kind": .string(revoke ? "firmware_trust" : "ota_task"), "id": revoke ? c["trust_id"]! : c["task_id"] ?? .string("ota-fixture"), "revision": .string("revision-current")])
            var result: [String: JSONValue] = ["operation_id": .string("otaop-" + key), "request": original, "request_digest": .string(OtaJSON.digest(original)), "status": .string("applied"), "reason": .null, "resource": resource, "created_at": .string("2026-11-02T00:00:00Z")]
            results[key] = .object(result)
            if drop { throw OtaCheckFailure.lost }
            if misbind { result["request_digest"] = .string("sha256:" + String(repeating: "0", count: 64)) }
            return response(Data(OtaJSON.canonical(.object(result)).utf8))
        }
        let key = request.url!.lastPathComponent
        guard !missing, let result = results[key] else { return response(Data(#"{"error":{"code":"not_found"}}"#.utf8), 404) }
        return response(Data(OtaJSON.canonical(result).utf8))
    }
    var posts: [URLRequest] { requests.filter { $0.httpMethod == "POST" && $0.url!.path.hasSuffix("/ota-operations") } }
}
private let nativePlan = #"{"type":"tasks.plan","device_id":"device-lamp","trust_id":"fwtrust-"# + String(repeating: "1", count: 64) + #"","manifest":{},"expires_at":"2030-01-01T00:00:00Z"}"#
private func otaFixture(_ store: OtaMemoryStore, _ wire: OtaFixtureTransport) async throws -> OtaClient {
    let gateway = try GatewayClient(endpoint: "https://nas.local", transport: wire)
    try await gateway.login(token: "owner-input"); return OtaClient(gateway: gateway, store: store)
}
func otaContractChecks() async throws -> Int {
    for text in [#"{"a":1,"\u0061":2}"#, #"{"n":9007199254740992}"#, #"{"n":0.5}"#, #"{"n":1e99999999}"#, #"{"n":01}"#, #"{"s":"\ud800"}"#, #"{"a":[1,]}"#] {
        try await otaMustFail { _ = try OtaJSON.parse(text) }
    }
    try otaCheck(OtaJSON.canonical(OtaJSON.parse(#"{"中文":"/\n","b":-0,"a":1e0}"#)) == "{\"a\":1,\"b\":0,\"中文\":\"/\\n\"}", "canonical integers and strings")
    try otaCheck(OtaJSON.digest(OtaJSON.parse(#"{"a":1}"#)) == "sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862", "JCS digest")
    let plan = try OtaJSON.change(nativePlan)
    do {
        let store = OtaMemoryStore(), wire = OtaFixtureTransport(); await store.configure(failAt: 1)
        let client = try await otaFixture(store, wire)
        try await otaMustFail { _ = try await client.submit(space: "space-demo", change: plan, key: "first") }
        try otaCheck(await wire.posts.isEmpty, "storage failure zero POST")
    }
    do {
        let store = OtaMemoryStore(), wire = OtaFixtureTransport(); await wire.configure(drop: true)
        let client = try await otaFixture(store, wire)
        try await otaMustFail { _ = try await client.submit(space: "space-demo", change: plan, key: "original") }
        try otaCheck(await client.records(space: "space-demo").first?.result == nil, "unknown original retained")
        try await otaMustFail { _ = try await client.submit(space: "space-demo", change: plan, key: "replacement") }
        try otaCheck(await wire.posts.count == 1, "unknown plan blocks new key")
        let restored = try await otaFixture(store, wire); await wire.configure(missing: true)
        try await otaMustFail { _ = try await restored.resolve(space: "space-demo", key: "original") }
        try otaCheck(await restored.records(space: "space-demo").first?.result == nil, "404 preserves uncertainty")
        await wire.configure()
        try otaCheck(await restored.resolve(space: "space-demo", key: "original").result != nil, "original recovered")
        _ = try await restored.submit(space: "space-demo", change: plan, key: "original")
        let posts = await wire.posts, last = await wire.requests.last!
        try otaCheck(posts.count == 1 && last.httpMethod == "GET" && last.url!.path.hasSuffix("/by-key/original"), "same key GET only")
        try otaCheck(posts[0].value(forHTTPHeaderField: "X-CSRF-Token") == "csrf" && posts[0].value(forHTTPHeaderField: "Origin") == "https://nas.local" && posts[0].value(forHTTPHeaderField: "Authorization") == nil, "local authentication")
        try otaCheck(OtaJSON.parse(String(data: posts[0].httpBody!, encoding: .utf8)!) == plan, "HTTP body mapping")
    }
    for misbind in [true, false] {
        let store = OtaMemoryStore(), wire = OtaFixtureTransport(); await wire.configure(misbind: misbind)
        if !misbind { await store.configure(failAt: 2) }
        let client = try await otaFixture(store, wire)
        try await otaMustFail { _ = try await client.submit(space: "space-demo", change: plan, key: "original") }
        try otaCheck(await client.records(space: "space-demo").first?.result == nil, "unverified result stays unknown")
        let restored = try await otaFixture(store, wire)
        try otaCheck(await restored.resolve(space: "space-demo", key: "original").result != nil, "read-only recovery")
        try otaCheck(await wire.posts.count == 1, "one POST after result failure")
    }
    do {
        let store = OtaMemoryStore(), wire = OtaFixtureTransport(); await store.replace(Data("{broken".utf8))
        let client = try await otaFixture(store, wire)
        try await otaMustFail { _ = try await client.submit(space: "space-demo", change: plan, key: "first") }
        try otaCheck(await store.load(origin: "https://nas.local#ota-operations") == Data("{broken".utf8), "corrupt record preserved")
        let savedCount = await store.saves, posts = await wire.posts
        try otaCheck(savedCount == 0 && posts.isEmpty, "corruption zero writes or POST")
        let secondStore = OtaMemoryStore(), second = try await otaFixture(secondStore, wire)
        _ = try await second.submit(space: "space-demo", change: plan, key: "saved"); await secondStore.replace(nil)
        try await otaMustFail { _ = try await second.submit(space: "space-demo", change: plan, key: "new") }
        try otaCheck(await wire.posts.count == 1, "removed record blocks new writes")
    }
    do {
        let store = OtaMemoryStore(), wire = OtaFixtureTransport(); await wire.configure(drop: true)
        let client = try await otaFixture(store, wire)
        try await otaMustFail { _ = try await client.submit(space: "space-demo", change: plan, key: "plan") }; await wire.configure()
        let change = try OtaJSON.change(#"{"type":"trust.revoke","trust_id":"fwtrust-"# + String(repeating: "1", count: 64) + #"","expected_revision":"current"}"#)
        try otaCheck(await client.submit(space: "space-demo", change: change, key: "revoke").result != nil, "explicit revocation remains available")
        try otaCheck(await wire.posts.count == 2, "revocation independently submitted")
    }
    do {
        let store = OtaMemoryStore(), wire = OtaFixtureTransport(); await wire.configure(delayPost: true)
        let first = try await otaFixture(store, wire), second = try await otaFixture(store, wire)
        let running = Task { try await first.submit(space: "space-demo", change: plan, key: "shared") }
        for _ in 0..<100 { if await wire.posts.count == 1 { break }; try await Task.sleep(for: .milliseconds(5)) }
        try await otaMustFail { _ = try await second.submit(space: "space-demo", change: plan, key: "shared") }
        _ = try await running.value
        _ = try await second.submit(space: "space-demo", change: plan, key: "shared")
        try otaCheck(await wire.posts.count == 1, "cross-instance record serialization")
    }
    return 7
}

private actor OtaLiveTransport: HTTPTransport {
    var upstream = URLSessionTransport()
    var posts = 0
    func reconnect() { upstream = URLSessionTransport() }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result = try await upstream.send(request)
        if request.httpMethod == "POST", request.url!.path.hasSuffix("/ota-operations") {
            posts += 1
            if let body = request.httpBody, case .object(let change) = try OtaJSON.parse(String(data: body, encoding: .utf8)!), change["type"] == .string("tasks.execute") { throw OtaCheckFailure.lost }
        }
        return result
    }
}
func actualOtaChecks() async throws {
    let env = ProcessInfo.processInfo.environment, origin = env["LIMEIOT_ENDPOINT"]!
    let vector = try OtaJSON.parse(String(contentsOfFile: env["LIMEIOT_OTA_VECTOR"]!, encoding: .utf8), response: true)
    guard case .object(let root) = vector, case .object(let input) = root["request"], let trust = input["trust"], let manifest = input["manifest"], case .object(let t) = trust, let fingerprint = t["signing_key_id"] else { throw OtaCheckFailure.failed("vector") }
    let store = OtaMemoryStore(), wire = OtaLiveTransport(), space = "space-demo"
    let gateway = try GatewayClient(endpoint: origin, transport: wire, store: store, allowLoopbackHTTP: true)
    try await gateway.login(token: env["LIMEIOT_TOKEN"]!)
    let client = OtaClient(gateway: gateway, store: store)
    let add = JSONValue.object(["type": .string("trust.add"), "trust": trust, "expected_signing_key_id": fingerprint])
    _ = try await client.submit(space: space, change: add, key: "native-trust")
    let trusted = try await client.trusts(space: space).first!
    let plan = JSONValue.object(["type": .string("tasks.plan"), "device_id": .string("device-lamp"), "trust_id": .string(trusted.id), "manifest": manifest, "expires_at": .string(ISO8601DateFormatter().string(from: Date().addingTimeInterval(600)))])
    func transition(_ task: OtaTask, _ type: String) -> JSONValue { .object(["type": .string(type), "task_id": .string(task.id), "expected_revision": .string(task.revision)]) }
    func checkpoint(_ name: String) async throws {
        let (_, response) = try await URLSession.shared.data(from: URL(string: env["LIMEIOT_OTA_FIXTURE"]! + "/" + name)!)
        try otaCheck((response as? HTTPURLResponse)?.statusCode == 200, "fixture checkpoint " + name)
    }
    _ = try await client.submit(space: space, change: plan, key: "cancel-plan")
    let cancelled = try await client.tasks(space: space).first!
    _ = try await client.submit(space: space, change: transition(cancelled, "tasks.cancel"), key: "cancel")
    try otaCheck(await client.task(space: space, id: cancelled.id).status == "cancelled", "explicit cancellation")
    _ = try await client.submit(space: space, change: plan, key: "install-plan")
    var task = try await client.tasks(space: space).first { $0.status == "planned" }!
    _ = try await client.submit(space: space, change: transition(task, "tasks.approve"), key: "approve")
    task = try await client.task(space: space, id: task.id)
    try otaCheck(task.status == "approved", "approved without install"); try await checkpoint("approved")
    let execute = transition(task, "tasks.execute")
    try await otaMustFail { _ = try await client.submit(space: space, change: execute, key: "execute") }
    try await otaMustFail { _ = try await client.submit(space: space, change: plan, key: "replacement-plan") }
    let restoredGateway = try GatewayClient(endpoint: origin, transport: wire, store: store, allowLoopbackHTTP: true)
    try await restoredGateway.restore()
    var restored = OtaClient(gateway: restoredGateway, store: store)
    _ = try await restored.resolve(space: space, key: "execute")
    try await checkpoint("restart")
    await wire.reconnect()
    let resumedGateway = try GatewayClient(endpoint: origin, transport: wire, store: store, allowLoopbackHTTP: true)
    try await resumedGateway.login(token: env["LIMEIOT_TOKEN"]!)
    restored = OtaClient(gateway: resumedGateway, store: store)
    _ = try await restored.resolve(space: space, key: "execute")
    task = try await restored.task(space: space, id: task.id)
    try otaCheck(task.status == "unknown", "restart preserves unknown")
    _ = try await restored.submit(space: space, change: transition(task, "tasks.reconcile"), key: "reconcile")
    try await checkpoint("complete")
    for _ in 0..<40 { task = try await restored.task(space: space, id: task.id); if task.status == "succeeded" { break }; try await Task.sleep(for: .milliseconds(100)) }
    try otaCheck(task.status == "succeeded", "new boot evidence")
    _ = try await restored.submit(space: space, change: .object(["type": .string("trust.revoke"), "trust_id": .string(trusted.id), "expected_revision": .string(trusted.revision)]), key: "revoke")
    let records = try await restored.records(space: space)
    try otaCheck(records.count == 8 && records.allSatisfy { $0.result != nil }, "all original decisions durable")
    let posts = await wire.posts; try otaCheck(posts == 8, "no replacement POST")
    try Data("{\"passed\":true,\"posts\":\(posts),\"original_records\":\(records.count),\"hardware\":false,\"native_app_runtime\":false}".utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_OTA_TRACE"]!))
}
