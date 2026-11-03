import Foundation
import LimeIoTKit

private enum SpeechCheckFailure: Error { case failed(String), lost, storage }
private func speechCheck(_ value: Bool, _ name: String) throws { if !value { throw SpeechCheckFailure.failed(name) } }
private func speechFails(_ operation: () async throws -> Void) async throws { do { try await operation() } catch { return }; throw SpeechCheckFailure.failed("expected rejection") }
private func speechObject(_ value: JSONValue) -> [String: JSONValue] { if case .object(let object) = value { object } else { [:] } }
private func speechVector() throws -> [String: JSONValue] {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    return speechObject(try OtaJSON.parse(String(contentsOf: root.appendingPathComponent("tests/fixtures/speech/contract.json"), encoding: .utf8), response: true))
}
private actor SpeechMemoryStore: SessionStore {
    var data: [String: Data] = [:], saves = 0, failAt = 0
    var pause = false, release: CheckedContinuation<Void, Never>?
    func configure(failAt: Int = 0, pause: Bool = false) { self.failAt = failAt; self.pause = pause }
    func replace(_ value: Data?) { data["https://nas.local#speech-syntheses"] = value }
    func resume() { release?.resume(); release = nil }
    func load(origin: String) -> Data? { data[origin] }
    func save(origin: String, data: Data?) async throws {
        saves += 1
        if saves == failAt { throw SpeechCheckFailure.storage }
        self.data[origin] = data
        if pause { await withCheckedContinuation { release = $0 } }
    }
}
private actor SpeechFixtureWire: HTTPTransport {
    let vector: [String: JSONValue]
    let store: SpeechMemoryStore
    var requests: [URLRequest] = [], savedBeforePosts = true
    var drop = false, missing = false, reject = false, state = "running", corruption = ""
    init(_ vector: [String: JSONValue], _ store: SpeechMemoryStore) { self.vector = vector; self.store = store }
    func configure(drop: Bool = false, missing: Bool = false, reject: Bool = false, state: String = "running", corruption: String = "") { self.drop = drop; self.missing = missing; self.reject = reject; self.state = state; self.corruption = corruption }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        func response(_ text: String, _ status: Int = 200, _ headers: [String: String]? = nil) -> (Data, HTTPURLResponse) { (Data(text.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!) }
        let path = request.url!.path
        if path.hasSuffix("/auth/session") { return response(#"{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}"#, 200, ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"]) }
        if path.hasSuffix("/capabilities") { return response(OtaJSON.canonical(.object(["speech": vector["capabilities"]!]))) }
        if request.httpMethod == "POST" {
            let saved = try OtaJSON.parse(String(decoding: await store.load(origin: "https://nas.local#speech-syntheses")!, as: UTF8.self), response: true)
            let records = speechObject(saved)["records"]!
            if case .array(let items) = records, let record = items.first.map(speechObject) {
                savedBeforePosts = savedBeforePosts && record["original"] == vector["original"]
                if path.hasSuffix("/discard") { savedBeforePosts = savedBeforePosts && record["discard_intents"] == .array([.string("discard-intent")]); state = "discarded" }
                else {
                    let input = try SpeechRequests.parse(String(decoding: request.httpBody!, as: UTF8.self))
                    savedBeforePosts = savedBeforePosts && request.value(forHTTPHeaderField: "Idempotency-Key") == "original" && input == vector["normalized"]
                }
            } else { savedBeforePosts = false }
            if reject { return response(#"{"error":{"code":"speech_voice_unavailable"}}"#, 422) }
            if drop { throw SpeechCheckFailure.lost }
        }
        if missing { return response(#"{"error":{"code":"speech_synthesis_not_found"}}"#, 404) }
        var task = speechObject(speechObject(vector["tasks"]!)[state]!)
        switch corruption {
        case "digest": task["request_digest"] = .string("sha256:" + String(repeating: "0", count: 64))
        case "deployment": var deployment = speechObject(task["deployment"]!); deployment["model"] = .string("changed/model"); task["deployment"] = .object(deployment)
        case "identity": task["synthesis_id"] = .string("speech-other")
        case "time": task["updated_at"] = .string("2026-11-02T23:59:59.123Z")
        case "extra": task["text"] = .string("must reject")
        default: break
        }
        return response(OtaJSON.canonical(.object(task)))
    }
    var posts: [URLRequest] { requests.filter { $0.httpMethod == "POST" && $0.url!.path.contains("/speech-syntheses") } }
}
private func speechFixture(_ store: SpeechMemoryStore, _ wire: SpeechFixtureWire) async throws -> SpeechClient {
    let gateway = try GatewayClient(endpoint: "https://nas.local", transport: wire)
    try await gateway.login(token: "owner-input"); return SpeechClient(gateway: gateway, store: store)
}
func speechContractChecks() async throws -> Int {
    let vector = try speechVector(), input = vector["input"]!, normalized = vector["normalized"]!
    try speechCheck(SpeechRequests.parse(OtaJSON.canonical(input)) == normalized, "shared normalized input")
    let fields = speechObject(input)
    for text in ["", " \t\n\u{FEFF}", String(repeating: "🍋", count: 1001), "bad\u{0000}", "bad\u{0085}"] {
        try await speechFails { _ = try SpeechRequests.input(text: text, voice: "local") }
    }
    for (key, value) in [("expires_at", JSONValue.string("2026-11-03T00:01:25.1234Z")), ("voice", .string("bad voice")), ("retain_seconds", .integer(59)), ("text", .string("bad\rtext"))] {
        var bad = fields; bad[key] = value; try await speechFails { _ = try SpeechRequests.parse(OtaJSON.canonical(.object(bad))) }
    }
    do {
        let store = SpeechMemoryStore(), wire = SpeechFixtureWire(vector, store), client = try await speechFixture(store, wire)
        let capabilities = try await client.capabilities(space: "space-demo")
        try speechCheck(capabilities.configured && capabilities.voices == ["local", "other"], "bounded capabilities")
        let record = try await client.submit(space: "space-demo", input: input, key: "original")
        try speechCheck(record.original == vector["original"] && record.result == speechObject(vector["tasks"]!)["running"], "JS UTF8 digest, scalar count and task")
        let saved = String(decoding: await store.load(origin: "https://nas.local#speech-syntheses")!, as: UTF8.self)
        try speechCheck(!saved.contains("青柠") && !saved.contains("owner-input") && !saved.contains("\"text\""), "no plaintext or session persisted")
        try speechCheck(await wire.savedBeforePosts, "original persisted before POST")
        _ = try await client.submit(space: "space-demo", input: normalized, key: "original")
        try await speechFails { _ = try await client.submit(space: "space-demo", input: input, key: "replacement") }
        var changed = speechObject(normalized); changed["retain_seconds"] = .integer(601)
        try await speechFails { _ = try await client.submit(space: "space-demo", input: .object(changed), key: "original") }
        try speechCheck(await wire.posts.count == 1, "same key GET, changed input and pending replacement zero POST")
    }
    for failAt in [1, 2] {
        let store = SpeechMemoryStore(); await store.configure(failAt: failAt)
        let wire = SpeechFixtureWire(vector, store), client = try await speechFixture(store, wire)
        try await speechFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        try speechCheck(await wire.posts.count == failAt - 1, "storage failure POST count")
        if failAt == 2 { _ = try await speechFixture(store, wire).resolve(space: "space-demo", key: "original"); try speechCheck(await wire.posts.count == 1, "failed receipt save only GET") }
    }
    do {
        let store = SpeechMemoryStore(); await store.configure(pause: true)
        let wire = SpeechFixtureWire(vector, store), client = try await speechFixture(store, wire)
        let pending = Task { try await client.submit(space: "space-demo", input: input, key: "original") }
        for _ in 0..<1000 { if await store.release != nil { break }; try await Task.sleep(for: .milliseconds(1)) }
        pending.cancel()
        let saved = String(decoding: await store.load(origin: "https://nas.local#speech-syntheses")!, as: UTF8.self)
        await store.replace(Data(saved.replacingOccurrences(of: "\"voice\":\"local\"", with: "\"voice\":\"other\"").utf8))
        await store.resume(); try await speechFails { _ = try await pending.value }
        try await speechFails { _ = try await client.records(space: "space-demo") }
        try speechCheck(await wire.posts.isEmpty, "cancel recovery rejects storage differing from intended bytes")
    }
    do {
        let store = SpeechMemoryStore(), wire = SpeechFixtureWire(vector, store); await wire.configure(drop: true)
        let client = try await speechFixture(store, wire)
        try await speechFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        let restored = try await speechFixture(store, wire); await wire.configure(missing: true)
        try await speechFails { _ = try await restored.resolve(space: "space-demo", key: "original") }
        try speechCheck(await restored.records(space: "space-demo").first?.status == "unresolved", "404 does not clear original")
        await wire.configure(state: "unknown"); _ = try await restored.resolve(space: "space-demo", key: "original")
        try await speechFails { _ = try await restored.submit(space: "space-demo", input: input, key: "replacement") }
        await wire.configure(state: "succeeded"); try await speechFails { _ = try await restored.resolve(space: "space-demo", key: "original") }
        await wire.configure(state: "unknown", corruption: "deployment"); try await speechFails { _ = try await restored.resolve(space: "space-demo", key: "original") }
        await wire.configure(state: "unknown")
        let discarded = try await restored.discard(space: "space-demo", key: "original", intent: "discard-intent")
        try speechCheck(discarded.status == "discarded" && discarded.mediaId == nil, "explicit discard")
        _ = try await restored.discard(space: "space-demo", key: "original", intent: "discard-intent")
        let postCount = await wire.posts.count, persisted = await wire.savedBeforePosts
        try speechCheck(postCount == 2 && persisted, "discard intent stored, same intent only GET")
    }
    for corruption in ["digest", "time", "extra"] {
        let store = SpeechMemoryStore(), wire = SpeechFixtureWire(vector, store); await wire.configure(corruption: corruption)
        let client = try await speechFixture(store, wire)
        try await speechFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        try speechCheck(await client.records(space: "space-demo").first?.result == nil, "invalid receipt leaves original unresolved")
        await wire.configure(); _ = try await speechFixture(store, wire).resolve(space: "space-demo", key: "original")
        try speechCheck(await wire.posts.count == 1, "invalid receipt never re-POSTs")
    }
    do {
        let store = SpeechMemoryStore(), wire = SpeechFixtureWire(vector, store), client = try await speechFixture(store, wire)
        _ = try await client.submit(space: "space-demo", input: input, key: "original")
        await wire.configure(state: "succeeded"); let success = try await client.resolve(space: "space-demo", key: "original")
        try speechCheck(success.mediaId == "media-original" && !success.pending, "media ID without playback authorization")
        await wire.configure(); try await speechFails { _ = try await client.resolve(space: "space-demo", key: "original") }
        await wire.configure(state: "succeeded", corruption: "identity"); try await speechFails { _ = try await client.resolve(space: "space-demo", key: "original") }
        try speechCheck(await wire.posts.count == 1, "terminal rollback and identity drift rejected")
    }
    do {
        let store = SpeechMemoryStore(), wire = SpeechFixtureWire(vector, store); await wire.configure(reject: true)
        let client = try await speechFixture(store, wire)
        try await speechFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        let record = try await client.records(space: "space-demo").first!
        try speechCheck(record.status == "rejected" && !record.pending && record.rejectedCode == "speech_voice_unavailable", "explicit rejection retained")
        try await speechFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        try speechCheck(await wire.posts.count == 1, "rejected original never re-POSTs")
    }
    do {
        let store = SpeechMemoryStore(); await store.replace(Data("{broken".utf8))
        let wire = SpeechFixtureWire(vector, store), client = try await speechFixture(store, wire)
        try await speechFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        let saves = await store.saves, posts = await wire.posts.count
        try speechCheck(saves == 0 && posts == 0, "bad store not overwritten")
        await store.replace(nil)
        let fresh = try await speechFixture(store, wire); _ = try await fresh.submit(space: "space-demo", input: input, key: "original")
        await store.replace(nil); try await speechFails { _ = try await fresh.submit(space: "space-demo", input: input, key: "removed") }
        try speechCheck(await wire.posts.count == 1, "external store removal blocks new writes")
    }
    do {
        let store = SpeechMemoryStore(); await store.configure(pause: true)
        let wire = SpeechFixtureWire(vector, store), client = try await speechFixture(store, wire)
        let pending = Task { try await client.submit(space: "space-demo", input: input, key: "original") }
        for _ in 0..<1000 { if await store.release != nil { break }; try await Task.sleep(for: .milliseconds(1)) }
        try speechCheck(await store.release != nil, "paused after original save")
        pending.cancel(); await store.resume()
        try await speechFails { _ = try await pending.value }
        try speechCheck(await wire.posts.isEmpty, "cancel after save zero POST")
        let saved = try await client.records(space: "space-demo")
        try speechCheck(saved.count == 1 && saved[0].result == nil && saved[0].pending, "same client reconciles its exact original save")
    }
    return 10
}
