import Foundation
import LimeIoTKit

private enum MediaCheckFailure: Error { case failed(String), lost, storage }
private func mediaCheck(_ value: Bool, _ name: String) throws { if !value { throw MediaCheckFailure.failed(name) } }
private func mediaFails(_ operation: () async throws -> Void) async throws { do { try await operation() } catch { return }; throw MediaCheckFailure.failed("expected rejection") }
private func mediaObject(_ value: JSONValue) -> [String: JSONValue] { if case .object(let v) = value { v } else { [:] } }
private func mediaVector() throws -> [String: JSONValue] {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    return mediaObject(try OtaJSON.parse(String(contentsOf: root.appendingPathComponent("tests/fixtures/media/upload.json"), encoding: .utf8), response: true))
}
private actor MediaMemoryStore: SessionStore {
    var data: [String: Data] = [:]; var saves = 0; var failAt = 0
    func configure(failAt: Int) { self.failAt = failAt }
    func replace(_ value: Data?) { data["https://nas.local#media-operations"] = value }
    func load(origin: String) -> Data? { data[origin] }
    func save(origin: String, data: Data?) throws { saves += 1; if saves == failAt { throw MediaCheckFailure.storage }; self.data[origin] = data }
}
private actor MediaFixtureWire: HTTPTransport {
    let vector: [String: JSONValue]
    var requests: [URLRequest] = [], results: [String: JSONValue] = [:]
    var drop = false, missing = false, issued = true, delayPost = false, corruption = "", page: String?
    init(vector: [String: JSONValue]) { self.vector = vector }
    func configure(drop: Bool = false, missing: Bool = false, issued: Bool = true, delayPost: Bool = false, corruption: String = "", page: String? = nil) { self.drop = drop; self.missing = missing; self.issued = issued; self.delayPost = delayPost; self.corruption = corruption; self.page = page }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        func response(_ text: String, _ status: Int = 200, _ headers: [String: String]? = nil) -> (Data, HTTPURLResponse) { (Data(text.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!) }
        if request.url!.path.hasSuffix("/auth/session") { return response(#"{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}"#, 200, ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"]) }
        if request.url!.path.hasSuffix("/media") { return response(page ?? #"{"space_id":"space-demo","configured":false,"items":[],"grants":[],"next_cursor":null}"#) }
        let key = request.value(forHTTPHeaderField: "Idempotency-Key") ?? request.url!.lastPathComponent
        if request.httpMethod == "POST" {
            if delayPost { try await Task.sleep(for: .milliseconds(100)) }
            let change = try MediaChanges.parse(String(decoding: request.httpBody!, as: UTF8.self)), c = mediaObject(change)
            let original = JSONValue.object(["space_id": .string("space-demo"), "idempotency_key": .string(key), "change": change])
            var value = mediaObject(vector["operation"]!)
            value["operation_id"] = .string("mediaop-" + key); value["idempotency_key"] = .string(key); value["kind"] = c["type"]; value["request_digest"] = .string(OtaJSON.digest(original))
            switch c["type"] {
            case .string("media.grant"): value["result"] = .object(["type": .string("granted"), "grant_id": .string("grant-" + key), "media_id": c["media_id"]!, "device_id": c["device_id"]!, "binding_revision": c["expected_binding_revision"]!, "created_at": value["created_at"]!, "expires_at": .string("2026-11-03T00:05:00Z"), "issued_in_process": .bool(true)])
            case .string("media.delete"): value["result"] = .object(["type": .string("deleted"), "media_id": c["media_id"]!])
            case .string("media.revoke"): value["result"] = .object(["type": .string("revoked"), "grant_id": c["grant_id"]!])
            default: break
            }
            results[key] = .object(value)
            if drop { throw MediaCheckFailure.lost }
        }
        guard !missing, var value = results[key].map(mediaObject) else { return response(#"{"error":{"code":"media_operation_not_found"}}"#, 404) }
        if value["kind"] == .string("media.grant") { var r = mediaObject(value["result"]!); r["issued_in_process"] = .bool(issued); value["result"] = .object(r) }
        switch corruption {
        case "space": value["space_id"] = .string("other")
        case "digest": value["request_digest"] = .string("sha256:" + String(repeating: "0", count: 64))
        case "url": var r = mediaObject(value["result"]!); r["download_url"] = .string("http://invalid.local/token"); value["result"] = .object(r)
        case "media": var r = mediaObject(value["result"]!), m = mediaObject(r["media"]!); m["content_digest"] = .string("sha256:" + String(repeating: "0", count: 64)); r["media"] = .object(m); value["result"] = .object(r)
        default: break
        }
        let text = OtaJSON.canonical(.object(value))
        return response(corruption == "duplicate" ? String(text.dropLast()) + #","space_id":"space-demo"}"# : text)
    }
    var posts: [URLRequest] { requests.filter { $0.httpMethod == "POST" && $0.url!.path.hasSuffix("/media-operations") } }
}
private func mediaFixture(_ store: MediaMemoryStore, _ wire: MediaFixtureWire) async throws -> MediaClient {
    let gateway = try GatewayClient(endpoint: "https://nas.local", transport: wire)
    try await gateway.login(token: "owner-input"); return MediaClient(gateway: gateway, store: store)
}
func mediaContractChecks() async throws -> Int {
    let vector = try mediaVector(), upload = vector["change"]!, input = OtaJSON.canonical(upload)
    for text in [String(input.dropLast()) + #","retain_seconds":600}"#, input.replacingOccurrences(of: "600", with: "59"), #"{"type":"media.upload","content_base64":"AAAA","retain_seconds":600}"#, #"{"type":"media.delete","media_id":"m","url":"http://example.org"}"#] {
        try await mediaFails { _ = try MediaChanges.parse(text) }
    }
    try await mediaFails { _ = try MediaChanges.upload(bytes: Data(repeating: 0, count: MediaChanges.maxAudioBytes + 1), retainSeconds: 600) }
    let store = MediaMemoryStore(), wire = MediaFixtureWire(vector: vector); await store.configure(failAt: 1)
    let failedStore = try await mediaFixture(store, wire)
    try await mediaFails { _ = try await failedStore.submit(space: "space-demo", change: upload, key: "original") }
    try mediaCheck(await wire.posts.isEmpty, "storage failure zero POST")
    do {
        let store = MediaMemoryStore(), wire = MediaFixtureWire(vector: vector); await wire.configure(drop: true)
        let client = try await mediaFixture(store, wire)
        try await mediaFails { _ = try await client.submit(space: "space-demo", change: upload, key: "original") }
        try await mediaFails { _ = try await client.submit(space: "space-demo", change: upload, key: "replacement") }
        let saved = String(decoding: await store.load(origin: "https://nas.local#media-operations")!, as: UTF8.self)
        try mediaCheck(!saved.contains("content_base64") && !saved.contains("download_url") && !saved.contains("owner-input"), "digest-only original")
        let restored = try await mediaFixture(store, wire); await wire.configure(missing: true)
        try await mediaFails { _ = try await restored.resolve(space: "space-demo", key: "original") }
        try mediaCheck(await restored.records(space: "space-demo").first?.result == nil, "404 remains unknown")
        await wire.configure()
        let recovered = try await restored.resolve(space: "space-demo", key: "original")
        try mediaCheck(recovered.original == vector["original"] && recovered.result == vector["operation"], "shared JS request and response vector")
        _ = try await restored.submit(space: "space-demo", change: upload, key: "original")
        let posts = await wire.posts
        try mediaCheck(posts.count == 1 && posts[0].value(forHTTPHeaderField: "X-CSRF-Token") == "csrf" && posts[0].value(forHTTPHeaderField: "Authorization") == nil, "one authenticated POST")
        try await mediaFails { _ = try await restored.submit(space: "space-demo", change: MediaChanges.parse(input.replacingOccurrences(of: "600", with: "601")), key: "original") }
        await store.replace(nil)
        try await mediaFails { _ = try await restored.submit(space: "space-demo", change: upload, key: "removed") }
        try mediaCheck(await wire.posts.count == 1, "removed record zero new POST")
    }
    for corruption in ["space", "digest", "url", "media", "duplicate"] {
        let store = MediaMemoryStore(), wire = MediaFixtureWire(vector: vector); await wire.configure(corruption: corruption)
        let client = try await mediaFixture(store, wire)
        try await mediaFails { _ = try await client.submit(space: "space-demo", change: upload, key: "original") }
        try mediaCheck(await client.records(space: "space-demo").first?.result == nil, "unverified result remains unknown")
        await wire.configure()
        _ = try await mediaFixture(store, wire).resolve(space: "space-demo", key: "original")
        try mediaCheck(await wire.posts.count == 1, "malformed receipt never re-POSTs")
    }
    do {
        let store = MediaMemoryStore(), wire = MediaFixtureWire(vector: vector); await store.configure(failAt: 2)
        let client = try await mediaFixture(store, wire)
        try await mediaFails { _ = try await client.submit(space: "space-demo", change: upload, key: "original") }
        _ = try await mediaFixture(store, wire).resolve(space: "space-demo", key: "original")
        try mediaCheck(await wire.posts.count == 1, "result-save failure only queries")
    }
    do {
        let store = MediaMemoryStore(), wire = MediaFixtureWire(vector: vector), client = try await mediaFixture(store, wire)
        let grant = try MediaChanges.grant(mediaId: "media-original", deviceId: "speaker", bindingRevision: "sha256:" + String(repeating: "1", count: 64), validForSeconds: 300)
        _ = try await client.submit(space: "space-demo", change: grant, key: "grant")
        await wire.configure(issued: false)
        let old = try await client.resolve(space: "space-demo", key: "grant")
        try mediaCheck(mediaObject(old.result.map(mediaObject)?["result"] ?? .null)["issued_in_process"] == .bool(false), "historical receipt does not reauthorize")
        _ = try await client.submit(space: "space-demo", change: MediaChanges.revoke(grantId: "grant-grant"), key: "revoke")
        _ = try await client.submit(space: "space-demo", change: MediaChanges.delete(mediaId: "media-original"), key: "delete")
        try mediaCheck(await wire.posts.count == 3, "explicit grant revoke delete only")
    }
    do {
        let store = MediaMemoryStore(), wire = MediaFixtureWire(vector: vector), client = try await mediaFixture(store, wire)
        try mediaCheck(await client.list(space: "space-demo").configured == false, "unconfigured page")
        await wire.configure(page: vector["page"]!.jsonText)
        let valid = try await client.list(space: "space-demo"); try mediaCheck(valid.items.count == 1 && valid.grants.count == 1, "bounded metadata and pull page")
        if case .array(let pages) = vector["invalid_pages"] {
            for value in pages { await wire.configure(page: value.jsonText); try await mediaFails { _ = try await client.list(space: "space-demo") } }
        } else { throw MediaCheckFailure.failed("missing page vectors") }
        for page in [#"{"space_id":"other","configured":false,"items":[],"grants":[],"next_cursor":null}"#, #"{"space_id":"space-demo","configured":false,"items":[],"grants":[],"next_cursor":null,"token":"unexpected"}"#] {
            await wire.configure(page: page); try await mediaFails { _ = try await client.list(space: "space-demo") }
        }
        await store.replace(Data("{broken".utf8))
        try await mediaFails { _ = try await client.submit(space: "space-demo", change: upload, key: "corrupt") }
        try mediaCheck(await wire.posts.isEmpty, "corrupt storage preserved")
    }
    do {
        let store = MediaMemoryStore(), wire = MediaFixtureWire(vector: vector); await wire.configure(delayPost: true)
        let first = try await mediaFixture(store, wire), second = try await mediaFixture(store, wire)
        let pending = Task { try await first.submit(space: "space-demo", change: upload, key: "original") }
        for _ in 0..<500 { if await !wire.posts.isEmpty { break }; try await Task.sleep(for: .milliseconds(1)) }
        try mediaCheck(await wire.posts.count == 1, "concurrent POST entered")
        try await mediaFails { _ = try await second.submit(space: "space-demo", change: upload, key: "original") }
        _ = try await pending.value
        _ = try await second.submit(space: "space-demo", change: upload, key: "original")
        try mediaCheck(await wire.posts.count == 1, "cross-instance gate preserves one original")
    }
    return 8
}

// 文件存储仅用于宿主恢复夹具；App仍使用系统安全存储。
private actor MediaFileStore: SessionStore {
    let path: URL
    init(path: String) { self.path = URL(fileURLWithPath: path) }
    func load(origin: String) throws -> Data? { FileManager.default.fileExists(atPath: path.path) ? try Data(contentsOf: path) : nil }
    func save(origin: String, data: Data?) throws {
        guard let data else { throw MediaCheckFailure.storage }
        if !FileManager.default.fileExists(atPath: path.path) { guard FileManager.default.createFile(atPath: path.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw MediaCheckFailure.storage } }
        let file = try FileHandle(forWritingTo: path); defer { try? file.close() }
        try file.truncate(atOffset: 0); try file.write(contentsOf: data); try file.synchronize()
    }
}
private actor MediaLiveWire: HTTPTransport {
    private let upstream = URLSessionTransport()
    var posts = 0
    let dropUpload: Bool
    init(dropUpload: Bool) { self.dropUpload = dropUpload }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result = try await upstream.send(request)
        if request.httpMethod == "POST", request.url!.path.hasSuffix("/media-operations") {
            posts += 1
            if dropUpload && request.value(forHTTPHeaderField: "Idempotency-Key") == "native-upload" { throw MediaCheckFailure.lost }
        }
        return result
    }
}
func actualMediaChecks() async throws {
    let env = ProcessInfo.processInfo.environment, space = "space-demo", phase = env["LIMEIOT_MEDIA_PHASE"]!
    let wire = MediaLiveWire(dropUpload: phase == "create"), store = MediaFileStore(path: env["LIMEIOT_MEDIA_STORE"]!)
    let gateway = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, transport: wire, allowLoopbackHTTP: true)
    try await gateway.login(token: env["LIMEIOT_TOKEN"]!)
    var client = MediaClient(gateway: gateway, store: store)
    let bytes = try Data(contentsOf: URL(fileURLWithPath: env["LIMEIOT_MEDIA_BYTES"]!)), upload = try MediaChanges.upload(bytes: bytes, retainSeconds: 600)
    if phase == "create" {
        try await mediaFails { _ = try await client.submit(space: space, change: upload, key: "native-upload") }
        client = MediaClient(gateway: gateway, store: store)
        let recovered = try await client.submit(space: space, change: upload, key: "native-upload")
        try mediaCheck(recovered.result != nil, "lost upload recovered")
    } else {
        let originals = try await client.records(space: space); try mediaCheck(originals.count == 2, "process originals restored")
        _ = try await client.submit(space: space, change: upload, key: "native-upload")
        let old = try await client.resolve(space: space, key: "native-grant")
        try mediaCheck(mediaObject(mediaObject(old.result!)["result"]!)["issued_in_process"] == .bool(false), "old epoch receipt")
        try mediaCheck(await client.list(space: space).grants.allSatisfy { !$0.active }, "restart old authorization inactive")
    }
    let page = try await client.list(space: space), media = page.items.first!
    let grant = try MediaChanges.grant(mediaId: media.id, deviceId: "device-lamp", bindingRevision: env["LIMEIOT_MEDIA_BINDING"]!, validForSeconds: 300)
    let granted = try await client.submit(space: space, change: grant, key: phase == "create" ? "native-grant" : "native-new-grant")
    if phase == "create" {
        let snapshot = try await gateway.snapshot(); try mediaCheck(snapshot.commands.items.isEmpty, "upload and grant do not play")
        let speaker = snapshot.devices.first { $0.id == "device-lamp" }!
        var command = try await gateway.create(space: space, intent: CommandIntent(device: speaker, path: "playback.play", value: .object(["media_id": .string(media.id)]), type: "action.invoke"))
        for _ in 0..<50 { if command.status == "confirmed" { break }; try await Task.sleep(for: .milliseconds(100)); command = try await gateway.command(space: space, id: command.commandId) }
        try mediaCheck(command.status == "confirmed", "explicit native playback")
    } else {
        let grantId = mediaObject(mediaObject(granted.result!)["result"]!)["grant_id"]!.text
        _ = try await client.submit(space: space, change: MediaChanges.revoke(grantId: grantId), key: "native-revoke")
        _ = try await client.submit(space: space, change: MediaChanges.delete(mediaId: media.id), key: "native-delete")
        _ = try await client.submit(space: space, change: upload, key: "native-upload")
        try mediaCheck(await client.list(space: space).items.allSatisfy { !$0.available }, "old upload does not restore deleted content")
    }
    let records = try await client.records(space: space), posts = await wire.posts
    try mediaCheck(records.allSatisfy { $0.result != nil } && records.count == (phase == "create" ? 2 : 5) && posts == (phase == "create" ? 2 : 3), "bounded original POST counts")
    let report = JSONValue.object(["passed": .bool(true), "phase": .string(phase), "posts": .integer(posts), "records": .array(records.map { .object(["original": $0.original, "result": $0.result!]) }), "native_app_runtime": .bool(false), "hardware": .bool(false)])
    try Data(report.jsonText.utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_MEDIA_TRACE"]!))
}
