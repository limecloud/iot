import Foundation
import LimeIoTKit

private enum TranscriptionCheckFailure: Error { case failed(String), lost, storage }
private func transcriptionCheck(_ value: Bool, _ name: String) throws { if !value { throw TranscriptionCheckFailure.failed(name) } }
private func transcriptionFails(_ operation: () async throws -> Void) async throws { do { try await operation() } catch { return }; throw TranscriptionCheckFailure.failed("expected rejection") }
private func transcriptionObject(_ value: JSONValue) -> [String: JSONValue] { if case .object(let object) = value { object } else { [:] } }
private func transcriptionVector() throws -> [String: JSONValue] {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    return transcriptionObject(try OtaJSON.parse(String(contentsOf: root.appendingPathComponent("tests/fixtures/transcription/contract.json"), encoding: .utf8), response: true))
}
private actor TranscriptionMemoryStore: SessionStore {
    var data: [String: Data] = [:], saves = 0, failAt = 0
    var pause = false, release: CheckedContinuation<Void, Never>?
    func configure(failAt: Int = 0, pause: Bool = false) { self.failAt = failAt; self.pause = pause }
    func replace(_ value: Data?) { data["https://nas.local#audio-transcriptions"] = value }
    func resume() { release?.resume(); release = nil }
    func load(origin: String) -> Data? { data[origin] }
    func save(origin: String, data: Data?) async throws {
        saves += 1
        if saves == failAt { throw TranscriptionCheckFailure.storage }
        self.data[origin] = data
        if pause { await withCheckedContinuation { release = $0 } }
    }
}
private actor TranscriptionFixtureWire: HTTPTransport {
    let vector: [String: JSONValue]
    let store: TranscriptionMemoryStore
    var requests: [URLRequest] = [], savedBeforePosts = true
    var drop = false, missing = false, reject = false, state = "running", corruption = ""
    init(_ vector: [String: JSONValue], _ store: TranscriptionMemoryStore) { self.vector = vector; self.store = store }
    func configure(drop: Bool = false, missing: Bool = false, reject: Bool = false, state: String = "running", corruption: String = "") { self.drop = drop; self.missing = missing; self.reject = reject; self.state = state; self.corruption = corruption }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        func response(_ text: String, _ status: Int = 200, _ headers: [String: String]? = nil) -> (Data, HTTPURLResponse) { (Data(text.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!) }
        let path = request.url!.path
        if path.hasSuffix("/auth/session") { return response(#"{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}"#, 200, ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"]) }
        if path.hasSuffix("/capabilities") { return response(OtaJSON.canonical(.object(["transcription": vector["capabilities"]!]))) }
        if request.httpMethod == "POST" {
            let saved = try OtaJSON.parse(String(decoding: await store.load(origin: "https://nas.local#audio-transcriptions")!, as: UTF8.self), response: true)
            let records = transcriptionObject(saved)["records"]!
            if case .array(let items) = records, let record = items.first.map(transcriptionObject) {
                savedBeforePosts = savedBeforePosts && record["original"] == vector["original"]
                if path.hasSuffix("/discard") { savedBeforePosts = savedBeforePosts && record["discard_intents"] == .array([.string("discard-intent")]); state = "discarded" }
                else {
                    let input = try TranscriptionRequests.parse(String(decoding: request.httpBody!, as: UTF8.self))
                    savedBeforePosts = savedBeforePosts && request.value(forHTTPHeaderField: "Idempotency-Key") == "original" && input == vector["normalized"]
                }
            } else { savedBeforePosts = false }
            if reject { return response(#"{"error":{"code":"transcription_source_unavailable"}}"#, 422) }
            if drop { throw TranscriptionCheckFailure.lost }
        }
        if missing { return response(#"{"error":{"code":"transcription_not_found"}}"#, 404) }
        var task = transcriptionObject(transcriptionObject(vector["tasks"]!)[state] ?? transcriptionObject(vector["invalid_tasks"]!)[state]!)
        switch corruption {
        case "digest": task["request_digest"] = .string("sha256:" + String(repeating: "0", count: 64))
        case "deployment": var deployment = transcriptionObject(task["deployment"]!); deployment["model"] = .string("changed/model"); task["deployment"] = .object(deployment)
        case "identity": task["transcription_id"] = .string("transcription-other")
        case "time": task["updated_at"] = .string("2026-11-02T23:59:59.123Z")
        case "extra": task["text"] = .string("must reject")
        default: break
        }
        return response(OtaJSON.canonical(.object(task)))
    }
    var posts: [URLRequest] { requests.filter { $0.httpMethod == "POST" && $0.url!.path.contains("/audio-transcriptions") } }
}
private func transcriptionFixture(_ store: TranscriptionMemoryStore, _ wire: TranscriptionFixtureWire) async throws -> TranscriptionClient {
    let gateway = try GatewayClient(endpoint: "https://nas.local", transport: wire)
    try await gateway.login(token: "owner-input"); return TranscriptionClient(gateway: gateway, store: store)
}
func transcriptionContractChecks() async throws -> Int {
    let vector = try transcriptionVector(), input = vector["input"]!, normalized = vector["normalized"]!
    try transcriptionCheck(TranscriptionRequests.parse(OtaJSON.canonical(input)) == normalized, "shared normalized input")
    let fields = transcriptionObject(input)
    for (key, value) in [("expires_at", JSONValue.string("2026-11-03T00:01:25.1234Z")), ("language", .string("fr")), ("media_id", .string("other")), ("media_digest", .string("sha256:bad"))] {
        var bad = fields; bad[key] = value; try await transcriptionFails { _ = try TranscriptionRequests.parse(OtaJSON.canonical(.object(bad))) }
    }
    do {
        let store = TranscriptionMemoryStore(), wire = TranscriptionFixtureWire(vector, store), client = try await transcriptionFixture(store, wire)
        let capabilities = try await client.capabilities(space: "space-demo")
        try transcriptionCheck(capabilities.configured, "bounded capabilities")
        let record = try await client.submit(space: "space-demo", input: input, key: "original")
        try transcriptionCheck(record.original == vector["original"] && record.observation == transcriptionObject(vector["tasks"]!)["running"], "JS UTF8 digest, scalar count and task")
        let saved = String(decoding: await store.load(origin: "https://nas.local#audio-transcriptions")!, as: UTF8.self)
        try transcriptionCheck(!saved.contains("青柠") && !saved.contains("owner-input") && !saved.contains("\"text\""), "no plaintext or session persisted")
        try transcriptionCheck(await wire.savedBeforePosts, "original persisted before POST")
        _ = try await client.submit(space: "space-demo", input: normalized, key: "original")
        try await transcriptionFails { _ = try await client.submit(space: "space-demo", input: input, key: "replacement") }
        var changed = transcriptionObject(normalized); changed["language"] = .string("auto")
        try await transcriptionFails { _ = try await client.submit(space: "space-demo", input: .object(changed), key: "original") }
        try transcriptionCheck(await wire.posts.count == 1, "same key GET, changed input and pending replacement zero POST")
    }
    for failAt in [1, 2] {
        let store = TranscriptionMemoryStore(); await store.configure(failAt: failAt)
        let wire = TranscriptionFixtureWire(vector, store), client = try await transcriptionFixture(store, wire)
        try await transcriptionFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        try transcriptionCheck(await wire.posts.count == failAt - 1, "storage failure POST count")
        if failAt == 2 { _ = try await transcriptionFixture(store, wire).resolve(space: "space-demo", key: "original"); try transcriptionCheck(await wire.posts.count == 1, "failed receipt save only GET") }
    }
    do {
        let store = TranscriptionMemoryStore(); await store.configure(pause: true)
        let wire = TranscriptionFixtureWire(vector, store), client = try await transcriptionFixture(store, wire)
        let pending = Task { try await client.submit(space: "space-demo", input: input, key: "original") }
        for _ in 0..<1000 { if await store.release != nil { break }; try await Task.sleep(for: .milliseconds(1)) }
        pending.cancel()
        let saved = String(decoding: await store.load(origin: "https://nas.local#audio-transcriptions")!, as: UTF8.self)
        await store.replace(Data(saved.replacingOccurrences(of: "\"media_id\":\"media-source\"", with: "\"media_id\":\"media-other\"").utf8))
        await store.resume(); try await transcriptionFails { _ = try await pending.value }
        try await transcriptionFails { _ = try await client.records(space: "space-demo") }
        try transcriptionCheck(await wire.posts.isEmpty, "cancel recovery rejects storage differing from intended bytes")
    }
    do {
        let store = TranscriptionMemoryStore(), wire = TranscriptionFixtureWire(vector, store); await wire.configure(drop: true)
        let client = try await transcriptionFixture(store, wire)
        try await transcriptionFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        let restored = try await transcriptionFixture(store, wire); await wire.configure(missing: true)
        try await transcriptionFails { _ = try await restored.resolve(space: "space-demo", key: "original") }
        try transcriptionCheck(await restored.records(space: "space-demo").first?.status == "unresolved", "404 does not clear original")
        await wire.configure(state: "unknown"); _ = try await restored.resolve(space: "space-demo", key: "original")
        try await transcriptionFails { _ = try await restored.submit(space: "space-demo", input: input, key: "replacement") }
        await wire.configure(state: "succeeded"); try await transcriptionFails { _ = try await restored.resolve(space: "space-demo", key: "original") }
        await wire.configure(state: "unknown", corruption: "deployment"); try await transcriptionFails { _ = try await restored.resolve(space: "space-demo", key: "original") }
        await wire.configure(state: "unknown")
        let discarded = try await restored.discard(space: "space-demo", key: "original", intent: "discard-intent")
        try transcriptionCheck(discarded.status == "discarded" && discarded.text == nil, "explicit discard")
        _ = try await restored.discard(space: "space-demo", key: "original", intent: "discard-intent")
        let postCount = await wire.posts.count, persisted = await wire.savedBeforePosts
        try transcriptionCheck(postCount == 2 && persisted, "discard intent stored, same intent only GET")
    }
    for corruption in ["digest", "time", "extra"] {
        let store = TranscriptionMemoryStore(), wire = TranscriptionFixtureWire(vector, store); await wire.configure(corruption: corruption)
        let client = try await transcriptionFixture(store, wire)
        try await transcriptionFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        try transcriptionCheck(await client.records(space: "space-demo").first?.observation == nil, "invalid receipt leaves original unresolved")
        await wire.configure(); _ = try await transcriptionFixture(store, wire).resolve(space: "space-demo", key: "original")
        try transcriptionCheck(await wire.posts.count == 1, "invalid receipt never re-POSTs")
    }
    do {
        let store = TranscriptionMemoryStore(), wire = TranscriptionFixtureWire(vector, store), client = try await transcriptionFixture(store, wire)
        _ = try await client.submit(space: "space-demo", input: input, key: "original")
        await wire.configure(state: "succeeded"); let success = try await client.resolve(space: "space-demo", key: "original")
        try transcriptionCheck(success.text == "青柠🍋\n你好" && !success.pending, "verified UTF8 text returned only in memory")
        await wire.configure(); try await transcriptionFails { _ = try await client.resolve(space: "space-demo", key: "original") }
        await wire.configure(state: "succeeded", corruption: "identity"); try await transcriptionFails { _ = try await client.resolve(space: "space-demo", key: "original") }
        try transcriptionCheck(await wire.posts.count == 1, "terminal rollback and identity drift rejected")
    }
    do {
        let store = TranscriptionMemoryStore(), wire = TranscriptionFixtureWire(vector, store); await wire.configure(reject: true)
        let client = try await transcriptionFixture(store, wire)
        try await transcriptionFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        let record = try await client.records(space: "space-demo").first!
        try transcriptionCheck(record.status == "rejected" && !record.pending && record.rejectedCode == "transcription_source_unavailable", "explicit rejection retained")
        try await transcriptionFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        try transcriptionCheck(await wire.posts.count == 1, "rejected original never re-POSTs")
    }
    do {
        let store = TranscriptionMemoryStore(); await store.replace(Data("{broken".utf8))
        let wire = TranscriptionFixtureWire(vector, store), client = try await transcriptionFixture(store, wire)
        try await transcriptionFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        let saves = await store.saves, posts = await wire.posts.count
        try transcriptionCheck(saves == 0 && posts == 0, "bad store not overwritten")
        await store.replace(nil)
        let fresh = try await transcriptionFixture(store, wire); _ = try await fresh.submit(space: "space-demo", input: input, key: "original")
        await store.replace(nil); try await transcriptionFails { _ = try await fresh.submit(space: "space-demo", input: input, key: "removed") }
        try transcriptionCheck(await wire.posts.count == 1, "external store removal blocks new writes")
    }
    do {
        let store = TranscriptionMemoryStore(); await store.configure(pause: true)
        let wire = TranscriptionFixtureWire(vector, store), client = try await transcriptionFixture(store, wire)
        let pending = Task { try await client.submit(space: "space-demo", input: input, key: "original") }
        for _ in 0..<1000 { if await store.release != nil { break }; try await Task.sleep(for: .milliseconds(1)) }
        try transcriptionCheck(await store.release != nil, "paused after original save")
        pending.cancel(); await store.resume()
        try await transcriptionFails { _ = try await pending.value }
        try transcriptionCheck(await wire.posts.isEmpty, "cancel after save zero POST")
        let saved = try await client.records(space: "space-demo")
        try transcriptionCheck(saved.count == 1 && saved[0].observation == nil && saved[0].pending, "same client reconciles its exact original save")
    }
    do {
        let store = TranscriptionMemoryStore(), wire = TranscriptionFixtureWire(vector, store), client = try await transcriptionFixture(store, wire)
        await wire.configure(state: "succeeded"); let success = try await client.submit(space: "space-demo", input: input, key: "original")
        try transcriptionCheck(success.text == "青柠🍋\n你好", "unicode body")
        let saved = String(decoding: await store.load(origin: "https://nas.local#audio-transcriptions")!, as: UTF8.self)
        try transcriptionCheck(!saved.contains("青柠") && !saved.contains("\"text\"") && saved.contains("content_digest"), "only output metadata persisted")
        let restored = try await transcriptionFixture(store, wire)
        try transcriptionCheck(await restored.records(space: "space-demo").first?.text == nil, "process restore never restores plaintext")
        await wire.configure(state: "cleared"); let cleared = try await restored.resolve(space: "space-demo", key: "original")
        try transcriptionCheck(cleared.text == nil && cleared.status == "succeeded", "server clearing does not fake failure")
        await wire.configure(state: "succeeded"); try await transcriptionFails { _ = try await restored.resolve(space: "space-demo", key: "original") }
        try transcriptionCheck(await wire.posts.count == 1, "cleared output cannot resurrect")
    }
    do {
        let store = TranscriptionMemoryStore(), wire = TranscriptionFixtureWire(vector, store), client = try await transcriptionFixture(store, wire)
        await wire.configure(state: "empty")
        try transcriptionCheck(await client.submit(space: "space-demo", input: input, key: "original").text == "", "empty recognition is valid")
    }
    do {
        let store = TranscriptionMemoryStore(), wire = TranscriptionFixtureWire(vector, store), client = try await transcriptionFixture(store, wire)
        await wire.configure(state: "timezone"); let result = try await client.submit(space: "space-demo", input: input, key: "original")
        try transcriptionCheck(result.text == "青柠🍋\n你好", "network input normalizes equivalent timezones")
        _ = try await client.records(space: "space-demo")
    }
    for name in transcriptionObject(vector["invalid_tasks"]!).keys.sorted() {
        let store = TranscriptionMemoryStore(), wire = TranscriptionFixtureWire(vector, store), client = try await transcriptionFixture(store, wire)
        await wire.configure(state: name); try await transcriptionFails { _ = try await client.submit(space: "space-demo", input: input, key: "original") }
        try transcriptionCheck(await client.records(space: "space-demo").first?.observation == nil, "malformed output leaves unresolved original: " + name)
    }
    return 13
}
