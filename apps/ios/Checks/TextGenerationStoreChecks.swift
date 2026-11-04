import Foundation
import CryptoKit
import LimeIoTKit

private enum Failure: Error { case check(String), lost, storage }
private func obj(_ value: JSONValue?) -> [String: JSONValue] { if case .object(let v) = value { v } else { [:] } }
@MainActor private func check(_ value: Bool, _ name: String) throws { if !value { throw Failure.check(name) } }
private func stamp(_ date: Date = Date()) -> String { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.string(from: date) }
private func date(_ value: JSONValue?) -> Date { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; if case .string(let s) = value { return f.date(from: s)! }; return .distantPast }
private func str(_ value: JSONValue?) -> String { if case .string(let s) = value { s } else { "" } }
private func hash(_ data: Data) -> String { "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
private func fixture() throws -> [String: JSONValue] { obj(try OtaJSON.parse(String(contentsOfFile: "tests/fixtures/text/contract.json", encoding: .utf8), response: true)) }
private actor Memory: SessionStore {
    var data: [String: Data] = [:], saves = 0, failAt = 0, loseReadback = false, hold = false
    func configure(failAt: Int = 0, loseReadback: Bool = false, hold: Bool = false) { self.failAt = failAt; self.loseReadback = loseReadback; self.hold = hold }
    func load(origin: String) -> Data? { loseReadback && saves > 0 ? nil : data[origin] }
    func save(origin: String, data: Data?) async throws { saves += 1; if saves == failAt { throw Failure.storage }; self.data[origin] = data; while hold { try await Task.sleep(for: .milliseconds(5)) } }
    func raw() -> String { data.values.map { String(decoding: $0, as: UTF8.self) }.joined() }
}
private actor Wire: HTTPTransport {
    let vector: [String: JSONValue], fixed: Bool, memory: Memory
    var tasks: [String: [String: JSONValue]] = [:], inputs: [JSONValue] = [], posts = 0, otherPosts = 0
    var state = "running", drop = false, missing = false, hold = false, waiting = false
    var release: CheckedContinuation<Void, Never>?
    init(_ memory: Memory, fixed: Bool = false) throws { self.memory = memory; self.fixed = fixed; vector = try fixture() }
    func configure(state: String = "running", drop: Bool = false, missing: Bool = false, hold: Bool = false) { self.state = state; self.drop = drop; self.missing = missing; self.hold = hold }
    func resume() { release?.resume(); release = nil }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        func response(_ value: JSONValue, code: Int = 200, headers: [String: String]? = nil) -> (Data, HTTPURLResponse) { (Data(OtaJSON.canonical(value).utf8), HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: headers)!) }
        func failure() -> (Data, HTTPURLResponse) { response(.object(["error": .object(["code": .string("text_not_found")])]), code: 404) }
        if path.hasSuffix("/auth/session") { return response(.object(["authenticated": .bool(true), "csrf_token": .string("csrf"), "expires_at": .string("2030-01-01T00:00:00Z")]), headers: ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"]) }
        if path.hasSuffix("/capabilities") { return response(.object(["text": vector["capabilities"]!])) }
        guard path.contains("/text-generations") else { if request.httpMethod == "POST" { otherPosts += 1 }; throw Failure.check("unexpected effect") }
        let discard = path.hasSuffix("/discard"), key = discard ? request.url!.deletingLastPathComponent().lastPathComponent : request.value(forHTTPHeaderField: "Idempotency-Key") ?? request.url!.lastPathComponent
        if request.httpMethod == "POST" {
            posts += 1
            guard !(await memory.raw()).isEmpty else { throw Failure.check("POST before durable original") }
            if discard {
                if fixed { state = state == "succeeded" ? "cleared" : "discarded" }
                else if var task = tasks[key] {
                    if task["status"] == .string("succeeded") { var out = obj(task["output"]); out["text"] = .null; out["cleared_at"] = .string(stamp()); task["output"] = .object(out) }
                    else { state = "discarded"; task["status"] = .string(state); task["updated_at"] = .string(stamp()); task["error_code"] = .string("text_output_discarded"); task["usage"] = .null; task["output"] = .null }
                    tasks[key] = task
                }
            } else {
                let input = try TextGenerationRequests.parse(String(decoding: request.httpBody!, as: UTF8.self)); inputs.append(input)
                let raw = obj(input); guard case .array(let messages) = raw["messages"] else { throw Failure.check("messages") }
                let bytes = messages.reduce(0) { $0 + str(obj($1)["content"]).utf8.count } + str(raw["instructions"]).utf8.count
                let summary: JSONValue = .object(["context_digest": .string(OtaJSON.digest(.object(["instructions": raw["instructions"]!, "messages": raw["messages"]!]))), "context_bytes": .integer(bytes), "message_count": .integer(messages.count), "retain_seconds": raw["retain_seconds"]!, "expires_at": raw["expires_at"]!])
                var task = obj(obj(vector["tasks"])["running"]); let created = stamp(); task["text_id"] = .string("text-" + key); task["idempotency_key"] = .string(key); task["input"] = summary; task["created_at"] = .string(created); task["updated_at"] = .string(created)
                task["request_digest"] = .string(OtaJSON.digest(.object(["space_id": .string("space-demo"), "idempotency_key": .string(key), "input": summary]))); tasks[key] = task
            }
            if hold { waiting = true; await withCheckedContinuation { release = $0 }; waiting = false }
            if drop { throw Failure.lost }
        }
        if missing { return failure() }
        if fixed {
            if case .string(let raw) = obj(vector["invalid_task_json"])[state] { return (Data(raw.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
            guard let task = obj(vector["tasks"])[state] ?? obj(vector["invalid_tasks"])[state] else { throw Failure.check("fixture state") }; return response(task)
        }
        guard var task = tasks[key] else { return failure() }
        if task["status"] != .string(state) {
            let updated = stamp(max(Date(), date(task["created_at"]).addingTimeInterval(0.001))); task["status"] = .string(state); task["updated_at"] = .string(updated)
            task["error_code"] = state == "unknown" ? .string("text_interrupted") : state == "discarded" ? .string("text_output_discarded") : .null
            if state == "succeeded" {
                let text = "回答🍋保留 é"; task["output"] = .object(["text": .string(text), "content_digest": .string(hash(Data(text.utf8))), "expires_at": .string(stamp(date(.string(updated)).addingTimeInterval(600))), "cleared_at": .null]); task["usage"] = .object(["input_tokens": .integer(42), "output_tokens": .integer(12)])
            } else { task["output"] = .null; task["usage"] = .null }; tasks[key] = task
        }
        return response(.object(task))
    }
}
@MainActor private func connect(_ memory: Memory, _ wire: Wire, now: @escaping () -> Date = Date.init) async throws -> TextGenerationStore {
    let gateway = try GatewayClient(endpoint: "https://nas.local", transport: wire); try await gateway.login(token: "owner-input")
    let store = TextGenerationStore(client: TextGenerationClient(gateway: gateway, store: memory), space: "space-demo", authFailure: { _ in }, now: now); store.refresh(); await store.waitForIdle(); try check(store.ready, store.message); return store
}
@main struct TextChecks {
    @MainActor static func contracts() async throws {
        do {
            let m = Memory(), w = try Wire(m); await w.configure(state: "succeeded"); let s = try await connect(m, w)
            s.setPrompt("原对话"); s.generate(); await s.waitForIdle(); try check(s.messages.count == 2, "prior conversation")
            try check(s.prepareQuestion("识别得到的新问题") && s.messages.isEmpty && s.prompt == "识别得到的新问题", "explicit handoff starts fresh")
            try check(await w.posts == 1, "handoff does not send")
            try check(!s.prepareQuestion(" ") && s.prompt == "识别得到的新问题", "bad handoff preserves draft")
            await w.configure(); s.generate(); await s.waitForIdle(); try check(!s.prepareQuestion("不能替换未决任务"), "pending refuses replacement")
            s.pause(); try check(!s.prepareQuestion("后台") && s.prompt.isEmpty, "background refuses handoff")
            s.setOnline(false); try check(!s.prepareQuestion("离线"), "offline refuses handoff"); s.close(); try check(!s.prepareQuestion("关闭"), "closed refuses handoff")
        }
        let v = try fixture(), input = v["input"]!
        try check(try TextGenerationRequests.parse(OtaJSON.canonical(input)) == v["normalized"], "Unicode and timezone")
        for (name, value) in obj(v["invalid_inputs"]) { do { _ = try TextGenerationRequests.parse(OtaJSON.canonical(value)); throw Failure.check("accepted " + name) } catch is TextGenerationError {} }
        for (name, value) in obj(v["invalid_input_json"]) { do { _ = try TextGenerationRequests.parse(str(value)); throw Failure.check("accepted " + name) } catch is TextGenerationError {} }
        for name in Array(obj(v["invalid_tasks"]).keys) + Array(obj(v["invalid_task_json"]).keys) + ["running", "succeeded"] {
            let m = Memory(), w = try Wire(m, fixed: true); await w.configure(state: name)
            let gateway = try GatewayClient(endpoint: "https://nas.local", transport: w); try await gateway.login(token: "fixture")
            let c = TextGenerationClient(gateway: gateway, store: m)
            if obj(v["invalid_tasks"])[name] != nil || obj(v["invalid_task_json"])[name] != nil { do { _ = try await c.submit(space: "space-demo", input: input, key: "original"); throw Failure.check("accepted " + name) } catch is TextGenerationError {} catch is GatewayError {} }
            else { let r = try await c.submit(space: "space-demo", input: input, key: "original"); try check(r.original == v["original"], "shared original"); _ = try await c.submit(space: "space-demo", input: input, key: "original"); try check(await w.posts == 1, "same key GET only") }
        }
        for readback in [false, true] {
            let m = Memory(), w = try Wire(m, fixed: true); await m.configure(failAt: readback ? 0 : 1, loseReadback: readback)
            let g = try GatewayClient(endpoint: "https://nas.local", transport: w); try await g.login(token: "fixture")
            do { _ = try await TextGenerationClient(gateway: g, store: m).submit(space: "space-demo", input: input, key: "original"); throw Failure.check("bad storage accepted") } catch is TextGenerationError {}
            try check(await w.posts == 0, "storage failure zero POST")
        }
        do {
            let m = Memory(), w = try Wire(m, fixed: true), g = try GatewayClient(endpoint: "https://nas.local", transport: w)
            try await g.login(token: "fixture"); let c = TextGenerationClient(gateway: g, store: m)
            _ = try await c.submit(space: "space-demo", input: input, key: "original")
            await w.configure(state: "succeeded"); _ = try await c.resolve(space: "space-demo", key: "original")
            await w.configure(state: "running"); do { _ = try await c.resolve(space: "space-demo", key: "original"); throw Failure.check("success regressed") } catch is TextGenerationError {}
            await w.configure(state: "succeeded"); _ = try await c.discard(space: "space-demo", key: "original")
            await w.configure(state: "succeeded"); do { _ = try await c.resolve(space: "space-demo", key: "original"); throw Failure.check("cleared text revived") } catch is TextGenerationError {}
        }
        do {
            let m = Memory(), w = try Wire(m, fixed: true), g = try GatewayClient(endpoint: "https://nas.local", transport: w)
            try await g.login(token: "fixture"); let c = TextGenerationClient(gateway: g, store: m)
            await w.configure(state: "unknown"); _ = try await c.submit(space: "space-demo", input: input, key: "original")
            await w.configure(state: "succeeded"); do { _ = try await c.resolve(space: "space-demo", key: "original"); throw Failure.check("unknown promoted") } catch is TextGenerationError {}
        }
        do {
            let m = Memory(), w = try Wire(m), s = try await connect(m, w); await m.configure(hold: true)
            s.setPrompt("取消保存"); s.generate()
            for _ in 0..<200 { if await m.saves > 0 { break }; try await Task.sleep(for: .milliseconds(5)) }
            try check(await m.saves > 0, "save entered"); s.pause(); await s.waitForIdle(); try check(await w.posts == 0, "cancel before POST")
        }
        do {
            let m = Memory(), w = try Wire(m); await w.configure(state: "succeeded"); let s = try await connect(m, w)
            s.setPrompt("第一条🍋 é"); s.generate(); await s.waitForIdle(); try check(s.messages.count == 2, "first turn: " + s.message)
            s.setPrompt("第二条"); s.generate(); await s.waitForIdle(); try check(s.messages.count == 4, "second turn")
            let sent = await w.inputs; let context = obj(sent[1])["messages"]
            try check(context == .array([.object(["role": .string("user"), "content": .string("第一条🍋 é")]), .object(["role": .string("assistant"), "content": .string("回答🍋保留 é")]), .object(["role": .string("user"), "content": .string("第二条")])]), "exact multi-turn context")
            let raw = await m.raw(); for secret in ["第一条", "回答🍋", "\"messages\"", "\"text\""] { try check(!raw.contains(secret), "no body persistence") }
            s.pause(); s.refresh(); await s.waitForIdle(); try check(s.messages.isEmpty && s.outputs.isEmpty, "foreground metadata only")
            s.recover(s.records[0].id); await s.waitForIdle(); try check(!s.outputs.isEmpty && s.messages.isEmpty, "explicit recover is not context")
            s.setOnline(false); try check(s.outputs.isEmpty && s.prompt.isEmpty, "offline clear"); s.close()
        }
        do {
            let m = Memory(), w = try Wire(m); let s = try await connect(m, w); await w.configure(drop: true)
            s.setPrompt("丢失消息"); s.generate(); await s.waitForIdle(); try check(s.pending && s.messages.isEmpty, "lost receipt budget")
            await w.configure(missing: true); s.recover(s.records[0].id); await s.waitForIdle(); let after404 = await w.posts; try check(s.pending && after404 == 1, "404 never resends")
            await w.configure(state: "unknown"); let restored = try await connect(m, w); try check(restored.pending && restored.outputs.isEmpty, "restored unknown")
            restored.setPrompt("不可替换"); restored.generate(); try check(await w.posts == 1, "unknown budget")
            let key = restored.records[0].id; restored.requestDiscard(key); restored.cancelDiscard(); restored.confirmDiscard(); try check(await w.posts == 1, "cancel zero POST")
            restored.requestDiscard(key); restored.confirmDiscard(); await restored.waitForIdle(); let abandonedPosts = await w.posts; try check(restored.records[0].status == "discarded" && abandonedPosts == 2, "explicit abandon")
        }
        do {
            let m = Memory(), w = try Wire(m); let s = try await connect(m, w); await w.configure(hold: true)
            s.setPrompt("迟到消息"); s.generate(); for _ in 0..<200 { if await w.waiting { break }; try await Task.sleep(for: .milliseconds(5)) }; try check(await w.waiting, "held provider")
            s.pause(); await w.configure(state: "succeeded"); await w.resume(); await s.waitForIdle(); try check(s.messages.isEmpty && s.outputs.isEmpty, "late response cannot revive")
            s.refresh(); await s.waitForIdle(); try check(s.outputs.isEmpty && s.messages.isEmpty, "new foreground metadata only")
            s.setPrompt("新上下文"); s.generate(); await s.waitForIdle(); let sent = await w.inputs; try check(obj(sent.last)["messages"] == .array([.object(["role": .string("user"), "content": .string("新上下文")])]), "old context excluded")
        }
        do {
            let m = Memory(), w = try Wire(m); await w.configure(state: "succeeded"); var clock = Date(); let s = try await connect(m, w, now: { clock })
            s.setPrompt("期限"); s.generate(); await s.waitForIdle(); let key = s.records[0].id
            s.requestDiscard(key); s.cancelDiscard(); s.confirmDiscard(); try check(await w.posts == 1, "cancel success clear")
            s.requestDiscard(key); s.confirmDiscard(); await s.waitForIdle(); try check(s.outputs.isEmpty && s.messages.isEmpty && s.records[0].status == "succeeded" && !s.records[0].canDiscard, "clear preserves identity")
            s.setPrompt("下一轮"); s.generate(); await s.waitForIdle(); clock = Date().addingTimeInterval(601); s.poll(); try check(s.messages.isEmpty && s.outputs.isEmpty, "TTL clears context")
        }
        print("{\"text_native_shared_contract\":true,\"text_native_state_groups\":10}")
    }
    @MainActor static func main() async throws { if ProcessInfo.processInfo.environment["LIMEIOT_TEXT_NATIVE_PHASE"] != nil { try await textLiveChecks() } else { try await contracts() } }
}
