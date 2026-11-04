import Foundation
import LimeIoTKit

private enum Failure: Error { case check(String), lost, storage }
private func obj(_ value: JSONValue?) -> [String: JSONValue] { if case .object(let o) = value { o } else { [:] } }
private func str(_ value: JSONValue?) -> String { if case .string(let s) = value { s } else { "" } }
private func expect(_ condition: Bool, _ name: String) throws { if !condition { throw Failure.check(name) } }
private func slots(_ value: JSONValue?) -> [JSONValue] { if case .array(let a) = obj(value)["turns"] { a } else { [] } }
private func firstMedia(_ f: [String: JSONValue]) -> String { str(obj(slots(f["prepared_slot"]).first)["media_id"]) }
private func date(_ f: [String: JSONValue]) -> Date { if case .integer(let n) = f["now"] { Date(timeIntervalSince1970: Double(n) / 1000) } else { .distantPast } }
private func history(_ f: [String: JSONValue]) -> [TextGenerationMessage] {
    let tasks = obj(obj(f["tasks"])["1"])
    return [.init(role: "user", content: str(obj(obj(tasks["transcription"])["output"])["text"])), .init(role: "assistant", content: str(obj(obj(tasks["text"])["output"])["text"]))]
}
private actor Memory: SessionStore {
    var data: Data?, saves = 0, failAt = 0, holdAt = 0, readback = false
    func configure(failAt: Int = 0, holdAt: Int = 0, readback: Bool = false) { self.failAt = failAt; self.holdAt = holdAt; self.readback = readback }
    func seed(_ value: JSONValue) { data = Data(OtaJSON.canonical(value).utf8); saves = 0 }
    func load(origin: String) -> Data? { readback && saves > 0 ? nil : data }
    func save(origin: String, data: Data?) async throws {
        try expect(origin == "https://nas.local#companion:space-demo", "separate companion storage key")
        saves += 1; if saves == failAt { throw Failure.storage }; self.data = data
        if saves == holdAt { try await Task.sleep(for: .seconds(30)) }
    }
    func raw() -> String { data.map { String(decoding: $0, as: UTF8.self) } ?? "" }
}
private actor Wire: HTTPTransport {
    let f: [String: JSONValue], memory: Memory
    var posts: [String] = [], cleared = Set<String>(), drop = false, changed = false, unknown = false
    var holdText = false, entered = false
    private var release: CheckedContinuation<Void, Never>?
    init(_ f: [String: JSONValue], _ memory: Memory) { self.f = f; self.memory = memory }
    func configure(drop: Bool = false, changed: Bool = false, unknown: Bool = false) { self.drop = drop; self.changed = changed; self.unknown = unknown }
    func hold() { holdText = true }
    func resume() { holdText = false; release?.resume(); release = nil }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        func response(_ value: JSONValue, headers: [String: String]? = nil) -> (Data, HTTPURLResponse) { (Data(OtaJSON.canonical(value).utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: headers)!) }
        if path.hasSuffix("/auth/session") { return response(.object(["authenticated": .bool(true), "csrf_token": .string("csrf"), "expires_at": .string("2030-01-01T00:00:00Z")]), headers: ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"]) }
        if path.hasSuffix("/capabilities") {
            var caps = obj(f["capabilities"]), text = obj(caps["text"]), deployment = obj(text["deployment"])
            if changed { deployment["revision"] = .string("sha256:" + String(repeating: "a", count: 64)); text["deployment"] = .object(deployment); caps["text"] = .object(text) }
            return response(.object(caps))
        }
        if path.hasSuffix("/media") { return response(f["media"]!) }
        guard let kind = ["transcription", "text", "speech"].first(where: { path.contains(["transcription": "audio-transcriptions", "text": "text-generations", "speech": "speech-syntheses"][$0]!) }) else { throw Failure.check("unexpected endpoint " + path) }
        let key = request.value(forHTTPHeaderField: "Idempotency-Key") ?? path.components(separatedBy: "/by-key/").last!, index = key.contains("_t2-") ? 2 : 1
        if request.httpMethod == "POST" {
            let raw = await memory.raw(), record = try OtaJSON.parse(raw, response: true), nested = obj(obj(slots(record)[index - 1])["record"]), job = obj(obj(nested["jobs"])[kind])
            for text in history(f).map(\.content) + [str(obj(f["policy"])["instructions"])] { try expect(!raw.contains(text), "summary only") }
            let expected = obj(obj(slots(f["second"])[index - 1])["record"])
            try expect(job["original"] == obj(expected["jobs"])[kind].map { obj($0)["original"]! }, "original durable before POST")
            if path.hasSuffix("/discard") { try expect(obj(record)["stopped"] == .bool(true) && nested["stopped"] == .bool(true) && job["discard_attempted"] == .bool(true), "stop and discard intent durable"); cleared.insert(String(index)) }
            else if kind == "text" {
                let input = obj(try OtaJSON.parse(String(decoding: request.httpBody!, as: UTF8.self)))
                let expectedHistory = index == 1 ? [] : history(f)
                let messages = expectedHistory + [history(f)[0]]
                try expect(input["instructions"] == obj(f["policy"])["instructions"] && input["messages"] == .array(messages.map { .object(["role": .string($0.role), "content": .string($0.content)]) }), "role and second round history sent")
            }
            posts.append(path.hasSuffix("/discard") ? "discard\(index)" : kind)
            if holdText && kind == "text" { entered = true; await withCheckedContinuation { release = $0 } }
            if drop { throw Failure.lost }
        }
        var task = obj(obj(obj(f["tasks"])[String(index)])[kind])
        if unknown && kind == "transcription" { task["status"] = .string("unknown"); task["error_code"] = .string("transcription_interrupted"); task["output"] = .null }
        return response(cleared.contains(String(index)) && kind == "text" ? obj(f["cleared"])[String(index)]! : .object(task))
    }
}
private func client(_ f: [String: JSONValue], _ memory: Memory, _ wire: Wire, policy: JSONValue? = nil, withPolicy: Bool = true, history: [TextGenerationMessage]? = nil, at: Date? = nil) async throws -> CompanionClient {
    let gateway = try GatewayClient(endpoint: "https://nas.local", transport: wire); try await gateway.login(token: "fixture"); let now = at ?? date(f)
    return try CompanionClient(gateway: gateway, store: memory, space: "space-demo", policy: withPolicy ? CompanionPolicy.parse(OtaJSON.canonical(policy ?? f["policy"]!)) : nil, history: history, now: { now })
}
@MainActor private func fail(_ code: String? = nil, _ work: @MainActor () async throws -> Void) async throws {
    do { try await work() } catch let error as CompanionError { if let code { try expect(error.code == code, "expected " + code + ", received " + error.code) }; return }
    catch let error as VoiceTurnError { if let code { try expect(error.code == code, "expected " + code + ", received " + error.code) }; return }
    throw Failure.check("invalid transition accepted")
}
@main enum CompanionChecks {
    static func main() async throws {
        if ProcessInfo.processInfo.environment["LIMEIOT_COMPANION_NATIVE_PHASE"] != nil { try await companionLiveChecks(); return }
        let path = ProcessInfo.processInfo.environment["LIMEIOT_COMPANION_FIXTURE"]!, f = obj(try OtaJSON.parse(String(contentsOfFile: path, encoding: .utf8), response: true)), mediaID = firstMedia(f)
        do {
            let m = Memory(), w = Wire(f, m), c = try await client(f, m, w)
            try expect(try await c.start(sessionID: "native-companion").record.document == f["started"], "JS/Swift start exact")
            try expect(await w.posts.isEmpty, "start zero inference")
            let first = try await c.reply(mediaID: mediaID); try expect(first.record.document == f["first"] && first.canReply, "JS/Swift first exact")
            let second = try await c.reply(mediaID: mediaID); try expect(second.record.document == f["second"] && !second.canReply && second.turnsRemaining == 0, "JS/Swift second exact")
            try await fail("companion_turn_budget_exceeded") { _ = try await c.reply(mediaID: mediaID) }
            let reader = try await client(f, m, w, withPolicy: false); let read = try await reader.resolve()
            let count = await w.posts.count; try expect(!read.historyAvailable && count == 6, "restart GET only")
            let stopped = try await reader.stop(); try expect(stopped.stopSettled && stopped.turn == nil && stopped.record.document == f["stopped"], "both answers cleared with no context")
            try expect(await w.posts == ["transcription", "text", "speech", "transcription", "text", "speech", "discard1", "discard2"], "exact POST budget")
            let policy = try CompanionPolicy.parse(OtaJSON.canonical(f["policy"]!))
            _ = try await reader.start(sessionID: "new-session", policy: policy); _ = try await reader.stop()
            try await fail("companion_session_id_unavailable") { _ = try await reader.start(sessionID: "native-companion", policy: policy) }
        }
        print("PASS companion shared ledger, two turns, GET recovery, stop and ID budget")
        for n in [1, 2, 3] {
            let m = Memory(), w = Wire(f, m), c = try await client(f, m, w); await m.configure(failAt: n)
            if n == 1 { try await fail { _ = try await c.start(sessionID: "native-companion") } }
            else { _ = try await c.start(sessionID: "native-companion"); try await fail { _ = try await c.reply(mediaID: mediaID) } }
            try expect(await w.posts.isEmpty, "save failure zero POST")
        }
        do {
            let m = Memory(), w = Wire(f, m), c = try await client(f, m, w); _ = try await c.start(sessionID: "native-companion"); await m.configure(holdAt: 2)
            let work = Task { try await c.reply(mediaID: mediaID) }
            for _ in 0..<1000 { if await m.saves == 2 { break }; try await Task.sleep(for: .milliseconds(2)) }
            try expect(await m.saves == 2, "reached saved slot"); work.cancel(); _ = try? await work.value
            let restored = try await client(f, m, w, history: []); try expect(try await restored.resolve().phase == "prepared", "prepared slot preserved")
            try await fail("companion_preparation_incomplete") { _ = try await restored.continueSession() }; try await fail("companion_turn_pending") { _ = try await restored.reply(mediaID: mediaID) }
            let stopped = try await restored.stop(), zeroPosts = await w.posts.isEmpty; try expect(stopped.stopSettled && zeroPosts, "prepared stop has zero POST")
        }
        print("PASS companion persistence failures and saved-slot cancellation")
        for mode in ["history", "policy", "configuration", "expiry"] {
            let m = Memory(), w = Wire(f, m); await m.seed(f["first"]!); var policy = obj(f["policy"])
            if mode == "policy" { policy["instructions"] = .string("另一个角色") }; if mode == "configuration" { await w.configure(changed: true) }
            let c = try await client(f, m, w, policy: .object(policy), history: mode == "history" ? nil : history(f), at: mode == "expiry" ? date(f).addingTimeInterval(300) : nil)
            try await fail(["history": "companion_history_unavailable", "policy": "companion_policy_changed", "configuration": "companion_configuration_changed", "expiry": "companion_expired"][mode]) { _ = try await c.reply(mediaID: mediaID) }
            try expect(await w.posts.isEmpty, "drift blocks inference")
        }
        print("PASS companion policy, history, model and expiry guards")
        do {
            let m = Memory(), w = Wire(f, m), c = try await client(f, m, w); _ = try await c.start(sessionID: "native-companion"); await w.configure(drop: true)
            do { _ = try await c.reply(mediaID: mediaID); throw Failure.check("lost receipt accepted") } catch Failure.lost {}
            await w.configure(); let resolved = try await c.resolve(), originalPosts = await w.posts; try expect(resolved.phase == "ready" && originalPosts == ["transcription"], "lost receipt GET original")
            try expect(try await c.continueSession().record.document == f["first"], "explicit original continuation")
            let n = Memory(), x = Wire(f, n); await n.seed(f["prepared"]!); await x.configure(unknown: true); let d = try await client(f, n, x, history: [])
            let unknown = try await d.resolve(), continued = try await d.continueSession(); try expect(unknown.phase == "unknown" && continued.phase == "unknown", "unknown stays original")
            try await fail("companion_turn_pending") { _ = try await d.reply(mediaID: mediaID) }; try await fail("companion_session_pending") { _ = try await d.start(sessionID: "replacement") }
            try expect(await x.posts.isEmpty, "unknown never replaced")
        }
        print("PASS companion lost response and unknown original-key recovery")
        do {
            try await fail("companion_record_unavailable") { _ = try CompanionRecord.parse(OtaJSON.canonical(f["second"]!), origin: "https://other.local", space: "space-demo") }
            var altered = obj(f["second"]); altered["stopped"] = .bool(true)
            try await fail("companion_record_unavailable") { _ = try CompanionRecord.parse(OtaJSON.canonical(.object(altered)), origin: "https://nas.local", space: "space-demo") }
            try await fail("companion_record_unavailable") { _ = try CompanionRecord.parse("{\"version\":1," + OtaJSON.canonical(f["second"]!).dropFirst(), origin: "https://nas.local", space: "space-demo") }
            let nested = obj(slots(f["second"])[0])["record"]!
            try await fail("voice_turn_record_unavailable") { _ = try VoiceTurnRecord.parse(OtaJSON.canonical(nested), origin: "https://nas.local", space: "space-demo") }
            _ = try VoiceTurnRecord.parse(OtaJSON.canonical(nested), origin: "https://nas.local", space: "space-demo", contextual: true)
            for patch in ["max_turns": JSONValue.integer(9), "max_seconds": .integer(29), "instructions": .string("")] {
                var policy = obj(f["policy"]); policy[patch.key] = patch.value
                try await fail("invalid_companion_policy") { _ = try CompanionPolicy.parse(OtaJSON.canonical(.object(policy))) }
            }
            var blankPolicy = obj(f["policy"]); blankPolicy["instructions"] = .string("\u{FEFF}")
            try await fail("invalid_companion_policy") { _ = try CompanionPolicy.parse(OtaJSON.canonical(.object(blankPolicy))) }
        }
        print("PASS companion strict policy and v1 isolation")
        try await stateChecks(f)
    }
    @MainActor static func stateChecks(_ f: [String: JSONValue]) async throws {
        do {
            let m = Memory(), w = Wire(f, m); await m.seed(f["ready"]!); let c = try await client(f, m, w, history: []), now = date(f)
            let s = CompanionStore(client: c, space: "space-demo", authFailure: { _ in }, now: { now })
            s.refresh(); await s.waitForIdle(); try expect(s.canContinue && s.visible?.answer == nil, "state reads original without advancing")
            s.poll(); await s.waitForIdle(); try expect(await w.posts.isEmpty, "refresh and poll zero inference")
            s.continueSession(); await s.waitForIdle(); try expect(s.visible?.answer != nil && s.visible?.mediaID != nil, "state explicit text and speech")
            s.selectMedia(firstMedia(f)); s.reply(); await s.waitForIdle(); try expect(s.view?.turnsRemaining == 0 && !s.canReply, "state second turn consumes budget")
            s.pause(); try expect(s.visible == nil && !s.ready && s.selectedMedia.isEmpty, "pause clears output immediately")
            s.refresh(); await s.waitForIdle(); try expect(s.view?.historyAvailable == false && !s.canReply && !s.canContinue && s.visible?.answer == nil, "return only GET with no history")
            s.requestStop(); s.cancelStop(); s.confirmStop(); await s.waitForIdle(); try expect(await w.posts == ["text", "speech", "transcription", "text", "speech"], "unconfirmed stop no effect")
            s.recover(); await s.waitForIdle(); try expect(s.visible?.answer != nil, "explicit query may show original output")
            s.requestStop(); s.confirmStop(); await s.waitForIdle(); try expect(s.view?.stopSettled == true && s.visible == nil, "stop without context clears both answers")
            s.setOnline(false); s.recover(); await s.waitForIdle(); try expect(await w.posts == ["text", "speech", "transcription", "text", "speech", "discard1", "discard2"], "offline zero effects")
            s.close(); s.setOnline(true); s.refresh(); await s.waitForIdle(); try expect(!s.ready, "closed store stays closed")
        }
        print("PASS companion native state, explicit continuation, pause, offline and stop")
        do {
            let m = Memory(), w = Wire(f, m); await m.seed(f["ready"]!); let c = try await client(f, m, w, history: []), now = date(f)
            let s = CompanionStore(client: c, space: "space-demo", authFailure: { _ in }, now: { now })
            s.refresh(); await s.waitForIdle(); await w.hold(); s.continueSession()
            for _ in 0..<1000 { if await w.entered { break }; try await Task.sleep(for: .milliseconds(2)) }
            try expect(await w.entered, "text request reached provider")
            s.pause(); await w.resume(); await s.waitForIdle(); try expect(s.visible == nil, "late receipt cannot restore output")
            try expect(await w.posts == ["text"], "late receipt cannot create speech")
            s.refresh(); await s.waitForIdle(); try expect(s.view?.historyAvailable == false && !s.canContinue && s.visible?.answer == nil, "return cannot restore context")
            s.poll(); await s.waitForIdle(); try expect(await w.posts == ["text"], "return stays GET only")
            s.close(); await s.waitForIdle()
        }
        print("PASS companion late response cannot revive context or start speech")
    }
}
