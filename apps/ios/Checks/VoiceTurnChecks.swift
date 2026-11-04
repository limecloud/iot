import Foundation
import LimeIoTKit

private enum Failure: Error { case check(String), lost, storage }
private func object(_ v: JSONValue?) -> [String: JSONValue] { if case .object(let o) = v { o } else { [:] } }
private func string(_ v: JSONValue?) -> String { if case .string(let s) = v { s } else { "" } }
private func expect(_ condition: Bool, _ name: String) throws { if !condition { throw Failure.check(name) } }
private func replace(_ v: JSONValue, _ path: [String], _ next: JSONValue) -> JSONValue {
    guard let first = path.first else { return next }; var o = object(v); o[first] = replace(o[first] ?? .null, Array(path.dropFirst()), next); return .object(o)
}
private func fixture() throws -> [String: JSONValue] {
    let path = ProcessInfo.processInfo.environment["LIMEIOT_VOICE_TURN_FIXTURE"]!
    return object(try OtaJSON.parse(String(contentsOfFile: path, encoding: .utf8), response: true))
}
private func clock(_ f: [String: JSONValue]) -> Date { if case .integer(let ms) = f["now"] { Date(timeIntervalSince1970: Double(ms) / 1000) } else { .distantPast } }
private actor Memory: SessionStore {
    var data: Data?, saves = 0, failAt = 0, readback = false, holdAt = 0
    func configure(failAt: Int = 0, readback: Bool = false, holdAt: Int = 0) { self.failAt = failAt; self.readback = readback; self.holdAt = holdAt }
    func seed(_ value: JSONValue) { data = Data(OtaJSON.canonical(value).utf8); saves = 0 }
    func load(origin: String) -> Data? { readback && saves > 0 ? nil : data }
    func save(origin: String, data: Data?) async throws {
        saves += 1; if saves == failAt { throw Failure.storage }; self.data = data
        if saves == holdAt { try await Task.sleep(for: .seconds(30)) }
    }
    func raw() -> String { data.map { String(decoding: $0, as: UTF8.self) } ?? "" }
}
private actor Wire: HTTPTransport {
    let fixture: [String: JSONValue], memory: Memory
    var tasks: [String: JSONValue], posts: [String] = [], cleared = false, drop = false, missing = false, changed = false, sourceMissing = false
    init(_ f: [String: JSONValue], _ memory: Memory) { fixture = f; self.memory = memory; tasks = object(f["tasks"]) }
    func configure(drop: Bool = false, missing: Bool = false, changed: Bool = false, sourceMissing: Bool = false) { self.drop = drop; self.missing = missing; self.changed = changed; self.sourceMissing = sourceMissing }
    func setTask(_ kind: String, _ task: JSONValue) { tasks[kind] = task }
    func restoreText() { cleared = false }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        func response(_ value: JSONValue, code: Int = 200, headers: [String: String]? = nil) -> (Data, HTTPURLResponse) { (Data(OtaJSON.canonical(value).utf8), HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: headers)!) }
        if path.hasSuffix("/auth/session") { return response(.object(["authenticated": .bool(true), "csrf_token": .string("csrf"), "expires_at": .string("2030-01-01T00:00:00Z")]), headers: ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"]) }
        if path.hasSuffix("/capabilities") { return response(changed ? replace(fixture["capabilities"]!, ["text", "deployment", "revision"], .string("sha256:" + String(repeating: "a", count: 64))) : fixture["capabilities"]!) }
        if path.hasSuffix("/media") { return response(sourceMissing ? replace(fixture["media"]!, ["items"], .array([])) : fixture["media"]!) }
        guard let kind = ["transcription", "text", "speech"].first(where: { path.contains(["transcription": "audio-transcriptions", "text": "text-generations", "speech": "speech-syntheses"][$0]!) }) else { throw Failure.check("unexpected effect: " + path) }
        if request.httpMethod == "POST" {
            let raw = await memory.raw(), saved = object(try OtaJSON.parse(raw, response: true)), entry = object(object(saved["jobs"])[kind])
            try expect(!raw.contains("我想搭") && !raw.contains("稳固的底座"), "no plaintext persisted")
            try expect(entry["original"] == object(object(fixture["succeeded"])["jobs"])[kind].map { object($0)["original"]! }, "original durable before POST")
            if path.hasSuffix("/discard") { try expect(saved["stopped"] == .bool(true) && entry["discard_attempted"] == .bool(true), "stop fact and intent durable"); cleared = true }
            posts.append(path.hasSuffix("/discard") ? "discard" : kind)
            if drop { throw Failure.lost }
        }
        if missing { return response(.object(["error": .object(["code": .string("transcription_not_found")])]), code: 404) }
        return response(cleared && kind == "text" ? fixture["cleared_text"]! : tasks[kind]!)
    }
}
private func client(_ f: [String: JSONValue], _ memory: Memory, _ wire: Wire) async throws -> VoiceTurnClient {
    let g = try GatewayClient(endpoint: "https://nas.local", transport: wire); try await g.login(token: "fixture")
    let now = clock(f); return try VoiceTurnClient(gateway: g, store: memory, space: "space-demo", now: { now })
}
private func fail(_ expected: String? = nil, _ work: () async throws -> Void) async throws {
    do { try await work() } catch is Failure { throw Failure.check("fixture failed unexpectedly") } catch { if let expected { try expect((error as? VoiceTurnError)?.code == expected, "expected exact error " + expected) }; return }
    throw Failure.check("invalid transition accepted")
}

@main enum VoiceTurnChecks {
    static func contracts(_ f: [String: JSONValue]) async throws {
        let input = f["input"]!
        do {
            let m = Memory(), w = Wire(f, m), c = try await client(f, m, w)
            let v = try await c.start(input: input)
            try expect(v.phase == "succeeded" && v.record.document == f["succeeded"], "JS/Swift final ledger and checksums equal")
            try expect(await w.posts == ["transcription", "text", "speech"], "exact stage POST budget")
            let restored = try await client(f, m, w); _ = try await restored.resolve()
            try expect(await w.posts.count == 3, "new instance GET only")
            await w.configure(drop: true); do { _ = try await c.stopTurn() } catch Failure.lost {}
            await w.configure(); _ = try await c.stopTurn()
            try expect(await w.posts == ["transcription", "text", "speech", "discard"], "lost discard receipt never resubmitted")
            try expect(try await c.record()?.document == f["stopped"], "JS/Swift stopped ledger equal")
            await w.restoreText(); try await fail { _ = try await c.resolve() }
        }
        for readback in [false, true] {
            let m = Memory(), w = Wire(f, m); await m.configure(failAt: readback ? 0 : 1, readback: readback)
            let c = try await client(f, m, w); try await fail { _ = try await c.start(input: input) }
            try expect(await w.posts.isEmpty, "storage failure has zero POST")
        }
        do {
            let m = Memory(), w = Wire(f, m); await m.configure(holdAt: 2); let c = try await client(f, m, w)
            let task = Task { try await c.start(input: input) }
            for _ in 0..<1000 { if await m.saves >= 2 { break }; try await Task.sleep(for: .milliseconds(2)) }
            try expect(await m.saves == 2, "reached durable prepared stage"); task.cancel(); _ = try? await task.value
            try expect(await w.posts.isEmpty, "cancellation after save has zero POST")
        }
        do {
            let m = Memory(), w = Wire(f, m), c = try await client(f, m, w); await w.configure(drop: true)
            do { _ = try await c.start(input: input) } catch Failure.lost {}
            await w.configure(missing: true); try await fail { _ = try await c.resolve() }
            try await fail { _ = try await c.start(input: input) }
            await w.configure(); let v = try await c.resolve(); try expect(v.phase == "ready", "lost receipt resolves original only")
            try expect(await w.posts == ["transcription"], "404 and resolve no POST")
        }
        do {
            let m = Memory(), w = Wire(f, m); await m.seed(f["prepared"]!); let c = try await client(f, m, w)
            var unknown = object(object(f["tasks"])["transcription"]); unknown["status"] = .string("unknown"); unknown["error_code"] = .string("transcription_interrupted"); unknown["output"] = .null
            await w.setTask("transcription", .object(unknown)); try expect(try await c.resolve().phase == "unknown", "unknown occupied")
            try expect(try await c.continueTurn().phase == "unknown", "unknown cannot advance")
            await w.setTask("transcription", object(f["tasks"])["transcription"]!); try await fail { _ = try await c.resolve() }
            try expect(await w.posts.isEmpty, "unknown no effects")
        }
        for field in ["identity", "usage", "configuration", "source"] {
            let m = Memory(), w = Wire(f, m); await m.seed(field == "configuration" || field == "source" ? f["ready"]! : f["succeeded"]!); let c = try await client(f, m, w)
            if field == "identity" { await w.setTask("text", replace(object(f["tasks"])["text"]!, ["text_id"], .string("text-drift"))) }
            if field == "usage" { await w.setTask("text", replace(object(f["tasks"])["text"]!, ["usage", "output_tokens"], .integer(999))) }
            await w.configure(changed: field == "configuration", sourceMissing: field == "source")
            try await fail(field == "configuration" ? "voice_turn_configuration_changed" : field == "source" ? "voice_turn_source_unavailable" : "invalid_voice_turn_response") { if field == "configuration" || field == "source" { _ = try await c.continueTurn() } else { _ = try await c.resolve() } }
            try expect(await w.posts.isEmpty, "drift refuses effects")
        }
        do {
            let raw = OtaJSON.canonical(f["succeeded"]!)
            _ = try VoiceTurnRecord.parse(raw, origin: "https://nas.local", space: "space-demo")
            do { _ = try VoiceTurnRecord.parse(raw, origin: "https://other.local", space: "space-demo"); throw Failure.check("origin drift accepted") } catch is VoiceTurnError {}
            do { _ = try VoiceTurnRecord.parse(raw.replacingOccurrences(of: "native-shared", with: "tampered"), origin: "https://nas.local", space: "space-demo"); throw Failure.check("checksum tampering accepted") } catch is VoiceTurnError {}
        }
    }
    @MainActor static func state(_ f: [String: JSONValue]) async throws {
        let m = Memory(), w = Wire(f, m); await m.seed(f["ready"]!); let c = try await client(f, m, w), now = clock(f)
        let s = VoiceTurnStore(client: c, space: "space-demo", authFailure: { _ in }, now: { now })
        s.refresh(); await s.waitForIdle(); try expect(s.ready && s.canContinue && s.visible?.transcript == nil, "restore hides text and requires continue")
        s.poll(); await s.waitForIdle(); try expect(await w.posts.isEmpty, "restore no automatic advance")
        s.continueTurn(); await s.waitForIdle(); try expect(s.visible?.answer != nil && s.visible?.mediaID != nil, "explicit continue completes")
        try expect(await w.posts == ["text", "speech"], "no grants or commands")
        s.requestStop(); s.cancelStop(); s.confirmStop(); try expect(await w.posts.count == 2, "cancel stop zero effects")
        s.pause(); try expect(s.visible == nil && !s.ready && s.selectedMedia.isEmpty, "background clears body and source")
        s.refresh(); await s.waitForIdle(); let restoredPosts = await w.posts.count; try expect(s.visible?.answer == nil && restoredPosts == 2, "return reads summary only")
        s.recover(); await s.waitForIdle(); try expect(s.visible?.answer != nil, "explicit query displays text")
        s.requestStop(); s.confirmStop(); await s.waitForIdle(); try expect(s.view?.phase == "stopped" && s.visible == nil, "explicit stop hides output")
        s.setOnline(false); s.recover(); await s.waitForIdle(); try expect(await w.posts.count == 3, "offline no effects")
        s.close(); s.setOnline(true); s.refresh(); await s.waitForIdle(); try expect(!s.ready, "closed cannot resume")
    }
    static func main() async throws {
        if ProcessInfo.processInfo.environment["LIMEIOT_VOICE_NATIVE_PHASE"] != nil { try await voiceTurnLiveChecks(); return }
        let f = try fixture(); try await contracts(f); try await state(f); print("{\"voice_turn_sdk_and_state\":\"passed\",\"shared_js_ledger\":true}")
    }
}
