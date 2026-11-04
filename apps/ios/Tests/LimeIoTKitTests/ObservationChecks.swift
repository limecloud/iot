import Foundation
import LimeIoTKit

enum ObservationCheckFailure: Error { case check(String), lost, storage }
func observationCheck(_ value: Bool, _ name: String) throws { if !value { throw ObservationCheckFailure.check(name) } }
func observationObject(_ value: JSONValue?) -> [String: JSONValue] { if case .object(let fields) = value { fields } else { [:] } }
func observationFixture() throws -> [String: JSONValue] {
    let path = ProcessInfo.processInfo.environment["LIMEIOT_OBSERVATION_FIXTURE"] ?? "tests/fixtures/zigbee/observation-native.json"
    return observationObject(try ObservationJSON.parse(String(contentsOfFile: path, encoding: .utf8), response: true))
}
func observationMustFail(_ action: () async throws -> Void) async throws {
    do { try await action() } catch { return }; throw ObservationCheckFailure.check("expected rejection")
}
actor ObservationMemory: SessionStore {
    var values: [String: Data] = [:]
    var fail = false, mismatch = false, holding = false, waiting = false
    var release: CheckedContinuation<Void, Never>?
    func configure(fail: Bool = false, mismatch: Bool = false, holding: Bool = false) { self.fail = fail; self.mismatch = mismatch; self.holding = holding }
    func erase() { values = [:] }
    func load(origin: String) -> Data? { values[origin] }
    func resume() { release?.resume(); release = nil; holding = false }
    func save(origin: String, data: Data?) async throws {
        if fail { throw ObservationCheckFailure.storage }
        if !mismatch { values[origin] = data }
        if holding { waiting = true; await withCheckedContinuation { release = $0 }; waiting = false }
    }
}
actor ObservationWire: HTTPTransport {
    let vector: [String: JSONValue]
    var requests: [URLRequest] = [], results: [String: JSONValue] = [:]
    var drop = false, missing = false, corrupt = false, changed = false, queryMismatch = false, queryHold = false, queryWaiting = false
    var release: CheckedContinuation<Void, Never>?
    var current: JSONValue
    var discoveryMismatch = false
    init() throws { vector = try observationFixture(); current = vector["empty"]! }
    func configure(drop: Bool = false, missing: Bool = false, corrupt: Bool = false, changed: Bool = false, queryMismatch: Bool = false, queryHold: Bool = false) { self.drop = drop; self.missing = missing; self.corrupt = corrupt; self.changed = changed; self.queryMismatch = queryMismatch; self.queryHold = queryHold }
    func resumeQuery() { release?.resume(); release = nil; queryHold = false }
    func mismatchDiscovery(_ value: Bool) { discoveryMismatch = value }
    func setCurrent(_ value: JSONValue) { current = value }
    var posts: Int { requests.filter { $0.url!.path.hasSuffix("/observation-operations") && $0.httpMethod == "POST" }.count }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request); let path = request.url!.path
        func response(_ value: JSONValue, _ status: Int = 200, _ headers: [String: String]? = nil) -> (Data, HTTPURLResponse) { (Data(ObservationJSON.canonical(value).utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!) }
        if path.hasSuffix("/auth/session") { return response(.object(["authenticated": .bool(true), "csrf_token": .string("csrf"), "expires_at": .string("2030-01-01T00:00:00Z")]), 200, ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"]) }
        if path.hasSuffix("/observation-discoveries") || path.hasSuffix("/observation-endpoints") {
            if queryHold { queryWaiting = true; await withCheckedContinuation { release = $0 }; queryWaiting = false }
            var result = observationObject(vector[path.hasSuffix("/observation-discoveries") ? "discovery" : "endpoints"])
            if discoveryMismatch { result["coordinator_ieee"] = .string("8877665544332211") }
            return response(.object(result))
        }
        if path.hasSuffix("/observation-candidates") {
            if request.httpMethod == "POST" {
                if queryHold { queryWaiting = true; await withCheckedContinuation { release = $0 }; queryWaiting = false }
                var candidate = observationObject(vector["candidate"])
                if queryMismatch { var target = observationObject(candidate["target"]); target["endpoint"] = .integer(2); candidate["target"] = .object(target) }
                return response(.object(candidate))
            }
            return response(vector["page"]!)
        }
        if path.hasSuffix("/observation-binding") {
            let device = request.url!.deletingLastPathComponent().lastPathComponent
            if device == "sensor" { return response(current) }
            return response(.object(["device_id": .string(device), "revision": .string(ObservationJSON.digest(.array([.string("observation-binding-v1"), .string(device), .null]))), "binding": .null]))
        }
        let key = request.value(forHTTPHeaderField: "Idempotency-Key") ?? request.url!.lastPathComponent
        if path.hasSuffix("/observation-operations") && request.httpMethod == "POST" {
            let change = try ObservationJSON.parse(String(decoding: request.httpBody!, as: UTF8.self)), c = observationObject(change), device = c["device_id"]!
            let original = JSONValue.object(["space_id": .string("space-demo"), "idempotency_key": .string(key), "change": change]), created = "2030-01-01T00:00:01Z", op = "observationop-" + key
            var b = observationObject(observationObject(vector["current"])["binding"]), p = observationObject(b["policy"])
            p["device_id"] = device; b["policy"] = .object(p); b["active"] = .bool(c["type"] == .string("sources.bind")); b["generation"] = .string(op); b["changed_at"] = .string(created)
            let view = JSONValue.object(["device_id": device, "revision": .string(ObservationJSON.digest(.array([.string("observation-binding-v1"), device, .object(b)]))), "binding": .object(b)])
            current = view
            results[key] = .object(["operation_id": .string(op), "sequence": .integer(1), "request": original, "request_digest": .string(ObservationJSON.digest(original)), "status": .string("applied"), "reason": .null, "result": view, "created_at": .string(created)])
            if drop { throw ObservationCheckFailure.lost }
        }
        guard !missing, var result = results[key] else { return response(.object(["error": .object(["code": .string("not_found")])]), 404) }
        var o = observationObject(result)
        if corrupt { o["request_digest"] = .string("sha256:" + String(repeating: "0", count: 64)) }
        if changed { o["status"] = .string("conflict"); o["reason"] = .string("revision_conflict"); o["result"] = .null }
        result = .object(o); return response(result)
    }
}
func observationClient(_ store: ObservationMemory, _ wire: ObservationWire) async throws -> ObservationClient {
    let gateway = try GatewayClient(endpoint: "https://nas.local", transport: wire); try await gateway.login(token: "owner-input")
    return ObservationClient(gateway: gateway, store: store)
}
func observationContractChecks() async throws -> Int {
    let v = try observationFixture(), change = v["bind"]!
    _ = try ObservationJSON.candidate(v["candidate"]!); _ = try ObservationJSON.candidates(v["page"]!)
    for name in ["empty", "current", "revoked"] { _ = try ObservationJSON.binding(v[name]!, device: "sensor") }
    for name in ["operation", "revokeOperation", "rejected", "conflict"] { try ObservationJSON.operation(v[name]!) }
    for text in [#"{"a":1,"\u0061":2}"#, #"{"n":0.5}"#, #"{"n":9007199254740992}"#, #"{"s":"\ud800"}"#] { try await observationMustFail { _ = try ObservationJSON.parse(text) } }
    for key in ["device_id", "expected_binding_revision"] { var c = observationObject(change); c[key] = .string((key == "device_id" ? "sensor" : String(repeating: "a", count: 71)) + "\n"); let invalid = JSONValue.object(c); try await observationMustFail { try ObservationJSON.change(invalid) } }
    var candidate = observationObject(v["candidate"]); candidate["expires_at"] = .string("2030-01-01T00:01:01Z"); let expired = JSONValue.object(candidate)
    try await observationMustFail { _ = try ObservationJSON.candidate(expired) }
    var op = observationObject(v["operation"]); op["sequence"] = .integer(257); let oversized = JSONValue.object(op)
    try await observationMustFail { try ObservationJSON.operation(oversized) }
    for mismatch in [false, true] {
        let store = ObservationMemory(), wire = try ObservationWire(), client = try await observationClient(store, wire)
        await store.configure(fail: !mismatch, mismatch: mismatch)
        try await observationMustFail { _ = try await client.submit(space: "space-demo", change: change, key: "original") }
        try observationCheck(await wire.posts == 0, "save and readback failure must not POST")
    }
    do {
        let store = ObservationMemory(), wire = try ObservationWire(), client = try await observationClient(store, wire)
        await wire.configure(drop: true)
        try await observationMustFail { _ = try await client.submit(space: "space-demo", change: change, key: "original") }
        var alternate = observationObject(change); alternate["device_id"] = .string("renamed"); let renamed = JSONValue.object(alternate)
        for (key, c) in [("replacement", change), ("renamed", renamed)] { try await observationMustFail { _ = try await client.submit(space: "space-demo", change: c, key: key) } }
        let restored = try await observationClient(store, wire)
        await wire.configure(missing: true); try await observationMustFail { _ = try await restored.submit(space: "space-demo", change: change, key: "original") }
        await wire.configure(corrupt: true); try await observationMustFail { _ = try await restored.resolve(space: "space-demo", key: "original") }
        try observationCheck(try await restored.records(space: "space-demo").first?.pending == true, "invalid and missing receipt remain pending")
        await wire.configure(); let recovered = try await restored.submit(space: "space-demo", change: change, key: "original")
        let postCount = await wire.posts
        try observationCheck(recovered.status == "applied" && postCount == 1, "restoration only GET")
        await wire.configure(changed: true); try await observationMustFail { _ = try await restored.resolve(space: "space-demo", key: "original") }
        try observationCheck(try await restored.records(space: "space-demo").first?.status == "applied", "decided receipt immutable")
        let posts = await wire.requests.filter { $0.httpMethod == "POST" && $0.url!.path.hasSuffix("/observation-operations") }
        try observationCheck(posts.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == nil && $0.value(forHTTPHeaderField: "X-CSRF-Token") == "csrf" }, "shared session without owner bearer")
    }
    do {
        let store = ObservationMemory(), wire = try ObservationWire(), client = try await observationClient(store, wire)
        _ = try await client.records(space: "space-demo"); await store.configure(holding: true)
        let pending = Task { try await client.submit(space: "space-demo", change: change, key: "original") }
        for _ in 0..<100 { if await store.waiting { break }; try await Task.sleep(for: .milliseconds(5)) }
        try observationCheck(await store.waiting, "save waiting reached"); pending.cancel(); await store.resume()
        try await observationMustFail { _ = try await pending.value }; try observationCheck(await wire.posts == 0, "cancel before save completes prevents POST")
        let restored = try await observationClient(store, wire); try observationCheck(try await restored.records(space: "space-demo").first?.pending == true, "cancel retains original")
        await store.erase(); try await observationMustFail { _ = try await restored.submit(space: "space-demo", change: change, key: "new-key") }
        try observationCheck(await wire.posts == 0, "known records cannot be silently erased")
    }
    do {
        let store = ObservationMemory(), wire = try ObservationWire(), client = try await observationClient(store, wire)
        _ = try await client.query(space: "space-demo", coordinator: "home-znp", ieee: "1122334455667788", endpoint: 1)
        let requests = await wire.requests
        try observationCheck(requests.last?.timeoutInterval == 35 && requests.first?.timeoutInterval == 12, "query-only timeout")
        await wire.configure(queryMismatch: true); try await observationMustFail { _ = try await client.query(space: "space-demo", coordinator: "home-znp", ieee: "1122334455667788", endpoint: 1) }
        try observationCheck(await wire.posts == 0, "queries never bind")
    }
    do {
        let coordinator = try ObservationJSON.candidates(v["page"]!).coordinators[0]
        let found = try ObservationDiscoveryJSON.discovery(v["discovery"]!, coordinator: coordinator)
        let endpoints = try ObservationDiscoveryJSON.endpoints(v["endpoints"]!, coordinator: coordinator, ieee: "1122334455667788")
        try observationCheck(found.items.count == 1 && endpoints.items[0].supportsEnvironment && !endpoints.items[1].supportsEnvironment, "endpoint capability derived from clusters")
        for (name, isEndpoint) in [("invalidDiscovery", false), ("invalidEndpoints", true)] {
            guard case .array(let values) = v[name] else { throw ObservationCheckFailure.check("missing shared invalid vectors") }
            for item in values {
                let doc = observationObject(item)["document"]!
                try await observationMustFail {
                    if isEndpoint { _ = try ObservationDiscoveryJSON.endpoints(doc, coordinator: coordinator, ieee: "1122334455667788") }
                    else { _ = try ObservationDiscoveryJSON.discovery(doc, coordinator: coordinator) }
                }
            }
        }
        for invalid in ["1122334455667788\n", "ffffffffffffffff"] { try await observationMustFail { _ = try ObservationDiscoveryJSON.query(coordinator: "home-znp", ieee: invalid) } }
    }
    do {
        let memory = ObservationMemory(), wire = try ObservationWire(), client = try await observationClient(memory, wire)
        _ = try await client.discover(space: "space-demo", coordinator: "home-znp")
        _ = try await client.endpoints(space: "space-demo", coordinator: "home-znp", ieee: "1122334455667788")
        let requests = await wire.requests.filter { $0.url!.path.hasSuffix("/observation-discoveries") || $0.url!.path.hasSuffix("/observation-endpoints") }
        try observationCheck(requests.count == 2 && requests.allSatisfy { $0.timeoutInterval == 35 && $0.httpMethod == "POST" && $0.value(forHTTPHeaderField: "X-CSRF-Token") == "csrf" && $0.value(forHTTPHeaderField: "Authorization") == nil }, "probes use shared session and query timeout")
        let saved = await memory.values, records = try await client.records(space: "space-demo")
        try observationCheck(saved.isEmpty && records.isEmpty, "discovery never saves original operations")
        await wire.mismatchDiscovery(true)
        try await observationMustFail { _ = try await client.discover(space: "space-demo", coordinator: "home-znp") }
        try await observationMustFail { _ = try await client.endpoints(space: "space-demo", coordinator: "home-znp", ieee: "1122334455667788") }
        try observationCheck(await wire.posts == 0, "discovery and endpoints never bind")
    }
    return 9
}
