import Foundation
import LimeIoTKit

private enum Failure: Error { case check(String), lost }
@MainActor private func expect(_ value: Bool, _ name: String) throws { if !value { throw Failure.check(name) } }
private func object(_ value: JSONValue?) -> [String: JSONValue] { if case .object(let v) = value { v } else { [:] } }
private actor Memory: SessionStore {
    var values: [String: Data] = [:]
    var hold = false
    func setHold(_ value: Bool) { hold = value }
    func load(origin: String) -> Data? { values[origin] }
    func save(origin: String, data: Data?) async throws { values[origin] = data; while hold { try await Task.sleep(for: .milliseconds(10)) } }
}
private actor FixtureWire: HTTPTransport {
    let media: JSONValue, targets: [String: JSONValue]
    var posts = 0, status = 200
    init(media: JSONValue, targets: [String: JSONValue]) { self.media = media; self.targets = targets }
    func setStatus(_ value: Int) { status = value }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        if path.hasSuffix("/auth/session") { return (Data(#"{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"])!) }
        if request.httpMethod == "POST" { posts += 1; throw Failure.check("unexpected write") }
        let value: JSONValue
        var code = status
        if status != 200 { value = .object(["error": .object(["code": .string("fixture_failure")])]) }
        else if path.hasSuffix("/media") { value = media }
        else if path.hasSuffix("/execution-adapters") { value = targets["page"]! }
        else if path.hasSuffix("/execution-binding") { value = object(targets["bindings"])[String(path.split(separator: "/").dropLast().last!)]! }
        else { value = .object(["error": .object(["code": .string("media_operation_not_found")])]); code = 404 }
        return (Data(OtaJSON.canonical(value).utf8), HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!)
    }
}
private actor FileStore: SessionStore {
    let path: URL
    init(_ path: String) { self.path = URL(fileURLWithPath: path) }
    func load(origin: String) throws -> Data? { FileManager.default.fileExists(atPath: path.path) ? try Data(contentsOf: path) : nil }
    func save(origin: String, data: Data?) throws {
        guard let data else { throw Failure.check("unexpected removal") }
        if !FileManager.default.fileExists(atPath: path.path) { guard FileManager.default.createFile(atPath: path.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw Failure.check("store create") } }
        let file = try FileHandle(forWritingTo: path); defer { try? file.close() }
        try file.truncate(atOffset: 0); try file.write(contentsOf: data); try file.synchronize()
    }
}
private actor LiveWire: HTTPTransport {
    let upstream = URLSessionTransport(), drop: Bool
    var posts = 0
    init(drop: Bool) { self.drop = drop }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result = try await upstream.send(request)
        if request.httpMethod == "POST", request.url!.path.hasSuffix("/media-operations") {
            posts += 1
            if drop, object(try OtaJSON.parse(String(decoding: request.httpBody!, as: UTF8.self)))["type"] == .string("media.upload") { throw Failure.lost }
        }
        return result
    }
}
@main struct MediaStoreChecks {
    @MainActor static func contracts() async throws {
        let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        let upload = object(try OtaJSON.parse(String(contentsOf: root.appendingPathComponent("tests/fixtures/media/upload.json"), encoding: .utf8), response: true))
        let targets = object(try OtaJSON.parse(String(contentsOf: root.appendingPathComponent("tests/fixtures/media/targets.json"), encoding: .utf8), response: true))
        let bytes = Data(base64Encoded: object(upload["change"])["content_base64"]!.text)!
        let memory = Memory(), wire = FixtureWire(media: upload["page"]!, targets: targets)
        func expectPosts(_ count: Int) async throws { try expect(await wire.posts == count, "explicit media POST count") }
        var authFailures = 0
        func connect() async throws -> MediaStore {
            let gateway = try GatewayClient(endpoint: "https://nas.local", transport: wire)
            try await gateway.login(token: "fixture")
            return MediaStore(client: MediaClient(gateway: gateway, store: memory), space: "space-demo", authFailure: { _ in authFailures += 1 })
        }
        let store = try await connect(); store.refresh(); await store.waitForIdle()
        store.selectFile(name: "sample.wav", data: bytes)
        try expect(store.ready && store.canUpload && store.targets.count == 2, "file and candidates loaded"); try await expectPosts(0)
        store.grant(); store.approve(true); store.setGrantDuration(30); try expect(!store.approved, "duration clears approval")
        store.approve(true); store.selectTarget("speaker-composed"); try expect(!store.approved, "target clears approval")
        store.approve(true); store.selectMedia("media-original"); try expect(!store.approved, "media clears approval")
        store.approve(true); store.refresh(); await store.waitForIdle(); try expect(!store.approved, "refresh clears approval"); try await expectPosts(0)
        store.requestDelete("media-original"); store.cancelDelete(); store.confirmDelete(); try await expectPosts(0)
        store.selectFile(name: "invalid.wav", data: Data([0])); try expect(store.ready && !store.canUpload, "bad local file preserves management readiness")
        store.selectFile(name: "sample.wav", data: bytes); store.approve(true); store.requestDelete("media-original"); store.setOnline(false); store.upload(); store.grant(); store.confirmDelete()
        try expect(!store.ready && !store.canUpload && !store.approved && store.deletion == nil && store.fileName.isEmpty, "offline clears transient choices"); try await expectPosts(0)
        store.setOnline(true); store.refresh(); await store.waitForIdle(); let observed = store.page?.items.first?.id
        await wire.setStatus(500); store.refresh(); await store.waitForIdle(); try expect(!store.ready && store.page?.items.first?.id == observed, "read failure preserves prior observations and disables writes")
        await wire.setStatus(401); store.refresh(); await store.waitForIdle(); try expect(authFailures == 1, "401 reaches home authentication handler")
        await wire.setStatus(200)
        let cancelled = try await connect(); cancelled.refresh(); await cancelled.waitForIdle(); cancelled.selectFile(name: "sample.wav", data: bytes)
        await memory.setHold(true); cancelled.upload()
        for _ in 0..<100 { if await memory.load(origin: "https://nas.local#media-operations") != nil { break }; try await Task.sleep(for: .milliseconds(5)) }
        try expect(await memory.load(origin: "https://nas.local#media-operations") != nil, "intent reached durable save")
        cancelled.pause(); await cancelled.waitForIdle(); await memory.setHold(false)
        try expect(!cancelled.ready && cancelled.fileName.isEmpty, "cancelled original save disabled state"); try await expectPosts(0)
        let restored = try await connect(); restored.refresh(); await restored.waitForIdle(); try expect(restored.records.count == 1 && restored.records[0].result == nil, "cancelled saved intent remains unknown")
        restored.recover(restored.records[0].id); await restored.waitForIdle(); try expect(!restored.ready, "unknown recovery stays disabled"); try await expectPosts(0)
        restored.close(); restored.refresh(); restored.selectFile(name: "ignored.wav", data: bytes); restored.upload(); try expect(!restored.ready && restored.fileName.isEmpty, "closed store cannot resume"); try await expectPosts(0)
        let file = root.appendingPathComponent(".dev/media-native-state/file-selection.wav")
        try bytes.write(to: file); let selected = try await MediaFile.read(file); try expect(selected.data == bytes, "bounded file reader accepts original PCM bytes")
        try Data(repeating: 0, count: MediaChanges.maxAudioBytes + 1).write(to: file)
        do { _ = try await MediaFile.read(file); throw Failure.check("oversized file accepted") } catch MediaFile.Failure.tooLarge {}
        let task = Task { try await MediaFile.read(file) }; task.cancel()
        do { _ = try await task.value; throw Failure.check("cancelled file returned") } catch is CancellationError {}
        print("{\"media_state_contract_groups\":7}")
    }
    @MainActor static func live() async throws {
        let env = ProcessInfo.processInfo.environment, phase = env["LIMEIOT_MEDIA_PHASE"]!, space = "space-demo"
        let wire = LiveWire(drop: phase == "create"), vault = FileStore(env["LIMEIOT_MEDIA_STORE"]!)
        func expectPosts(_ count: Int) async throws { try expect(await wire.posts == count, "explicit media POST count") }
        let gateway = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, transport: wire, allowLoopbackHTTP: true)
        try await gateway.login(token: env["LIMEIOT_TOKEN"]!)
        let store = MediaStore(client: MediaClient(gateway: gateway, store: vault), space: space, authFailure: { _ in })
        store.refresh(); await store.waitForIdle(); try expect(store.ready && store.targets.count == 1 && store.targets[0].bindingRevision == env["LIMEIOT_MEDIA_BINDING"], "current gateway binding loaded")
        if phase == "create" {
            let file = try await MediaFile.read(URL(fileURLWithPath: env["LIMEIOT_MEDIA_BYTES"]!))
            store.setRetention(600); store.selectFile(name: file.name, data: file.data)
            try await expectPosts(0)
            store.upload(); await store.waitForIdle(); try expect(!store.ready && store.records.count == 1 && store.records[0].result == nil, "upload response loss preserves original")
            store.recover(store.records[0].id); await store.waitForIdle(); try expect(store.ready, "original GET restores upload"); try await expectPosts(1)
        } else {
            try expect(store.records.count == 2 && store.page?.grants.allSatisfy { !$0.active } == true, "process originals restored without authorization")
            for record in store.records { store.recover(record.id); await store.waitForIdle() }
            let old = store.records.first { $0.type == "media.grant" }!
            try expect(object(object(old.result)["result"])["issued_in_process"] == .bool(false), "old receipt not reauthorized")
        }
        let media = store.page!.items.first!
        store.requestDelete(media.id); store.cancelDelete(); store.confirmDelete()
        store.grant(); try await expectPosts(phase == "create" ? 1 : 0)
        store.approve(true); store.setGrantDuration(300); try expect(!store.canGrant, "changed duration requires approval")
        store.approve(true); store.grant(); await store.waitForIdle()
        try expect(store.ready && !store.approved, "explicit authorization completed and discarded approval")
        if phase == "create" {
            let snapshot = try await gateway.snapshot(); try expect(snapshot.commands.items.isEmpty, "upload and grant never play")
            let speaker = snapshot.devices.first { $0.id == "device-lamp" }!
            var command = try await gateway.create(space: space, intent: CommandIntent(device: speaker, path: "playback.play", value: .object(["media_id": .string(media.id)]), type: "action.invoke"))
            for _ in 0..<50 { if command.status == "confirmed" { break }; try await Task.sleep(for: .milliseconds(100)); command = try await gateway.command(space: space, id: command.commandId) }
            try expect(command.status == "confirmed", "separate explicit device command plays")
        } else {
            let grant = store.page!.grants.first { $0.active }!
            store.revoke(grant.id); await store.waitForIdle(); store.requestDelete(media.id); store.confirmDelete(); await store.waitForIdle()
            let upload = store.records.first { $0.type == "media.upload" }!
            store.recover(upload.id); await store.waitForIdle(); try expect(store.page!.items.allSatisfy { !$0.available }, "old upload cannot restore deleted content")
        }
        let records = store.records, posts = await wire.posts
        try expect(records.count == (phase == "create" ? 2 : 5) && records.allSatisfy { $0.result != nil } && posts == (phase == "create" ? 2 : 3), "exact explicit writes")
        store.close(); store.upload(); store.grant()
        let report = JSONValue.object(["passed": .bool(true), "phase": .string(phase), "posts": .integer(posts), "records": .array(records.map { .object(["original": $0.original, "result": $0.result!]) }), "host_ui_state": .bool(true), "native_app_runtime": .bool(false), "hardware": .bool(false)])
        try Data(report.jsonText.utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_MEDIA_TRACE"]!))
    }
    @MainActor static func main() async throws { if ProcessInfo.processInfo.environment["LIMEIOT_MEDIA_STATE_CHECK"] == "1" { try await live() } else { try await contracts() } }
}
