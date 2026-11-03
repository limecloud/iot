import Foundation
import CryptoKit
import LimeIoTKit

private enum Failure: Error { case check(String), lost, storage }
private func object(_ value: JSONValue?) -> [String: JSONValue] { if case .object(let fields) = value { fields } else { [:] } }
@MainActor private func expect(_ value: Bool, _ name: String) throws { if !value { throw Failure.check(name) } }
private func timestamp(_ value: Date = Date()) -> String { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.string(from: value) }
private func parseTime(_ value: JSONValue?) -> Date { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; if case .string(let text) = value { return f.date(from: text)! }; return .distantPast }
private func digest(_ value: Data) -> String { "sha256:" + SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined() }
private func fixture() throws -> [String: JSONValue] { object(try OtaJSON.parse(String(contentsOfFile: "tests/fixtures/vision/contract.json", encoding: .utf8), response: true)) }
private actor Memory: SessionStore {
    var data: [String: Data] = [:], fail = false, hold = false, saves = 0
    func configure(fail: Bool = false, hold: Bool = false) { self.fail = fail; self.hold = hold }
    func load(origin: String) -> Data? { data[origin] }
    func save(origin: String, data: Data?) async throws { if fail { throw Failure.storage }; saves += 1; self.data[origin] = data; while hold { try await Task.sleep(for: .milliseconds(5)) } }
}
private actor Wire: HTTPTransport {
    let vector: [String: JSONValue]
    var tasks: [String: [String: JSONValue]] = [:], posts = 0, otherPosts = 0, status = 200
    var state = "running", drop = false, hold = false, waiting = false, configured = true
    var release: CheckedContinuation<Void, Never>?
    init() throws { vector = try fixture() }
    func configure(state: String = "running", drop: Bool = false, hold: Bool = false, status: Int = 200, configured: Bool = true) { self.state = state; self.drop = drop; self.hold = hold; self.status = status; self.configured = configured }
    func resume() { release?.resume(); release = nil }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        func response(_ value: JSONValue, _ code: Int = 200, _ headers: [String: String]? = nil) -> (Data, HTTPURLResponse) { (Data(OtaJSON.canonical(value).utf8), HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: headers)!) }
        func failure(_ code: Int) -> (Data, HTTPURLResponse) { response(.object(["error": .object(["code": .string("fixture_failure")])]), code) }
        if path.hasSuffix("/auth/session") { return response(.object(["authenticated": .bool(true), "csrf_token": .string("csrf"), "expires_at": .string("2030-01-01T00:00:00Z")]), 200, ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"]) }
        if status != 200 { return failure(status) }
        if path.hasSuffix("/capabilities") { return response(.object(["vision": configured ? vector["capabilities"]! : .object(["configured": .bool(false), "capability": .string("vision.understand")])])) }
        guard path.contains("/vision-observations") else { if request.httpMethod == "POST" { otherPosts += 1 }; throw Failure.check("unexpected effect") }
        let discard = path.hasSuffix("/discard"), key = request.value(forHTTPHeaderField: "Idempotency-Key") ?? (discard ? request.url!.deletingLastPathComponent().lastPathComponent : request.url!.lastPathComponent)
        if request.httpMethod == "POST" {
            posts += 1
            if discard {
                guard var task = tasks[key] else { return failure(404) }
                if task["status"] == .string("succeeded") { var output = object(task["output"]); output["text"] = .null; output["cleared_at"] = .string(timestamp(max(Date(), parseTime(task["updated_at"])))); task["output"] = .object(output) }
                else { task["status"] = .string("discarded"); task["updated_at"] = .string(timestamp()); task["error_code"] = .string("vision_output_discarded"); task["output"] = .null; state = "discarded" }
                tasks[key] = task
            } else {
                let raw = object(try VisionRequests.parse(String(decoding: request.httpBody!, as: UTF8.self))), bytes = Data(base64Encoded: { if case .string(let s) = raw["image_base64"] { s } else { "" } }())!
                let summary: JSONValue = .object(["image_digest": .string(digest(bytes)), "image_bytes": .integer(bytes.count), "content_type": raw["content_type"]!, "prompt_digest": .string(digest(Data({ if case .string(let s) = raw["prompt"] { s } else { "" } }().utf8))), "retain_seconds": raw["retain_seconds"]!, "expires_at": raw["expires_at"]!])
                var task = object(object(vector["tasks"])["running"]); task["vision_id"] = .string("vision-" + key); task["idempotency_key"] = .string(key); task["input"] = summary
                task["request_digest"] = .string(OtaJSON.digest(.object(["space_id": .string("space-demo"), "idempotency_key": .string(key), "input": summary])))
                let created = timestamp(); task["created_at"] = .string(created); task["updated_at"] = .string(created); tasks[key] = task
            }
            if hold { waiting = true; await withCheckedContinuation { release = $0 }; waiting = false }
            if drop { throw Failure.lost }
        }
        guard var task = tasks[key] else { return failure(404) }
        if task["status"] != .string(state) {
            let updated = max(Date(), parseTime(task["created_at"]).addingTimeInterval(0.001)), at = timestamp(updated)
            task["status"] = .string(state); task["updated_at"] = .string(at)
            task["error_code"] = state == "unknown" ? .string("vision_interrupted") : state == "discarded" ? .string("vision_output_discarded") : .null
            if state == "succeeded" {
                let text = "观察结果🍋"; task["output"] = .object(["text": .string(text), "content_digest": .string(digest(Data(text.utf8))), "expires_at": .string(timestamp(parseTime(.string(at)).addingTimeInterval(600))), "cleared_at": .null])
            } else { task["output"] = .null }
            tasks[key] = task
        }
        return response(.object(task))
    }
}
private actor FileStore: SessionStore {
    let path: String
    init(_ path: String) { self.path = path }
    func load(origin: String) throws -> Data? { guard origin.hasSuffix("#vision-observations") else { throw Failure.storage }; return FileManager.default.fileExists(atPath: path) ? try Data(contentsOf: URL(fileURLWithPath: path)) : nil }
    func save(origin: String, data: Data?) throws {
        guard origin.hasSuffix("#vision-observations"), let data else { throw Failure.storage }
        if !FileManager.default.fileExists(atPath: path) { guard FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw Failure.storage } }
        let file = try FileHandle(forWritingTo: URL(fileURLWithPath: path)); defer { try? file.close() }; try file.truncate(atOffset: 0); try file.write(contentsOf: data); try file.synchronize()
    }
}
private actor LiveWire: HTTPTransport {
    let upstream = URLSessionTransport(), drop: Bool
    var posts = 0, otherPosts = 0
    init(drop: Bool) { self.drop = drop }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result = try await upstream.send(request)
        if request.httpMethod == "POST", !request.url!.path.hasSuffix("/auth/session") {
            if request.url!.path.contains("/vision-observations") { posts += 1; if drop && request.url!.path.hasSuffix("/vision-observations") { throw Failure.lost } } else { otherPosts += 1 }
        }
        return result
    }
}
@main struct VisionStoreChecks {
    @MainActor static func contracts() async throws {
        var auth = 0, clock = Date()
        let vector = try fixture(), image = Data(base64Encoded: { if case .string(let s) = object(vector["input"])["image_base64"] { s } else { "" } }())!
        func connect(_ memory: Memory, _ wire: Wire) async throws -> VisionStore {
            let gateway = try GatewayClient(endpoint: "https://nas.local", transport: wire); try await gateway.login(token: "fixture")
            let state = VisionStore(client: VisionClient(gateway: gateway, store: memory), space: "space-demo", authFailure: { _ in auth += 1 }, now: { clock }); state.refresh(); await state.waitForIdle(); return state
        }
        func choose(_ state: VisionStore) { state.selectFile("blocks.png", bytes: image); state.setPrompt("请观察图片") }
        do {
            let wire = try Wire(), state = try await connect(Memory(), wire); try expect(state.ready && !state.canGenerate, "explicit file and question required")
            choose(state); try expect(state.canGenerate, "ready input"); state.generate(); await state.waitForIdle()
            try expect(state.pending && !state.canGenerate && state.fileName.isEmpty && state.prompt.isEmpty, "accepted input cleared, one pending budget")
            await wire.configure(state: "succeeded"); state.poll(); await state.waitForIdle(); try expect(state.text(for: state.records[0].id) == "观察结果🍋", "poll shows verified output")
            let otherPosts = await wire.otherPosts; try expect(await wire.posts == 1 && otherPosts == 0, "no implicit device effects")
            choose(state); state.pause(); try expect(state.outputs.isEmpty && state.prompt.isEmpty && state.fileName.isEmpty && !state.ready, "pause clears input and result")
            state.refresh(); await state.waitForIdle(); try expect(state.outputs.isEmpty, "completed plaintext not fetched automatically")
            state.recover(state.records[0].id); await state.waitForIdle(); try expect(!state.outputs.isEmpty, "explicit query restores text")
            state.setOnline(false); state.selectFile("late.png", bytes: image); try expect(state.outputs.isEmpty && state.fileName.isEmpty, "offline rejects late selection")
            state.close(); state.setOnline(true); state.refresh(); choose(state); state.generate(); try expect(!state.ready && state.fileName.isEmpty, "closed state rejects work")
        }
        do {
            let memory = Memory(), wire = try Wire(), state = try await connect(memory, wire); await wire.configure(drop: true); choose(state); state.generate(); await state.waitForIdle()
            try expect(!state.ready && state.records[0].observation == nil, "lost receipt retains original")
            await wire.configure(state: "unknown"); let restored = try await connect(memory, wire); try expect(restored.pending && !restored.canGenerate, "restored unknown budget")
            let key = restored.records[0].id; restored.requestDiscard(key); restored.poll(); try expect(restored.confirmation == key, "poll does not dismiss decision")
            restored.cancelDiscard(); restored.confirmDiscard(); try expect(await wire.posts == 1, "cancel zero POST")
            restored.requestDiscard(key); restored.confirmDiscard(); await restored.waitForIdle(); try expect(restored.records[0].status == "discarded", "explicit abandon")
        }
        do {
            let wire = try Wire(), state = try await connect(Memory(), wire); await wire.configure(hold: true); choose(state); state.generate()
            for _ in 0..<1000 { if await wire.waiting { break }; try await Task.sleep(for: .milliseconds(1)) }; try expect(await wire.waiting, "actual request entered")
            state.pause(); await wire.configure(state: "succeeded"); await wire.resume(); await state.waitForIdle(); try expect(state.outputs.isEmpty && !state.ready, "late response cannot update paused UI")
            state.refresh(); await state.waitForIdle(); try expect(state.ready && state.outputs.isEmpty, "resume restores only metadata")
            try expect(await wire.posts == 1, "late recovery zero new POST")
        }
        for cancel in [false, true] {
            let memory = Memory(), wire = try Wire(), state = try await connect(memory, wire); await memory.configure(fail: !cancel, hold: cancel); choose(state); state.generate()
            if cancel { for _ in 0..<1000 { if await memory.saves > 0 { break }; try await Task.sleep(for: .milliseconds(1)) }; try expect(await memory.saves > 0, "save entered"); state.pause() }
            await state.waitForIdle(); await memory.configure(); try expect(await wire.posts == 0, "save failure or cancellation zero POST")
        }
        do {
            let wire = try Wire(), state = try await connect(Memory(), wire); choose(state); state.generate(); await state.waitForIdle(); let count = state.records.count
            await wire.configure(status: 500); state.refresh(); await state.waitForIdle(); try expect(!state.ready && state.records.count == count, "read failure keeps original")
            await wire.configure(status: 401); state.refresh(); await state.waitForIdle(); try expect(auth == 1 && state.outputs.isEmpty, "401 reaches auth owner")
        }
        do {
            let wire = try Wire(), state = try await connect(Memory(), wire); await wire.configure(state: "succeeded"); choose(state); state.generate(); await state.waitForIdle()
            let key = state.records[0].id; try expect(state.text(for: key) != nil, "TTL result visible"); clock = Date().addingTimeInterval(601); state.poll(); try expect(state.outputs.isEmpty && state.text(for: key) == nil, "state clock advancement evicts expired result"); clock = Date()
        }
        do {
            let wire = try Wire(), state = try await connect(Memory(), wire); await wire.configure(state: "succeeded"); choose(state); state.generate(); await state.waitForIdle(); let key = state.records[0].id
            state.requestDiscard(key); try expect(state.clearingSuccess, "success clear decision"); state.cancelDiscard(); state.confirmDiscard(); try expect(await wire.posts == 1, "cancel clear zero POST")
            state.requestDiscard(key); state.confirmDiscard(); await state.waitForIdle(); try expect(state.outputs.isEmpty && state.records[0].status == "succeeded" && !state.records[0].canDiscard, "clear preserves original success")
            try expect(await wire.posts == 2, "one clear POST")
        }
        do {
            let wire = try Wire(), state = try await connect(Memory(), wire); state.selectFile("bad.png", bytes: Data([1,2,3])); state.setPrompt("问题"); try expect(!state.canGenerate && state.fileName.isEmpty, "invalid image rejected")
            state.selectFile("blocks.png", bytes: image); state.setPrompt(String(repeating: "🍋", count: 513)); try expect(!state.canGenerate, "question scalar bound")
            state.setPrompt("问题"); await wire.configure(configured: false); state.refresh(); await state.waitForIdle(); state.generate(); try expect(await wire.posts == 0 && !state.canGenerate, "unconfigured provider zero submit")
        }
        do {
            let url = URL(fileURLWithPath: ".dev/vision-native-state/bounded-image.bin"), data = Data(repeating: 0, count: VisionRequests.maxImageBytes + 1); try data.write(to: url)
            do { _ = try await MediaFile.read(url, maxBytes: VisionRequests.maxImageBytes); throw Failure.check("image overflow accepted") } catch MediaFile.Failure.tooLarge {}
            let audio = try await MediaFile.read(url); try expect(audio.data == data, "default audio read limit preserved")
        }
        print("{\"vision_state_contract_groups\":9}")
    }
    @MainActor static func live() async throws {
        let env = ProcessInfo.processInfo.environment, phase = env["LIMEIOT_VISION_PHASE"]!, space = "space-demo"
        let vault = FileStore(env["LIMEIOT_VISION_STORE"]!), wire = LiveWire(drop: phase == "create")
        let gateway = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, transport: wire, allowLoopbackHTTP: true); try await gateway.login(token: env["LIMEIOT_TOKEN"]!)
        let state = VisionStore(client: VisionClient(gateway: gateway, store: vault), space: space, authFailure: { _ in }); state.refresh(); await state.waitForIdle(); try expect(state.ready && state.outputs.isEmpty, "new process restores no plaintext")
        func choose() throws { state.selectFile("input.png", bytes: try Data(contentsOf: URL(fileURLWithPath: env["LIMEIOT_VISION_IMAGE"]!))); state.setPrompt("请观察青柠🍋与é，有什么形状？") }
        if phase == "create" {
            try choose(); state.generate(); await state.waitForIdle(); try expect(!state.ready && state.records.count == 1 && state.records[0].observation == nil, "lost actual receipt")
            state.recover(state.records[0].id); await state.waitForIdle()
            for _ in 0..<100 { if state.records[0].status != "running" { break }; try await Task.sleep(for: .milliseconds(50)); state.poll(); await state.waitForIdle() }
            try expect(state.text(for: state.records[0].id) == env["LIMEIOT_VISION_TEXT"], "actual text verified"); state.pause(); state.refresh(); await state.waitForIdle(); try expect(state.outputs.isEmpty, "foreground no completed text fetch")
        } else if phase == "restore" {
            try expect(state.records.count == 1 && state.records[0].status == "succeeded", "same original after restart"); state.recover(state.records[0].id); await state.waitForIdle(); try expect(state.text(for: state.records[0].id) == env["LIMEIOT_VISION_TEXT"], "explicit GET restores text")
        } else if phase == "unknown-start" {
            try choose(); state.generate(); await state.waitForIdle(); try expect(state.records.count == 2 && state.records.last?.status == "running" && !state.canGenerate, "real in-flight task")
        } else if phase == "unknown-restore" {
            try expect(state.records.last?.status == "unknown" && state.pending, "restart keeps unknown budget"); try choose(); state.generate(); try expect(await wire.posts == 0, "unknown blocks replacement")
            let key = state.records.last!.id; state.requestDiscard(key); state.cancelDiscard(); state.confirmDiscard(); try expect(await wire.posts == 0, "cancel abandon zero POST"); state.requestDiscard(key); state.confirmDiscard(); await state.waitForIdle(); try expect(state.records.last?.status == "discarded", "explicit abandon")
        } else if phase == "clear" {
            let key = state.records[0].id; state.recover(key); await state.waitForIdle(); state.requestDiscard(key); state.cancelDiscard(); state.confirmDiscard(); try expect(await wire.posts == 0, "cancel clear zero POST"); state.requestDiscard(key); state.confirmDiscard(); await state.waitForIdle(); try expect(state.outputs.isEmpty && state.records[0].status == "succeeded" && !state.records[0].canDiscard, "success cleared")
        } else if phase == "cleared-restore" { state.recover(state.records[0].id); await state.waitForIdle(); try expect(state.outputs.isEmpty && !state.records[0].canDiscard, "cleared text stays cleared") }
        else { throw Failure.check("invalid phase") }
        let posts = await wire.posts, otherPosts = await wire.otherPosts; try expect(posts == (["create", "unknown-start", "unknown-restore", "clear"].contains(phase) ? 1 : 0) && otherPosts == 0, "exact POST budget")
        let trace: JSONValue = .object(["passed": .bool(true), "phase": .string(phase), "native_host_library": .bool(true), "host_ui_state": .bool(true), "vision_posts": .integer(posts), "other_posts": .integer(otherPosts), "records": .array(state.records.map { .object(["original": $0.original, "observation": $0.observation ?? .null, "discard_intents": .array($0.discardIntents.map(JSONValue.string))]) })])
        try Data(OtaJSON.canonical(trace).utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_VISION_TRACE"]!)); state.close()
    }
    @MainActor static func main() async throws { if ProcessInfo.processInfo.environment["LIMEIOT_VISION_STATE_CHECK"] == "1" { try await live() } else { try await contracts() } }
}
