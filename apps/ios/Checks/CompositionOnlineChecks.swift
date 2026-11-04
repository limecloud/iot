import Foundation
import CryptoKit
import LimeIoTKit

private enum Failure: Error { case check(String), storage, lost }
private func expect(_ value: Bool, _ name: String) throws { if !value { throw Failure.check(name) } }
private func obj(_ value: JSONValue?) -> [String: JSONValue] { if case .object(let fields) = value { return fields }; return [:] }
private func text(_ value: JSONValue?) -> String { if case .string(let s) = value { return s }; return "" }
private func sha(_ value: JSONValue) -> String { "sha256:" + SHA256.hash(data: Data(OtaJSON.canonical(value).utf8)).map { String(format: "%02x", $0) }.joined() }
private final class Clock: @unchecked Sendable {
    private let lock = NSLock(); private var value = Date(timeIntervalSince1970: 1793836800)
    var now: Date { lock.withLock { value } }
    func advance(_ seconds: Double) { lock.withLock { value = value.addingTimeInterval(seconds) } }
}
private actor Memory: SessionStore {
    var raw: Data?; var fail = false, hold = false, entered = false
    func setFail(_ value: Bool) { fail = value }
    func setHold(_ value: Bool) { hold = value }
    func corrupt() { raw = Data("{}".utf8) }
    func remove() { raw = nil }
    func load(origin: String) throws -> Data? { guard origin == "https://nas.local#composition:space-demo" else { throw Failure.storage }; return raw }
    func save(origin: String, data: Data?) async throws { if fail { throw Failure.storage }; raw = data; if hold { entered = true; try await Task.sleep(for: .seconds(30)) } }
}
private actor Wire: HTTPTransport {
    let fixture: [String: JSONValue], memory: Memory
    var deployment: JSONValue?, posts = 0, drop = false, reject = false, changed = false, forged = false, badReceipt = false
    var hold = false, entered = false; var release: CheckedContinuation<Void, Never>?
    init(_ fixture: [String: JSONValue], _ memory: Memory) { self.fixture = fixture; self.memory = memory }
    func mode(_ name: String) { drop = name == "drop"; reject = name == "reject"; changed = name == "changed"; forged = name == "forged"; badReceipt = name == "bad-receipt"; hold = name == "hold" }
    func resume() { release?.resume(); release = nil; hold = false }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        func response(_ value: JSONValue, status: Int = 200, headers: [String: String] = [:]) -> (Data, HTTPURLResponse) { (Data(OtaJSON.canonical(value).utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!) }
        if path.hasSuffix("/auth/session") { return response(.object(["authenticated": .bool(true), "csrf_token": .string("csrf"), "expires_at": .string("2030-01-01T00:00:00Z")]), headers: ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"]) }
        try expect(request.timeoutInterval == 5 && request.value(forHTTPHeaderField: "Origin") == "https://nas.local" && request.value(forHTTPHeaderField: "X-CSRF-Token") == "csrf", "original authenticated bounded transport")
        if path.contains("/devices/") {
            if hold { entered = true; await withCheckedContinuation { release = $0 } }
            guard case .array(let devices) = fixture["devices"], let found = devices.first(where: { obj($0)["device_id"] == .string(request.url!.lastPathComponent) }) else { throw Failure.check("device") }
            var device = obj(found); if changed { device["model_revision"] = .string("sha256:" + String(repeating: "a", count: 64)) }; return response(.object(device))
        }
        if path.hasSuffix("/rules:validate") || path.hasSuffix("/rules:simulate") {
            let input = try OtaJSON.parse(String(decoding: request.httpBody!, as: UTF8.self)), rule = path.hasSuffix("/rules:validate") ? input : obj(input)["rule"]!
            if path.hasSuffix("/rules:validate") { return response(.object(["valid": .bool(true), "revision": .string(sha(rule))])) }
            var simulation = obj(fixture["simulation"]); simulation["revision"] = .string(sha(rule)); simulation["proposed_actions"] = obj(rule)["actions"]; if forged { simulation["executed"] = .bool(true) }; return response(.object(simulation))
        }
        if path.hasSuffix("/rule-deployments"), request.httpMethod == "POST" {
            posts += 1; try expect(request.value(forHTTPHeaderField: "If-None-Match") == "*", "conditional creation")
            let raw = await memory.raw!; let record = try CompositionRecord.parse(String(decoding: raw, as: UTF8.self), origin: "https://nas.local", space: "space-demo")
            let rule = try OtaJSON.parse(String(decoding: request.httpBody!, as: UTF8.self)); try expect(record.state == "attempted" && RuleProof.equal(record.compiled.rule, rule), "full original durable before POST")
            if reject { return response(.object(["error": .object(["code": .string("forbidden")])]), status: 403) }
            deployment = .object(["rule": rule, "revision": .string(sha(rule)), "last_run": .null])
            if drop { throw Failure.lost }
            if badReceipt { var bad = obj(deployment); bad["revision"] = .string("sha256:" + String(repeating: "a", count: 64)); return response(.object(bad)) }
            return response(deployment!)
        }
        if path.hasSuffix("/rule-deployments") { return response(.object(["items": .array(deployment.map { [$0] } ?? []), "next_cursor": .null])) }
        throw Failure.check("unexpected request " + path)
    }
}
private func compiled(_ fixture: [String: JSONValue]) throws -> CompositionCompiled { try CompositionPackage.parse(text(fixture["package_text"])).compile(bindings: ["touch": "device-button", "light": "device-lamp"], instanceID: "native-reading") }
private func gateway(_ wire: Wire) async throws -> GatewayClient { let g = try GatewayClient(endpoint: "https://nas.local", transport: wire); try await g.login(token: "fixture"); return g }
@MainActor private func rejects(_ work: @MainActor () async throws -> Void) async throws { do { try await work() } catch { return }; throw Failure.check("unexpected acceptance") }
@MainActor private func devices(_ fixture: [String: JSONValue]) throws -> [Device] {
    let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase; return try decoder.decode([Device].self, from: Data(OtaJSON.canonical(fixture["devices"]!).utf8))
}

@main enum CompositionOnlineChecks {
    @MainActor static func main() async throws {
        if ProcessInfo.processInfo.environment["LIMEIOT_COMPOSITION_PHASE"] != nil { try await compositionLiveChecks(); return }
        let f = obj(try OtaJSON.parse(String(contentsOfFile: ProcessInfo.processInfo.environment["LIMEIOT_COMPOSITION_FIXTURE"]!, encoding: .utf8), response: true)), value = try compiled(f)
        let rawContract = URL(fileURLWithPath: ProcessInfo.processInfo.environment["LIMEIOT_COMPOSITION_FIXTURE"]!).deletingLastPathComponent().appendingPathComponent("contract.json")
        let contract = obj(try OtaJSON.parse(String(contentsOf: rawContract, encoding: .utf8), response: true))
        do {
            let m = Memory(), w = Wire(f, m), c = try CompositionClient(gateway: await gateway(w), store: m, space: "space-demo")
            let preview = try await c.plan(value); try expect(preview.compiled.revision == text(obj(f["validation"])["revision"]), "real gateway revision")
            let record = try await c.deploy(); try expect(record.state == "acknowledged", "acknowledged"); try expect(await w.posts == 1, "single POST")
            if case .array(let records) = contract["records"] { try expect(records.contains(.string(record.json)), "JS record parity") }
            let restored = try CompositionClient(gateway: await gateway(w), store: m, space: "space-demo")
            let current = try await restored.resolve(); try expect(current.deployment != nil, "current deployment"); try expect(await w.posts == 1, "restart only GET")
            try await restored.prepareAnother(); try expect(try await restored.record() == nil, "explicit prepare")
        }
        for mode in ["drop", "bad-receipt", "reject"] {
            let m = Memory(), w = Wire(f, m), c = try CompositionClient(gateway: await gateway(w), store: m, space: "space-demo")
            _ = try await c.plan(value); await w.mode(mode); try await rejects { _ = try await c.deploy() }
            let record = try await c.record()!; try expect(record.state == (mode == "reject" ? "rejected" : "attempted"), "receipt state " + mode)
            _ = try await c.resolve(); try expect(await w.posts == 1, "resolve no POST")
            if mode != "reject" { try await rejects { try await c.prepareAnother() }; try await rejects { _ = try await c.plan(value) } }
        }
        for mode in ["storage", "changed", "expired", "session", "forged", "cancel"] {
            let m = Memory(), w = Wire(f, m), g = try await gateway(w), clock = Clock()
            let c = try CompositionClient(gateway: g, store: m, space: "space-demo", now: { clock.now })
            if mode == "forged" { await w.mode(mode); try await rejects { _ = try await c.plan(value) } }
            else {
                _ = try await c.plan(value)
                if mode == "storage" { await m.setFail(true) }; if mode == "changed" { await w.mode(mode) }; if mode == "expired" { clock.advance(60) }; if mode == "session" { try await g.login(token: "new-session") }; if mode == "cancel" { await c.invalidate() }
                try await rejects { _ = try await c.deploy() }
            }
            try expect(await w.posts == 0, "zero deployment for " + mode)
        }
        do {
            let m = Memory(), w = Wire(f, m), c = try CompositionClient(gateway: await gateway(w), store: m, space: "space-demo")
            _ = try await c.plan(value); await m.setHold(true)
            let task = Task { try await c.deploy() }; for _ in 0..<100 { if await m.entered { break }; try await Task.sleep(for: .milliseconds(5)) }
            try expect(await m.entered, "durable save reached"); task.cancel(); _ = await task.result
            try expect(try await c.record()?.state == "attempted", "saved cancellation recorded"); try expect(await w.posts == 0, "saved cancellation no POST")
        }
        for corrupt in [false, true] {
            let m = Memory(), w = Wire(f, m), c = try CompositionClient(gateway: await gateway(w), store: m, space: "space-demo")
            _ = try await c.plan(value); _ = try await c.deploy(); if corrupt { await m.corrupt() } else { await m.remove() }
            try await rejects { _ = try await c.record() }; try await rejects { _ = try await c.plan(value) }; try expect(await w.posts == 1, "damaged ledger blocks replacement")
        }
        do {
            let m = Memory(), w = Wire(f, m), g = try await gateway(w), clock = Clock()
            let s = CompositionStore(client: try CompositionClient(gateway: g, store: m, space: "space-demo", now: { clock.now }), authFailure: { _ in }, now: { clock.now })
            s.updateDevices(try devices(f)); s.refresh(); await s.waitForIdle(); s.bind("touch", device: "device-button"); s.bind("light", device: "device-lamp"); await s.waitForIdle()
            try expect(s.canPlan, "explicit binding opens preview"); s.plan(); await s.waitForIdle(); try expect(s.canDeploy, "state proof")
            clock.advance(60); s.poll(); try expect(!s.canDeploy, "state expiry"); s.plan(); await s.waitForIdle(); s.pause(); await s.waitForIdle(); try expect(!s.canDeploy && !s.ready, "background clears proof")
            s.refresh(); await s.waitForIdle(); await w.mode("hold"); s.plan()
            for _ in 0..<100 { if await w.entered { break }; try await Task.sleep(for: .milliseconds(5)) }
            try expect(await w.entered, "late response reached"); s.pause(); await w.resume(); await s.waitForIdle(); try expect(!s.canDeploy, "late response cannot restore proof"); try expect(await w.posts == 0, "late response no POST")
            s.refresh(); await s.waitForIdle(); s.plan(); await s.waitForIdle(); s.deploy(); await s.waitForIdle(); try expect(s.record?.state == "acknowledged", "actual state deploy: " + s.message)
            s.pause(); await s.waitForIdle(); s.refresh(); await s.waitForIdle(); s.query(); await s.waitForIdle(); try expect(s.record?.state == "acknowledged", "state original record"); try expect(await w.posts == 1, "state restore only GET"); s.close(); await s.waitForIdle()
        }
        print("Swift组合在线合同及实际状态层通过：共享记录、单次条件创建、丢回执、存储/模型/期限/会话/取消边界与前后台恢复")
    }
}
