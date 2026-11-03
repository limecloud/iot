import Foundation
import CryptoKit
import LimeIoTKit

private enum Failure: Error { case check(String), lost, storage }
private func object(_ value: JSONValue?) -> [String: JSONValue] { if case .object(let value) = value { value } else { [:] } }
@MainActor private func expect(_ value: Bool, _ name: String) throws { if !value { throw Failure.check(name) } }
private func fixture(_ name: String) throws -> [String: JSONValue] { object(try OtaJSON.parse(String(contentsOfFile: "tests/fixtures/" + name + ".json", encoding: .utf8), response: true)) }
private func timestamp(_ date: Date = Date()) -> String { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.string(from: date) }
private actor Memory: SessionStore {
    var data: [String: Data] = [:], fail = false, hold = false, saves = 0
    func configure(fail: Bool = false, hold: Bool = false) { self.fail = fail; self.hold = hold }
    func load(origin: String) -> Data? { data[origin] }
    func save(origin: String, data: Data?) async throws { if fail { throw Failure.storage }; saves += 1; self.data[origin] = data; while hold { try await Task.sleep(for: .milliseconds(5)) } }
}
private actor Wire: HTTPTransport {
    let vector: [String: JSONValue], media: [String: JSONValue]
    var tasks: [String: [String: JSONValue]] = [:], posts = 0, otherPosts = 0, status = 200
    var state = "running", drop = false, hold = false, waiting = false, sourceAvailable = true, outputSeconds = 600.0
    var release: CheckedContinuation<Void, Never>?
    init() throws { vector = try fixture("transcription/contract"); media = try fixture("media/upload") }
    func configure(state: String = "running", drop: Bool = false, hold: Bool = false, status: Int = 200, sourceAvailable: Bool = true, outputSeconds: Double = 600) { self.state = state; self.drop = drop; self.hold = hold; self.status = status; self.sourceAvailable = sourceAvailable; self.outputSeconds = outputSeconds }
    func resume() { release?.resume(); release = nil }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        func response(_ value: JSONValue, _ code: Int = 200, _ headers: [String: String]? = nil) -> (Data, HTTPURLResponse) { (Data(OtaJSON.canonical(value).utf8), HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: headers)!) }
        func failure(_ code: Int) -> (Data, HTTPURLResponse) { response(.object(["error": .object(["code": .string("fixture_failure")])]), code) }
        if path.hasSuffix("/auth/session") { return response(.object(["authenticated": .bool(true), "csrf_token": .string("csrf"), "expires_at": .string("2030-01-01T00:00:00Z")]), 200, ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"]) }
        if status != 200 { return failure(status) }
        if path.hasSuffix("/capabilities") { return response(.object(["transcription": vector["capabilities"]!])) }
        if path.hasSuffix("/media") {
            var page = object(media["page"]), metadata = object(object(media["operation"])["result"]); metadata = object(metadata["media"])
            metadata["created_at"] = .string(timestamp()); metadata["expires_at"] = .string(timestamp(Date().addingTimeInterval(600)))
            page["grants"] = .array([]); page["items"] = .array([.object(["metadata": .object(metadata), "available": .bool(sourceAvailable), "deleted_at": .null])]); return response(.object(page))
        }
        guard path.contains("/audio-transcriptions") else { if request.httpMethod == "POST" { otherPosts += 1 }; throw Failure.check("unexpected effect") }
        let discard = path.hasSuffix("/discard")
        let key = request.value(forHTTPHeaderField: "Idempotency-Key") ?? (discard ? request.url!.deletingLastPathComponent().lastPathComponent : request.url!.lastPathComponent)
        if request.httpMethod == "POST" {
            posts += 1
            if discard { state = "discarded" }
            else {
                let input = try TranscriptionRequests.parse(String(decoding: request.httpBody!, as: UTF8.self)); var task = object(object(vector["tasks"])["running"])
                task["transcription_id"] = .string("transcription-" + key); task["idempotency_key"] = .string(key); task["input"] = input
                task["request_digest"] = .string(OtaJSON.digest(.object(["space_id": .string("space-demo"), "idempotency_key": .string(key), "input": input])))
                let created = timestamp(); task["created_at"] = .string(created); task["updated_at"] = .string(created); tasks[key] = task
            }
            if hold { waiting = true; await withCheckedContinuation { release = $0 }; waiting = false }
            if drop { throw Failure.lost }
        }
        guard var task = tasks[key] else { return failure(404) }
        if task["status"] != .string(state) {
            task["status"] = .string(state); task["updated_at"] = .string(timestamp())
            task["error_code"] = state == "unknown" ? .string("transcription_interrupted") : state == "discarded" ? .string("transcription_output_discarded") : .null
            if state == "succeeded" {
                let text = "识别结果🍋", hash = "sha256:" + SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
                task["output"] = .object(["text": .string(text), "content_digest": .string(hash), "expires_at": .string(timestamp(Date().addingTimeInterval(outputSeconds))), "cleared_at": .null])
            } else { task["output"] = .null }
            tasks[key] = task
        }
        return response(.object(task))
    }
}
private actor FileStore: SessionStore {
    let directory: String
    init(_ directory: String) { self.directory = directory }
    private func file(_ origin: String) throws -> URL { guard origin.hasSuffix("#audio-transcriptions") else { throw Failure.storage }; return URL(fileURLWithPath: directory).appendingPathComponent("audio-transcriptions.json") }
    func load(origin: String) throws -> Data? { let url = try file(origin); return FileManager.default.fileExists(atPath: url.path) ? try Data(contentsOf: url) : nil }
    func save(origin: String, data: Data?) throws {
        let url = try file(origin); guard let data else { throw Failure.storage }
        if !FileManager.default.fileExists(atPath: url.path) { guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw Failure.storage } }
        let handle = try FileHandle(forWritingTo: url); defer { try? handle.close() }; try handle.truncate(atOffset: 0); try handle.write(contentsOf: data); try handle.synchronize()
    }
}
private actor LiveWire: HTTPTransport {
    let upstream = URLSessionTransport(), drop: Bool
    var posts = 0, otherPosts = 0
    init(drop: Bool) { self.drop = drop }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result = try await upstream.send(request)
        if request.httpMethod == "POST", !request.url!.path.hasSuffix("/auth/session") {
            if request.url!.path.contains("/audio-transcriptions") { posts += 1; if drop && request.url!.path.hasSuffix("/audio-transcriptions") { throw Failure.lost } }
            else { otherPosts += 1 }
        }
        return result
    }
}
@main struct TranscriptionStoreChecks {
    @MainActor static func contracts() async throws {
        var auth = 0
        func connect(_ memory: Memory, _ wire: Wire) async throws -> TranscriptionStore {
            let gateway = try GatewayClient(endpoint: "https://nas.local", transport: wire); try await gateway.login(token: "fixture")
            let state = TranscriptionStore(client: TranscriptionClient(gateway: gateway, store: memory), media: MediaClient(gateway: gateway, store: memory), space: "space-demo", authFailure: { _ in auth += 1 })
            state.refresh(); await state.waitForIdle(); return state
        }
        do {
            let memory = Memory(), wire = try Wire(), state = try await connect(memory, wire)
            try expect(state.ready && !state.canGenerate && state.sources.count == 1, "source must be explicitly selected")
            state.selectMedia("media-original"); state.selectLanguage("en"); state.selectLanguage("fr")
            try expect(state.canGenerate && state.language == "en", "verified source and language")
            try expect(await wire.posts == 0, "selection zero POST")
            state.generate(); await state.waitForIdle(); try expect(state.pending && !state.canGenerate, "one pending budget")
            await wire.configure(state: "succeeded"); state.poll(); await state.waitForIdle()
            let key = state.records[0].id; try expect(state.text(for: key) == "识别结果🍋", "success remains visible after metadata reload")
            try expect(await wire.otherPosts == 0, "recognition never authorizes or executes")
            state.pause(); try expect(state.outputs.isEmpty && !state.ready && state.confirmation == nil, "background clears all text")
            state.refresh(); await state.waitForIdle(); try expect(state.text(for: key) == nil, "foreground never automatically reloads completed text")
            state.recover(key); await state.waitForIdle(); try expect(state.text(for: key) != nil, "explicit GET restores completed text")
            state.setOnline(false); try expect(state.outputs.isEmpty, "offline clears text")
            state.close(); state.setOnline(true); state.refresh(); state.generate(); try expect(!state.ready && state.outputs.isEmpty, "closed state rejects work")
        }
        do {
            let memory = Memory(), wire = try Wire(), state = try await connect(memory, wire)
            await wire.configure(drop: true); state.selectMedia("media-original"); state.generate(); await state.waitForIdle()
            try expect(!state.ready && state.records.last?.observation == nil, "lost response retains original")
            await wire.configure(state: "unknown"); let restored = try await connect(memory, wire)
            try expect(restored.ready && restored.pending && !restored.canGenerate, "restored unknown occupies budget")
            let key = restored.records.last!.id
            restored.requestDiscard(key); restored.cancelDiscard(); restored.confirmDiscard(); try expect(await wire.posts == 1, "cancel confirmation zero POST")
            restored.requestDiscard(key); restored.confirmDiscard(); await restored.waitForIdle()
            try expect(restored.records.last?.status == "discarded", "explicit discard")
            try expect(await wire.posts == 2, "one creation and one discard")
        }
        do {
            let memory = Memory(), wire = try Wire(), state = try await connect(memory, wire)
            await wire.configure(hold: true); state.selectMedia("media-original"); state.generate()
            for _ in 0..<1000 { if await wire.waiting { break }; try await Task.sleep(for: .milliseconds(1)) }
            try expect(await wire.waiting, "response entered")
            state.pause(); await wire.configure(state: "succeeded"); await wire.resume(); await state.waitForIdle()
            try expect(state.outputs.isEmpty && !state.ready, "late response cannot update paused UI")
            state.refresh(); await state.waitForIdle(); try expect(state.ready, "original metadata resumes")
            try expect(await wire.posts == 1, "late recovery only GET")
        }
        for cancel in [false, true] {
            let memory = Memory(), wire = try Wire(), state = try await connect(memory, wire)
            await memory.configure(fail: !cancel, hold: cancel); state.selectMedia("media-original"); state.generate()
            if cancel {
                for _ in 0..<1000 { if await memory.saves > 0 { break }; try await Task.sleep(for: .milliseconds(1)) }
                try expect(await memory.saves > 0, "original save entered"); state.pause()
            }
            await state.waitForIdle(); await memory.configure(); try expect(await wire.posts == 0, "save failure or cancellation zero POST")
            if cancel { state.refresh(); await state.waitForIdle(); try expect(state.ready && state.pending, "same client reconciles exact saved original") }
        }
        do {
            let memory = Memory(), wire = try Wire(), state = try await connect(memory, wire)
            state.selectMedia("media-original"); state.generate(); await state.waitForIdle(); let count = state.records.count
            await wire.configure(status: 500); state.refresh(); await state.waitForIdle(); try expect(!state.ready && state.records.count == count, "read failure preserves observations")
            await wire.configure(status: 401); state.refresh(); await state.waitForIdle(); try expect(auth == 1 && state.outputs.isEmpty, "401 clears text and reaches auth handler")
        }
        do {
            let memory = Memory(), wire = try Wire(), state = try await connect(memory, wire)
            await wire.configure(state: "succeeded", outputSeconds: 0.25); state.selectMedia("media-original"); state.generate(); await state.waitForIdle()
            let key = state.records[0].id; try expect(state.text(for: key) != nil, "short TTL output visible")
            try await Task.sleep(for: .milliseconds(300)); state.poll(); try expect(state.outputs.isEmpty && state.text(for: key) == nil, "expired text evicted")
        }
        do {
            let memory = Memory(), wire = try Wire(), state = try await connect(memory, wire)
            await wire.configure(state: "succeeded"); state.selectMedia("media-original"); state.generate(); await state.waitForIdle()
            await wire.configure(state: "succeeded", sourceAvailable: false); state.refresh(); await state.waitForIdle()
            try expect(state.sources.isEmpty && state.selectedMedia.isEmpty && state.outputs.isEmpty && !state.canGenerate, "unavailable source clears selection and text")
            state.recover(state.records[0].id); await state.waitForIdle(); try expect(state.outputs.isEmpty, "source unavailable blocks stale plaintext even on explicit query")
        }
        print("{\"transcription_state_contract_groups\":8}")
    }
    @MainActor static func live() async throws {
        let env = ProcessInfo.processInfo.environment, phase = env["LIMEIOT_TRANSCRIPTION_PHASE"]!, space = "space-demo"
        let vault = FileStore(env["LIMEIOT_TRANSCRIPTION_STORE"]!), wire = LiveWire(drop: phase == "create")
        let gateway = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, transport: wire, allowLoopbackHTTP: true); try await gateway.login(token: env["LIMEIOT_TOKEN"]!)
        let state = TranscriptionStore(client: TranscriptionClient(gateway: gateway, store: vault), media: MediaClient(gateway: gateway, store: vault), space: space, authFailure: { _ in })
        state.refresh(); await state.waitForIdle(); try expect(state.ready && state.outputs.isEmpty, "fresh process restores metadata only")
        let source = env["LIMEIOT_TRANSCRIPTION_MEDIA"]!
        if phase == "create" {
            state.selectMedia(source); state.generate(); await state.waitForIdle()
            try expect(!state.ready && state.records.count == 1 && state.records[0].observation == nil, "lost actual create response preserves unresolved intent")
            state.recover(state.records[0].id); await state.waitForIdle()
            for _ in 0..<100 { if state.records[0].status == "succeeded" { break }; try await Task.sleep(for: .milliseconds(50)); state.poll(); await state.waitForIdle() }
            try expect(state.text(for: state.records[0].id) == "你好，这是本地识别结果。", "actual result text matches provider")
            state.pause(); try expect(state.outputs.isEmpty, "background clears actual text")
            state.refresh(); await state.waitForIdle(); try expect(state.outputs.isEmpty, "foreground no completed text fetch")
        } else if phase == "restore" {
            try expect(state.records.count == 1 && state.records[0].status == "succeeded", "process and gateway original restored")
            state.recover(state.records[0].id); await state.waitForIdle(); try expect(state.text(for: state.records[0].id) == "你好，这是本地识别结果。", "explicit GET restores original output")
        } else if phase == "unknown-start" {
            state.selectMedia(source); state.generate(); await state.waitForIdle()
            try expect(state.records.count == 2 && state.records.last?.status == "running" && !state.canGenerate, "inflight original saved")
        } else if phase == "unknown-restore" {
            try expect(state.records.count == 2 && state.records.last?.status == "unknown" && state.pending, "restart keeps unknown budget")
            state.selectMedia(source); state.generate(); try expect(await wire.posts == 0, "unknown blocks replacement")
            let key = state.records.last!.id; state.requestDiscard(key); state.cancelDiscard(); state.confirmDiscard(); try expect(await wire.posts == 0, "cancel confirmation zero POST")
            state.requestDiscard(key); state.confirmDiscard(); await state.waitForIdle(); try expect(state.records.last?.status == "discarded" && state.outputs.isEmpty, "explicit discard no plaintext")
        } else if phase == "cleared" {
            try expect(state.sources.isEmpty, "deleted source unavailable")
            state.recover(state.records[0].id); await state.waitForIdle(); try expect(state.records[0].status == "succeeded" && state.outputs.isEmpty, "source deletion clears original output")
        } else { throw Failure.check("invalid phase") }
        let posts = await wire.posts, otherPosts = await wire.otherPosts
        try expect(posts == (["create", "unknown-start", "unknown-restore"].contains(phase) ? 1 : 0) && otherPosts == 0, "explicit POST budget without other effects")
        let trace: JSONValue = .object(["passed": .bool(true), "phase": .string(phase), "host_ui_state": .bool(true), "transcription_posts": .integer(posts), "other_posts": .integer(otherPosts), "records": .array(state.records.map { .object(["original": $0.original, "observation": $0.observation ?? .null, "discard_intents": .array($0.discardIntents.map(JSONValue.string))]) })])
        try Data(OtaJSON.canonical(trace).utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_TRANSCRIPTION_TRACE"]!)); state.close(); try expect(state.outputs.isEmpty, "close clears live output")
    }
    @MainActor static func main() async throws {
        if ProcessInfo.processInfo.environment["LIMEIOT_TRANSCRIPTION_STATE_CHECK"] == "1" { try await live() } else { try await contracts() }
    }
}
