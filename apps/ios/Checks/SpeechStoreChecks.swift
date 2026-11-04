import Foundation
import CryptoKit
import LimeIoTKit

private enum Failure: Error { case check(String), lost, storage }
private func object(_ value: JSONValue?) -> [String: JSONValue] { if case .object(let value) = value { value } else { [:] } }
@MainActor private func expect(_ value: Bool, _ name: String) throws { if !value { throw Failure.check(name) } }
private func vector(_ name: String) throws -> [String: JSONValue] { object(try OtaJSON.parse(String(contentsOfFile: "tests/fixtures/" + name + ".json", encoding: .utf8), response: true)) }
private func timestamp() -> String { let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return formatter.string(from: Date()) }
private actor Memory: SessionStore {
    var data: [String: Data] = [:], fail = false, hold = false, saves = 0
    func configure(fail: Bool = false, hold: Bool = false) { self.fail = fail; self.hold = hold }
    func load(origin: String) -> Data? { data[origin] }
    func save(origin: String, data: Data?) async throws { if fail { throw Failure.storage }; saves += 1; self.data[origin] = data; while hold { try await Task.sleep(for: .milliseconds(5)) } }
}
private actor FixtureWire: HTTPTransport {
    let vector: [String: JSONValue], media: [String: JSONValue], targets: [String: JSONValue]
    var tasks: [String: [String: JSONValue]] = [:], posts = 0, mediaPosts = 0, status = 200
    var state = "running", drop = false, hold = false, waiting = false
    var release: CheckedContinuation<Void, Never>?
    init() throws { vector = try SwiftFixtures.speech(); media = try SwiftFixtures.media(); targets = try SwiftFixtures.targets() }
    func configure(state: String = "running", drop: Bool = false, hold: Bool = false, status: Int = 200) { self.state = state; self.drop = drop; self.hold = hold; self.status = status }
    func resume() { release?.resume(); release = nil }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        func response(_ value: JSONValue, _ code: Int = 200, _ headers: [String: String]? = nil) -> (Data, HTTPURLResponse) { (Data(OtaJSON.canonical(value).utf8), HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: headers)!) }
        func failure(_ code: Int) -> (Data, HTTPURLResponse) { response(.object(["error": .object(["code": .string("fixture_failure")])]), code) }
        if path.hasSuffix("/auth/session") { return response(.object(["authenticated": .bool(true), "csrf_token": .string("csrf"), "expires_at": .string("2030-01-01T00:00:00Z")]), 200, ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"]) }
        if status != 200 { return failure(status) }
        if path.hasSuffix("/capabilities") { return response(.object(["speech": vector["capabilities"]!])) }
        if path.hasSuffix("/media") { return response(media["page"]!) }
        if path.hasSuffix("/execution-adapters") { return response(targets["page"]!) }
        if path.hasSuffix("/execution-binding") { return response(object(targets["bindings"])[String(path.split(separator: "/").dropLast().last!)]!) }
        if path.hasSuffix("/media-operations") { mediaPosts += 1; throw Failure.check("unexpected authorization or playback") }
        let discard = path.hasSuffix("/discard")
        let key = request.value(forHTTPHeaderField: "Idempotency-Key") ?? (discard ? request.url!.deletingLastPathComponent().lastPathComponent : request.url!.lastPathComponent)
        if request.httpMethod == "POST" {
            posts += 1
            if discard { state = "discarded" }
            else {
                let input = try SpeechRequests.parse(String(decoding: request.httpBody!, as: UTF8.self)), values = object(input), text = values["text"]!.text
                var task = object(object(vector["tasks"])["running"])
                let created = timestamp()
                task["synthesis_id"] = .string("speech-" + key); task["idempotency_key"] = .string(key)
                task["request_digest"] = .string(OtaJSON.digest(.object(["space_id": .string("space-demo"), "idempotency_key": .string(key), "input": input])))
                task["input_digest"] = .string("sha256:" + SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined())
                task["input_characters"] = .integer(text.unicodeScalars.count)
                for name in ["voice", "retain_seconds", "expires_at"] { task[name] = values[name] }
                task["created_at"] = .string(created); task["updated_at"] = .string(created); tasks[key] = task
            }
            if hold { waiting = true; await withCheckedContinuation { release = $0 }; waiting = false }
            if drop { throw Failure.lost }
        }
        guard var task = tasks[key] else { return failure(404) }
        task["status"] = .string(state)
        if state != "running" { task["updated_at"] = .string(timestamp()) }
        task["media_id"] = state == "succeeded" ? .string("media-original") : .null
        task["error_code"] = state == "unknown" ? .string("speech_interrupted") : state == "discarded" ? .string("speech_output_discarded") : .null
        return response(.object(task))
    }
}
// 明确限定到仓库内公开测试材料，夹具不持有用户凭据。
private enum SwiftFixtures {
    static func speech() throws -> [String: JSONValue] { try vector("speech/contract") }
    static func media() throws -> [String: JSONValue] { try vector("media/upload") }
    static func targets() throws -> [String: JSONValue] { try vector("media/targets") }
}
// 文件只替代宿主检查中的安全存储端口，两个领域保持独立记录。
private actor FileStore: SessionStore {
    let directory: URL
    init(_ directory: String) { self.directory = URL(fileURLWithPath: directory) }
    private func file(_ origin: String) throws -> URL {
        guard let suffix = ["speech-syntheses", "media-operations"].first(where: { origin.hasSuffix("#" + $0) }) else { throw Failure.storage }
        return directory.appendingPathComponent(suffix + ".json")
    }
    func load(origin: String) throws -> Data? { let path = try file(origin); return FileManager.default.fileExists(atPath: path.path) ? try Data(contentsOf: path) : nil }
    func save(origin: String, data: Data?) throws {
        let path = try file(origin); guard let data else { throw Failure.storage }
        if !FileManager.default.fileExists(atPath: path.path) { guard FileManager.default.createFile(atPath: path.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw Failure.storage } }
        let handle = try FileHandle(forWritingTo: path); defer { try? handle.close() }
        try handle.truncate(atOffset: 0); try handle.write(contentsOf: data); try handle.synchronize()
    }
}
private actor LiveWire: HTTPTransport {
    let upstream = URLSessionTransport(), drop: Bool
    var speechPosts = 0, mediaPosts = 0
    init(drop: Bool) { self.drop = drop }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result = try await upstream.send(request)
        if request.httpMethod == "POST" {
            if request.url!.path.contains("/speech-syntheses") {
                speechPosts += 1
                if drop, request.url!.path.hasSuffix("/speech-syntheses") { throw Failure.lost }
            }
            if request.url!.path.hasSuffix("/media-operations") { mediaPosts += 1 }
        }
        return result
    }
}
@main struct SpeechStoreChecks {
    @MainActor static func contracts() async throws {
        let memory = Memory(), wire = try FixtureWire()
        var selected: [String] = [], authFailures = 0
        func connect() async throws -> (SpeechStore, MediaStore) {
            let gateway = try GatewayClient(endpoint: "https://nas.local", transport: wire); try await gateway.login(token: "fixture")
            let media = MediaStore(client: MediaClient(gateway: gateway, store: memory), space: "space-demo", authFailure: { _ in })
            media.refresh(); await media.waitForIdle()
            let speech = SpeechStore(client: SpeechClient(gateway: gateway, store: memory), space: "space-demo", authFailure: { _ in authFailures += 1 }, onGenerated: { id in selected.append(id); await media.useGenerated(id) })
            speech.refresh(); await speech.waitForIdle(); return (speech, media)
        }
        let (speech, media) = try await connect()
        try expect(speech.prepareAnswer("完整回答🍋") && speech.text == "完整回答🍋", "explicit answer handoff")
        for invalid in [" ", String(repeating: "字", count: 1001), String(repeating: "🍋", count: 1001)] { try expect(!speech.prepareAnswer(invalid) && speech.text == "完整回答🍋", "handoff never truncates or replaces draft") }
        try expect(await wire.posts == 0, "handoff zero POST")
        speech.setText("青柠🍋萌宠"); speech.selectVoice("other"); speech.setRetention(3600)
        try expect(speech.ready && speech.canGenerate && speech.voice == "other", "local input ready")
        try expect(await wire.posts == 0, "selection zero POST")
        media.approve(true); speech.generate(); await speech.waitForIdle()
        try expect(speech.text.isEmpty && speech.records.first?.status == "running" && !speech.canGenerate, "running clears text and blocks replacement")
        await wire.configure(state: "succeeded"); speech.poll(); await speech.waitForIdle()
        try expect(selected == ["media-original"] && media.selectedMedia == "media-original" && !media.approved, "success selects actual media and clears approval")
        try expect(await wire.mediaPosts == 0, "generation never grants or plays")
        speech.setText("输入\r不合法"); speech.generate(); try expect(speech.ready && !speech.message.isEmpty, "bad input preserves readiness")
        speech.setText("私密正文"); speech.setOnline(false); speech.generate()
        try expect(speech.text.isEmpty && !speech.ready && speech.confirmation == nil, "offline clears text")
        speech.setOnline(true); speech.refresh(); await speech.waitForIdle(); speech.setText("后台正文"); speech.pause()
        try expect(speech.text.isEmpty && !speech.ready, "background clears text")
        try expect(!speech.prepareAnswer("后台"), "paused handoff refused")

        let (unknown, _) = try await connect(); await wire.configure(drop: true)
        unknown.setText("丢失响应"); unknown.generate(); await unknown.waitForIdle()
        try expect(!unknown.ready && unknown.records.last?.result == nil, "lost response preserves unresolved original")
        let posts = await wire.posts
        await wire.configure(state: "unknown"); let (restored, _) = try await connect()
        try expect(restored.ready && restored.pending && !restored.canGenerate, "restored unknown occupies budget")
        try expect(!restored.prepareAnswer("替换未决输出"), "unknown handoff refused")
        let key = restored.records.last!.id
        restored.requestDiscard(key); restored.cancelDiscard(); restored.confirmDiscard()
        try expect(await wire.posts == posts, "cancel discard zero POST")
        restored.requestDiscard(key); restored.confirmDiscard(); await restored.waitForIdle()
        try expect(restored.records.last?.status == "discarded", "confirmed discard")
        try expect(await wire.posts == posts + 1, "one explicit discard")

        await wire.configure(hold: true); restored.setText("迟到输出"); restored.generate()
        for _ in 0..<1000 { if await wire.waiting { break }; try await Task.sleep(for: .milliseconds(1)) }
        try expect(await wire.waiting, "pending response entered")
        let selections = selected.count; restored.pause(); await wire.configure(state: "succeeded"); await wire.resume(); await restored.waitForIdle()
        try expect(restored.text.isEmpty && !restored.ready && selected.count == selections, "late success cannot update paused UI or selection")
        restored.refresh(); await restored.waitForIdle(); try expect(restored.ready, "foreground original query recovers")

        let (failed, _) = try await connect(); await memory.configure(fail: true)
        let before = await wire.posts; failed.setText("保存失败"); failed.generate(); await failed.waitForIdle()
        try expect(await wire.posts == before, "save failure zero POST")
        await memory.configure(); let (cancelled, _) = try await connect(); await memory.configure(hold: true)
        let savesBefore = await memory.saves
        cancelled.setText("保存后取消"); cancelled.generate()
        for _ in 0..<1000 { if await memory.saves > savesBefore { break }; try await Task.sleep(for: .milliseconds(1)) }
        try expect(await memory.saves > savesBefore, "cancelled intent reached save")
        cancelled.pause(); await cancelled.waitForIdle(); await memory.configure()
        try expect(await wire.posts == before, "cancel save zero POST")
        cancelled.refresh(); await cancelled.waitForIdle()
        try expect(cancelled.ready && cancelled.pending, "same client resumes saved intent without POST")
        let (readable, _) = try await connect()
        let observed = readable.records.count; await wire.configure(status: 500); readable.refresh(); await readable.waitForIdle()
        try expect(!readable.ready && readable.records.count == observed, "read failure preserves observed originals")
        await wire.configure(status: 401); readable.refresh(); await readable.waitForIdle(); try expect(authFailures == 1 && readable.text.isEmpty, "401 clears text and reaches session handler")
        readable.close(); readable.setOnline(true); readable.refresh(); readable.setText("closed"); readable.generate()
        try expect(readable.text.isEmpty && !readable.ready, "closed store rejects work")
        print("{\"speech_state_contract_groups\":8}")
    }
    @MainActor static func live() async throws {
        let env = ProcessInfo.processInfo.environment, phase = env["LIMEIOT_SPEECH_PHASE"]!, space = "space-demo"
        let wire = LiveWire(drop: phase == "create"), vault = FileStore(env["LIMEIOT_SPEECH_STORE"]!)
        let gateway = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, transport: wire, allowLoopbackHTTP: true); try await gateway.login(token: env["LIMEIOT_TOKEN"]!)
        let media = MediaStore(client: MediaClient(gateway: gateway, store: vault), space: space, authFailure: { _ in })
        media.refresh(); await media.waitForIdle(); var selected: [String] = []
        let speech = SpeechStore(client: SpeechClient(gateway: gateway, store: vault), space: space, authFailure: { _ in }, onGenerated: { id in selected.append(id); await media.useGenerated(id) })
        speech.refresh(); await speech.waitForIdle(); try expect(speech.ready && media.ready, "real gateway ready")
        if phase == "create" {
            speech.setText("原生青柠萌宠欢迎回家。"); speech.generate(); await speech.waitForIdle()
            try expect(!speech.ready && speech.records.count == 1 && speech.records[0].result == nil, "actual response loss preserves original")
            speech.recover(speech.records[0].id); await speech.waitForIdle()
            for _ in 0..<100 { if speech.records[0].status == "succeeded" { break }; try await Task.sleep(for: .milliseconds(50)); speech.poll(); await speech.waitForIdle() }
            try expect(speech.records[0].status == "succeeded" && selected.count == 1 && media.selectedMedia == selected[0] && !media.approved, "original completion selects without approval")
            media.grant(); await media.waitForIdle(); try expect(await wire.mediaPosts == 0, "unapproved grant zero POST")
            media.approve(true); media.grant(); await media.waitForIdle(); try expect(media.ready && !media.approved, "separate explicit authorization")
            let snapshot = try await gateway.snapshot(); try expect(snapshot.commands.items.isEmpty, "generation and authorization do not play")
            let device = snapshot.devices.first { $0.id == "device-lamp" }!
            var command = try await gateway.create(space: space, intent: CommandIntent(device: device, path: "playback.play", value: .object(["media_id": .string(selected[0])]), type: "action.invoke"))
            for _ in 0..<50 { if command.status == "confirmed" { break }; try await Task.sleep(for: .milliseconds(100)); command = try await gateway.command(space: space, id: command.commandId) }
            try expect(command.status == "confirmed", "separate explicit playback")
        } else if phase == "restore" {
            try expect(speech.records.count == 1 && speech.records[0].status == "succeeded" && media.page?.grants.allSatisfy { !$0.active } == true, "process and gateway restore without reauthorization")
            speech.recover(speech.records[0].id); await speech.waitForIdle(); try expect(speech.ready && selected.count == 1 && !media.approved, "manual original query restores selection only")
        } else if phase == "unknown-start" {
            speech.setText("hold"); speech.generate(); await speech.waitForIdle()
            try expect(speech.records.count == 2 && speech.records.last?.status == "running" && !speech.canGenerate, "running original saved before process exit")
        } else if phase == "unknown-restore" {
            try expect(speech.records.count == 2 && speech.records.last?.status == "unknown" && !speech.canGenerate && speech.pending, "gateway restart preserves unknown budget")
            speech.setText("replacement"); speech.generate(); try expect(await wire.speechPosts == 0, "unknown cannot resubmit")
            let key = speech.records.last!.id; speech.requestDiscard(key); speech.cancelDiscard(); speech.confirmDiscard()
            try expect(await wire.speechPosts == 0, "cancelled confirmation zero POST")
            speech.requestDiscard(key); speech.confirmDiscard(); await speech.waitForIdle()
            try expect(speech.records.last?.status == "discarded" && selected.isEmpty, "explicit discard never selects output")
        } else { throw Failure.check("unknown phase") }
        let speechPosts = await wire.speechPosts, mediaPosts = await wire.mediaPosts
        try expect(speechPosts == (["create", "unknown-start", "unknown-restore"].contains(phase) ? 1 : 0), "bounded explicit speech POST count")
        try expect(mediaPosts == (phase == "create" ? 1 : 0), "no automatic media mutations")
        let trace: JSONValue = .object(["passed": .bool(true), "phase": .string(phase), "host_ui_state": .bool(true), "speech_posts": .integer(speechPosts), "media_posts": .integer(mediaPosts), "approved": .bool(media.approved), "selected": .array(selected.map(JSONValue.string)), "records": .array(speech.records.map { .object(["original": $0.original, "result": $0.result ?? .null, "discard_intents": .array($0.discardIntents.map(JSONValue.string))]) })])
        try Data(OtaJSON.canonical(trace).utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_SPEECH_TRACE"]!)); speech.close(); media.close()
    }
    @MainActor static func main() async throws {
        if ProcessInfo.processInfo.environment["LIMEIOT_SPEECH_STATE_CHECK"] == "1" { try await live() } else { try await contracts() }
    }
}
