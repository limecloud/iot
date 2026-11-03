import Foundation
import LimeIoTKit

private enum VisionCheckFailure: Error { case failed(String), lost, storage }
private func visionCheck(_ value: Bool, _ name: String) throws { if !value { throw VisionCheckFailure.failed(name) } }
private func visionFails(_ operation: () async throws -> Void) async throws { do { try await operation() } catch { return }; throw VisionCheckFailure.failed("expected rejection") }
private func visionObject(_ value: JSONValue) -> [String: JSONValue] { if case .object(let object) = value { object } else { [:] } }
private func visionVector() throws -> [String: JSONValue] {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    return visionObject(try OtaJSON.parse(String(contentsOf: root.appendingPathComponent("tests/fixtures/vision/contract.json"), encoding: .utf8), response: true))
}
private actor VisionMemoryStore: SessionStore {
    var data: [String: Data] = [:], saves = 0, failAt = 0
    var pause = false, release: CheckedContinuation<Void, Never>?
    func configure(failAt: Int = 0, pause: Bool = false) { self.failAt = failAt; self.pause = pause }
    func replace(_ value: Data?) { data["https://nas.local#vision-observations"] = value }
    func resume() { release?.resume(); release = nil }
    func load(origin: String) -> Data? { data[origin] }
    func save(origin: String, data: Data?) async throws {
        saves += 1
        if saves == failAt { throw VisionCheckFailure.storage }
        self.data[origin] = data
        if pause { await withCheckedContinuation { release = $0 } }
    }
}
private actor VisionFixtureWire: HTTPTransport {
    let vector: [String: JSONValue]
    let store: VisionMemoryStore
    var requests: [URLRequest] = [], savedBeforePosts = true
    var drop = false, missing = false, reject = false, state = "running", corruption = ""
    init(_ vector: [String: JSONValue], _ store: VisionMemoryStore) { self.vector = vector; self.store = store }
    func configure(drop: Bool = false, missing: Bool = false, reject: Bool = false, state: String = "running", corruption: String = "") { self.drop = drop; self.missing = missing; self.reject = reject; self.state = state; self.corruption = corruption }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        func response(_ text: String, _ status: Int = 200, _ headers: [String: String]? = nil) -> (Data, HTTPURLResponse) { (Data(text.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!) }
        let path = request.url!.path
        if path.hasSuffix("/auth/session") { return response(#"{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}"#, 200, ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"]) }
        if path.hasSuffix("/capabilities") { return response(OtaJSON.canonical(.object(["vision": vector["capabilities"]!]))) }
        if request.httpMethod == "POST" {
            let saved = try OtaJSON.parse(String(decoding: await store.load(origin: "https://nas.local#vision-observations")!, as: UTF8.self), response: true)
            let records = visionObject(saved)["records"]!
            if case .array(let items) = records, let record = items.first.map(visionObject) {
                savedBeforePosts = savedBeforePosts && record["original"] == vector["original"]
                if path.hasSuffix("/discard") { savedBeforePosts = savedBeforePosts && record["discard_intents"] == .array([.string("discard-intent")]); state = state == "succeeded" ? "cleared" : "discarded" }
                else {
                    let input = try VisionRequests.parse(String(decoding: request.httpBody!, as: UTF8.self))
                    savedBeforePosts = savedBeforePosts && request.value(forHTTPHeaderField: "Idempotency-Key") == "original" && input == vector["normalized"]
                }
            } else { savedBeforePosts = false }
            if reject { return response(#"{"error":{"code":"vision_provider_rejected"}}"#, 422) }
            if drop { throw VisionCheckFailure.lost }
        }
        if missing { return response(#"{"error":{"code":"vision_not_found"}}"#, 404) }
        var task = visionObject(visionObject(vector["tasks"]!)[state] ?? visionObject(vector["invalid_tasks"]!)[state]!)
        switch corruption {
        case "digest": task["request_digest"] = .string("sha256:" + String(repeating: "0", count: 64))
        case "deployment": var deployment = visionObject(task["deployment"]!); deployment["model"] = .string("changed/model"); task["deployment"] = .object(deployment)
        case "identity": task["vision_id"] = .string("vision-other")
        case "time": task["updated_at"] = .string("2026-11-02T23:59:59.123Z")
        case "extra": task["text"] = .string("must reject")
        default: break
        }
        return response(OtaJSON.canonical(.object(task)))
    }
    var posts: [URLRequest] { requests.filter { $0.httpMethod == "POST" && $0.url!.path.contains("/vision-observations") } }
}
private func visionFixture(_ store: VisionMemoryStore, _ wire: VisionFixtureWire) async throws -> VisionClient {
    let gateway = try GatewayClient(endpoint: "https://nas.local", transport: wire)
    try await gateway.login(token: "owner-input"); return VisionClient(gateway: gateway, store: store)
}
func visionContractChecks() async throws -> Int {
    let vector = try visionVector(), input = vector["input"]!, normalized = vector["normalized"]!
    try visionCheck(VisionRequests.parse(OtaJSON.canonical(input)) == normalized, "shared normalized input")
    let fields = visionObject(input)
    for (key, value) in [("expires_at", JSONValue.string("2026-11-03T00:01:25.1234Z")), ("prompt", .string(" ")), ("content_type", .string("image/gif")), ("image_base64", .string("bad!"))] {
        var bad = fields; bad[key] = value; try await visionFails { _ = try VisionRequests.parse(OtaJSON.canonical(.object(bad))) }
    }
    do {
        let store = VisionMemoryStore(), wire = VisionFixtureWire(vector, store), client = try await visionFixture(store, wire)
        let capabilities = try await client.capabilities(space: "space-demo")
        try visionCheck(capabilities.configured, "bounded capabilities")
        let record = try await client.submit(space: "space-demo", input: input, key: "original")
        try visionCheck(record.original == vector["original"] && record.observation == visionObject(vector["tasks"]!)["running"], "JS UTF8 digest, scalar count and task")
        let saved = String(decoding: await store.load(origin: "https://nas.local#vision-observations")!, as: UTF8.self)
        try visionCheck(!saved.contains("青柠") && !saved.contains("owner-input") && !saved.contains("\"text\""), "no plaintext or session persisted")
        try visionCheck(await wire.savedBeforePosts, "original persisted before POST")
        _ = try await client.submit(space: "space-demo", input: normalized, key: "original")
        try await visionFails { _ = try await client.submit(space: "space-demo", input: input, key: "replacement") }
        var changed = visionObject(normalized); changed["prompt"] = .string("另一个问题")
        try await visionFails { _ = try await client.submit(space: "space-demo", input: .object(changed), key: "original") }
        try visionCheck(await wire.posts.count == 1, "same key GET, changed input and pending replacement zero POST")
    }
    for failAt in [1, 2] {
        let store = VisionMemoryStore(); await store.configure(failAt: failAt)
        let wire = VisionFixtureWire(vector, store), client = try await visionFixture(store, wire)
        try await visionFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        try visionCheck(await wire.posts.count == failAt - 1, "storage failure POST count")
        if failAt == 2 { _ = try await visionFixture(store, wire).resolve(space: "space-demo", key: "original"); try visionCheck(await wire.posts.count == 1, "failed receipt save only GET") }
    }
    do {
        let store = VisionMemoryStore(); await store.configure(pause: true)
        let wire = VisionFixtureWire(vector, store), client = try await visionFixture(store, wire)
        let pending = Task { try await client.submit(space: "space-demo", input: input, key: "original") }
        for _ in 0..<1000 { if await store.release != nil { break }; try await Task.sleep(for: .milliseconds(1)) }
        pending.cancel()
        let saved = String(decoding: await store.load(origin: "https://nas.local#vision-observations")!, as: UTF8.self)
        await store.replace(Data(saved.replacingOccurrences(of: "\"image_bytes\":68", with: "\"image_bytes\":69").utf8))
        await store.resume(); try await visionFails { _ = try await pending.value }
        try await visionFails { _ = try await client.records(space: "space-demo") }
        try visionCheck(await wire.posts.isEmpty, "cancel recovery rejects storage differing from intended bytes")
    }
    do {
        let store = VisionMemoryStore(), wire = VisionFixtureWire(vector, store); await wire.configure(drop: true)
        let client = try await visionFixture(store, wire)
        try await visionFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        let restored = try await visionFixture(store, wire); await wire.configure(missing: true)
        try await visionFails { _ = try await restored.resolve(space: "space-demo", key: "original") }
        try visionCheck(await restored.records(space: "space-demo").first?.status == "unresolved", "404 does not clear original")
        await wire.configure(state: "unknown"); _ = try await restored.resolve(space: "space-demo", key: "original")
        try await visionFails { _ = try await restored.submit(space: "space-demo", input: input, key: "replacement") }
        await wire.configure(state: "succeeded"); try await visionFails { _ = try await restored.resolve(space: "space-demo", key: "original") }
        await wire.configure(state: "unknown", corruption: "deployment"); try await visionFails { _ = try await restored.resolve(space: "space-demo", key: "original") }
        await wire.configure(state: "unknown")
        let discarded = try await restored.discard(space: "space-demo", key: "original", intent: "discard-intent")
        try visionCheck(discarded.status == "discarded" && discarded.text == nil, "explicit discard")
        _ = try await restored.discard(space: "space-demo", key: "original", intent: "discard-intent")
        let postCount = await wire.posts.count, persisted = await wire.savedBeforePosts
        try visionCheck(postCount == 2 && persisted, "discard intent stored, same intent only GET")
    }
    for corruption in ["digest", "time", "extra"] {
        let store = VisionMemoryStore(), wire = VisionFixtureWire(vector, store); await wire.configure(corruption: corruption)
        let client = try await visionFixture(store, wire)
        try await visionFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        try visionCheck(await client.records(space: "space-demo").first?.observation == nil, "invalid receipt leaves original unresolved")
        await wire.configure(); _ = try await visionFixture(store, wire).resolve(space: "space-demo", key: "original")
        try visionCheck(await wire.posts.count == 1, "invalid receipt never re-POSTs")
    }
    do {
        let store = VisionMemoryStore(), wire = VisionFixtureWire(vector, store), client = try await visionFixture(store, wire)
        _ = try await client.submit(space: "space-demo", input: input, key: "original")
        await wire.configure(state: "succeeded"); let success = try await client.resolve(space: "space-demo", key: "original")
        try visionCheck(success.text == "青柠🍋\n你好" && !success.pending, "verified UTF8 text returned only in memory")
        await wire.configure(); try await visionFails { _ = try await client.resolve(space: "space-demo", key: "original") }
        await wire.configure(state: "succeeded", corruption: "identity"); try await visionFails { _ = try await client.resolve(space: "space-demo", key: "original") }
        try visionCheck(await wire.posts.count == 1, "terminal rollback and identity drift rejected")
    }
    do {
        let store = VisionMemoryStore(), wire = VisionFixtureWire(vector, store); await wire.configure(reject: true)
        let client = try await visionFixture(store, wire)
        try await visionFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        let record = try await client.records(space: "space-demo").first!
        try visionCheck(record.status == "rejected" && !record.pending && record.rejectedCode == "vision_provider_rejected", "explicit rejection retained")
        try await visionFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        try visionCheck(await wire.posts.count == 1, "rejected original never re-POSTs")
    }
    do {
        let store = VisionMemoryStore(); await store.replace(Data("{broken".utf8))
        let wire = VisionFixtureWire(vector, store), client = try await visionFixture(store, wire)
        try await visionFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        let saves = await store.saves, posts = await wire.posts.count
        try visionCheck(saves == 0 && posts == 0, "bad store not overwritten")
        await store.replace(nil)
        let fresh = try await visionFixture(store, wire); _ = try await fresh.submit(space: "space-demo", input: input, key: "original")
        await store.replace(nil); try await visionFails { _ = try await fresh.submit(space: "space-demo", input: input, key: "removed") }
        try visionCheck(await wire.posts.count == 1, "external store removal blocks new writes")
    }
    do {
        let store = VisionMemoryStore(); await store.configure(pause: true)
        let wire = VisionFixtureWire(vector, store), client = try await visionFixture(store, wire)
        let pending = Task { try await client.submit(space: "space-demo", input: input, key: "original") }
        for _ in 0..<1000 { if await store.release != nil { break }; try await Task.sleep(for: .milliseconds(1)) }
        try visionCheck(await store.release != nil, "paused after original save")
        pending.cancel(); await store.resume()
        try await visionFails { _ = try await pending.value }
        try visionCheck(await wire.posts.isEmpty, "cancel after save zero POST")
        let saved = try await client.records(space: "space-demo")
        try visionCheck(saved.count == 1 && saved[0].observation == nil && saved[0].pending, "same client reconciles its exact original save")
    }
    do {
        let store = VisionMemoryStore(), wire = VisionFixtureWire(vector, store), client = try await visionFixture(store, wire)
        await wire.configure(state: "succeeded"); let success = try await client.submit(space: "space-demo", input: input, key: "original")
        try visionCheck(success.text == "青柠🍋\n你好", "unicode body")
        let saved = String(decoding: await store.load(origin: "https://nas.local#vision-observations")!, as: UTF8.self)
        try visionCheck(!saved.contains("青柠") && !saved.contains("\"text\"") && saved.contains("content_digest"), "only output metadata persisted")
        let restored = try await visionFixture(store, wire)
        try visionCheck(await restored.records(space: "space-demo").first?.text == nil, "process restore never restores plaintext")
        await wire.configure(state: "succeeded"); let cleared = try await restored.discard(space: "space-demo", key: "original", intent: "discard-intent")
        try visionCheck(cleared.text == nil && cleared.status == "succeeded", "server clearing does not fake failure")
        await wire.configure(state: "succeeded"); try await visionFails { _ = try await restored.resolve(space: "space-demo", key: "original") }
        try visionCheck(await wire.posts.count == 2 && !cleared.canDiscard, "clear once and reject late resurrection")
        await wire.configure(state: "cleared"); _ = try await restored.discard(space: "space-demo", key: "original", intent: "discard-intent")
        try visionCheck(await wire.posts.count == 2, "repeated clear intent only GET")
    }
    do {
        let expiry = "2026-11-03T00:01:25.123Z"
        let jpeg = Data([255,216,255,217])
        _ = try VisionRequests.input(bytes: jpeg, contentType: "image/jpeg", prompt: String(repeating: "🍋", count: 512), expiresAt: expiry)
        try await visionFails { _ = try VisionRequests.input(bytes: jpeg, contentType: "image/jpeg", prompt: String(repeating: "🍋", count: 513), expiresAt: expiry) }
        var maximum = Data([137,80,78,71,13,10,26,10]); maximum.append(Data(repeating: 0, count: VisionRequests.maxImageBytes - 8))
        _ = try VisionRequests.input(bytes: maximum, contentType: "image/png", prompt: "尺寸检查", expiresAt: expiry)
        maximum.append(0)
        try await visionFails { _ = try VisionRequests.input(bytes: maximum, contentType: "image/png", prompt: "尺寸检查", expiresAt: expiry) }
        try await visionFails { _ = try VisionRequests.parse(#"{"prompt":"a","prompt":"b"}"#) }
        // 原生库只检查格式标记与输入边界，完整静态图片解码仍由网关执行。
    }
    do {
        let store = VisionMemoryStore(), wire = VisionFixtureWire(vector, store), client = try await visionFixture(store, wire)
        await wire.configure(state: "timezone"); let result = try await client.submit(space: "space-demo", input: input, key: "original")
        try visionCheck(result.text == "青柠🍋\n你好", "network input normalizes equivalent timezones")
        _ = try await client.records(space: "space-demo")
    }
    for name in visionObject(vector["invalid_tasks"]!).keys.sorted() {
        let store = VisionMemoryStore(), wire = VisionFixtureWire(vector, store), client = try await visionFixture(store, wire)
        await wire.configure(state: name); try await visionFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        try visionCheck(await client.records(space: "space-demo").first?.observation == nil, "malformed output leaves unresolved original: " + name)
    }
    return 13
}
