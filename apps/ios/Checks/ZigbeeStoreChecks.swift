import Foundation
import LimeIoTKit

@MainActor private func joinMustFail(_ action: @MainActor () async throws -> Void) async throws {
    do { try await action() } catch { return }; throw ObservationCheckFailure.check("expected rejection")
}

private func vector() throws -> [String: JSONValue] {
    let file = ProcessInfo.processInfo.environment["LIMEIOT_ZIGBEE_FIXTURE"] ?? "tests/fixtures/zigbee/commissioning-native.json"
    // 向量包含故意非法的小数，容器按通用JSON读取，再逐项交给生产校验器拒绝。
    return observationObject(try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: URL(fileURLWithPath: file))))
}
private actor JoinWire: HTTPTransport {
    let v: [String: JSONValue]
    var requests: [URLRequest] = [], results: [JSONValue] = []
    var drop = false, missing = false, corrupt = false, duplicate = false, unknown = false, changed = false, hold = false, waiting = false
    var release: CheckedContinuation<Void, Never>?
    init() throws { v = try vector() }
    var posts: Int { requests.filter { $0.httpMethod == "POST" && $0.url!.path.hasSuffix("/zigbee-operations") }.count }
    func configure(drop: Bool = false, missing: Bool = false, corrupt: Bool = false, duplicate: Bool = false, unknown: Bool = false, changed: Bool = false, hold: Bool = false) {
        self.drop = drop; self.missing = missing; self.corrupt = corrupt; self.duplicate = duplicate; self.unknown = unknown; self.changed = changed; self.hold = hold
    }
    func resume() { release?.resume(); release = nil; hold = false }
    func alterTerminal() { var o = observationObject(results[0]); o["completed_at"] = .string("2030-01-01T00:00:00.200Z"); var r = observationObject(o["result"]); r["observed_at"] = o["completed_at"]; o["result"] = .object(r); results[0] = .object(o) }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request); let path = request.url!.path
        func response(_ value: JSONValue, _ status: Int = 200, headers: [String: String]? = nil, duplicate: Bool = false) -> (Data, HTTPURLResponse) {
            var text = ObservationJSON.canonical(value)
            if duplicate { text = "{\"status\":\"unknown\"," + text.dropFirst() }
            return (Data(text.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!)
        }
        if path.hasSuffix("/auth/session") { return response(.object(["authenticated": .bool(true), "csrf_token": .string("csrf"), "expires_at": .string("2030-01-01T00:00:00Z")]), headers: ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"]) }
        if path.hasSuffix("/zigbee-coordinators") {
            if hold { waiting = true; await withCheckedContinuation { release = $0 }; waiting = false }
            var page = observationObject(v["coordinators"])
            if changed, case .array(var items) = page["items"] { var c = observationObject(items[0]); c["revision"] = .string("sha256:" + String(repeating: "0", count: 64)); items[0] = .object(c); page["items"] = .array(items) }
            return response(.object(page))
        }
        if path.hasSuffix("/zigbee-operations"), request.httpMethod == "GET" { return response(.object(["items": .array(results), "next_cursor": .null])) }
        let key = request.value(forHTTPHeaderField: "Idempotency-Key") ?? request.url!.lastPathComponent
        if request.httpMethod == "POST" {
            let change = try ZigbeeJSON.parse(String(decoding: request.httpBody!, as: UTF8.self)), fields = observationObject(change)
            let original = JSONValue.object(["space_id": .string("space-demo"), "idempotency_key": .string(key), "change": change])
            var o = observationObject(v[unknown ? "unknown" : "accepted"])
            o["operation_id"] = .string("join-" + key); o["sequence"] = .integer(results.count + 1); o["request"] = original; o["request_digest"] = .string(ObservationJSON.digest(original))
            let seconds: Int; if case .integer(let n) = fields["duration_seconds"] { seconds = n } else { throw ObservationCheckFailure.check("seconds") }
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            o["blocked_until"] = .string(formatter.string(from: Date(timeIntervalSince1970: 1893456000 + Double(seconds) + 0.5)))
            if !unknown { var r = observationObject(o["result"]); r["duration_seconds"] = .integer(seconds); o["result"] = .object(r) }
            results.append(.object(o)); if drop { throw ObservationCheckFailure.lost }
        }
        guard !missing, var value = results.first(where: { observationObject(observationObject($0)["request"])["idempotency_key"] == .string(key) }) else { return response(.object(["error": .object(["code": .string("not_found")])]), 404) }
        if corrupt { var o = observationObject(value); o["request_digest"] = .string("sha256:" + String(repeating: "0", count: 64)); value = .object(o) }
        return response(value, duplicate: duplicate)
    }
}
private func client(_ memory: ObservationMemory, _ wire: JoinWire) async throws -> ZigbeeClient {
    let gateway = try GatewayClient(endpoint: "https://nas.local", transport: wire); try await gateway.login(token: "owner-input")
    return ZigbeeClient(gateway: gateway, store: memory, now: { Date(timeIntervalSince1970: 1893456010) })
}
@MainActor private final class JoinClock { var date = Date(timeIntervalSince1970: 1893456010) }
@MainActor private func state(_ memory: ObservationMemory, _ wire: JoinWire, _ clock: JoinClock = JoinClock()) async throws -> ZigbeeStore {
    let state = ZigbeeStore(client: try await client(memory, wire), space: "space-demo", authFailure: { _ in }, now: { clock.date })
    state.refresh(); await state.waitForIdle(); try observationCheck(state.ready, "join refresh: " + state.message); return state
}
@main enum ZigbeeStoreChecks {
    @MainActor static func main() async throws {
        if ProcessInfo.processInfo.environment["LIMEIOT_ZIGBEE_LIVE"] == "1" { try await zigbeeLiveChecks(); return }
        let v = try vector(), deadline = Date(timeIntervalSince1970: 1893456070)
        _ = try ZigbeeJSON.coordinators(v["coordinators"]!); try ZigbeeJSON.change(v["change"]!)
        _ = try ZigbeeJSON.operation(v["unknown"]!); _ = try ZigbeeJSON.operation(v["accepted"]!)
        guard case .array(let invalid) = v["invalid"] else { throw ObservationCheckFailure.check("shared vectors") }
        for item in invalid {
            let fields = observationObject(item), document = fields["document"]!
            try await joinMustFail {
                switch fields["type"] {
                case .string("change"): try ZigbeeJSON.change(document)
                case .string("coordinators"): _ = try ZigbeeJSON.coordinators(document)
                case .string("operation"): _ = try ZigbeeJSON.operation(document)
                default: _ = try ZigbeeJSON.history(document, space: "space-demo")
                }
            }
        }
        var capacity: [JSONValue] = []
        for index in 0..<256 {
            var o = observationObject(v["accepted"]), request = observationObject(o["request"])
            request["idempotency_key"] = .string("original-\(index)"); o["request"] = .object(request); o["request_digest"] = .string(ObservationJSON.digest(.object(request))); o["operation_id"] = .string("join-\(index)"); o["sequence"] = .integer(index + 1); capacity.append(.object(o))
        }
        let page = JSONValue.object(["items": .array(capacity), "next_cursor": .null])
        try observationCheck(try ZigbeeJSON.history(ZigbeeJSON.parse(ObservationJSON.canonical(page)), space: "space-demo").count == 256, "full history capacity")
        for mismatch in [false, true] {
            let memory = ObservationMemory(), wire = try JoinWire(), c = try await client(memory, wire)
            let p = try await c.prepare(space: "space-demo", coordinator: "home-znp", seconds: 60)
            await memory.configure(fail: !mismatch, mismatch: mismatch)
            try await joinMustFail { _ = try await c.submit(space: "space-demo", preparation: p, expiresAt: deadline, key: "original") }
            try observationCheck(await wire.posts == 0, "save failure no POST")
        }
        do {
            let memory = ObservationMemory(), wire = try JoinWire(), c = try await client(memory, wire)
            let p = try await c.prepare(space: "space-demo", coordinator: "home-znp", seconds: 60); await wire.configure(drop: true)
            try await joinMustFail { _ = try await c.submit(space: "space-demo", preparation: p, expiresAt: deadline, key: "original") }
            let restored = try await client(memory, wire)
            for mode in 0..<3 {
                await wire.configure(missing: mode == 0, corrupt: mode == 1, duplicate: mode == 2)
                try await joinMustFail { _ = try await restored.submit(space: "space-demo", preparation: p, expiresAt: .distantPast, key: "original") }
            }
            try observationCheck(try await restored.records(space: "space-demo").first?.result == nil, "bad receipts remain unknown")
            await wire.configure(); let result = try await restored.resolve(space: "space-demo", key: "original")
            try observationCheck((await wire.posts) == 1 && result.accepted, "recovery only GET")
            let other = try await client(ObservationMemory(), wire), historical = try await other.resolve(space: "space-demo", key: "original")
            let otherRecords = try await other.records(space: "space-demo")
            try observationCheck(historical.accepted && otherRecords.isEmpty, "other client history queries do not invent local originals")
            await wire.alterTerminal(); try await joinMustFail { _ = try await restored.resolve(space: "space-demo", key: "original") }
            let requests = await wire.requests.filter { $0.httpMethod == "POST" && $0.url!.path.hasSuffix("/zigbee-operations") }
            try observationCheck(requests.count == 1 && requests[0].timeoutInterval == 35 && requests[0].value(forHTTPHeaderField: "Authorization") == nil && requests[0].value(forHTTPHeaderField: "X-CSRF-Token") == "csrf", "shared session and bounded operation timeout")
        }
        do {
            let memory = ObservationMemory(), wire = try JoinWire(), c = try await client(memory, wire)
            let p = try await c.prepare(space: "space-demo", coordinator: "home-znp", seconds: 60); await wire.configure(unknown: true)
            _ = try await c.submit(space: "space-demo", preparation: p, expiresAt: deadline, key: "unknown")
            try await joinMustFail { _ = try await c.prepare(space: "space-demo", coordinator: "home-znp", seconds: 30) }
            await wire.configure(); let close = try await c.prepare(space: "space-demo", coordinator: "home-znp", seconds: 0)
            _ = try await c.submit(space: "space-demo", preparation: close, expiresAt: deadline, key: "close")
            let records = try await c.records(space: "space-demo"); try observationCheck((await wire.posts) == 2 && records.count == 2, "explicit close is independent")
        }
        do {
            let memory = ObservationMemory(), wire = try JoinWire(), c = try await client(memory, wire)
            let p = try await c.prepare(space: "space-demo", coordinator: "home-znp", seconds: 60); _ = try await c.records(space: "space-demo"); await memory.configure(holding: true)
            let pending = Task { try await c.submit(space: "space-demo", preparation: p, expiresAt: deadline, key: "original") }
            for _ in 0..<100 { if await memory.waiting { break }; try await Task.sleep(for: .milliseconds(5)) }
            try observationCheck(await memory.waiting, "save gate reached")
            let other = try await client(memory, wire); try await joinMustFail { _ = try await other.records(space: "space-demo") }
            pending.cancel(); await memory.resume(); try await joinMustFail { _ = try await pending.value }
            try observationCheck(await wire.posts == 0, "cancel after durable save before POST")
            let saved = try await c.records(space: "space-demo"); try observationCheck(saved.count == 1, "cancel preserves original")
            await memory.erase(); try await joinMustFail { _ = try await c.prepare(space: "space-demo", coordinator: "home-znp", seconds: 0) }
        }
        do {
            let wire = try JoinWire(), s = try await state(ObservationMemory(), wire)
            s.prepare(); await s.waitForIdle(); try observationCheck((await wire.posts) == 0 && s.canConfirm, "prepare zero effect")
            s.setSeconds("30"); try observationCheck(s.review == nil, "input clears review")
            s.prepare(); await s.waitForIdle(); s.cancelReview(); try observationCheck(await wire.posts == 0, "cancel zero effect")
            s.prepare(); await s.waitForIdle(); s.confirm(); await s.waitForIdle(); try observationCheck(s.records.count == 1 && s.records[0].accepted, "explicit opening")
            s.prepare(close: true); await s.waitForIdle(); try observationCheck(await wire.posts == 1, "close requires confirmation")
            s.confirm(); await s.waitForIdle(); try observationCheck(await wire.posts == 2, "explicit close")
        }
        do {
            let memory = ObservationMemory(), wire = try JoinWire(), clock = JoinClock(), s = try await state(memory, wire, clock)
            s.prepare(); await s.waitForIdle(); clock.date.addTimeInterval(60); s.poll(); s.confirm(); try observationCheck((await wire.posts) == 0 && s.review == nil, "expiration zero effect")
            clock.date.addTimeInterval(-60); s.prepare(); await s.waitForIdle(); await wire.configure(changed: true); s.confirm(); await s.waitForIdle(); try observationCheck(await wire.posts == 0, "configuration changed no POST")
        }
        do {
            let wire = try JoinWire(), s = try await state(ObservationMemory(), wire); await wire.configure(hold: true); s.prepare()
            for _ in 0..<100 { if await wire.waiting { break }; try await Task.sleep(for: .milliseconds(5)) }
            try observationCheck(await wire.waiting, "late read reached"); s.pause(); await wire.resume(); await s.waitForIdle()
            try observationCheck((await wire.posts) == 0 && s.review == nil && !s.ready && !s.busy, "late read cannot revive")
        }
        do {
            let memory = ObservationMemory(), wire = try JoinWire(), s = try await state(memory, wire)
            s.prepare(); await s.waitForIdle(); await memory.configure(holding: true); s.confirm()
            for _ in 0..<100 { if await memory.waiting { break }; try await Task.sleep(for: .milliseconds(5)) }
            try observationCheck(await memory.waiting, "state save gate reached"); s.setOnline(false); await memory.resume(); await s.waitForIdle()
            try observationCheck((await wire.posts) == 0 && !s.ready && s.review == nil, "offline durable wait no POST")
            let restored = try await state(memory, wire); try observationCheck(restored.records.count == 1, "cancelled original restored")
            restored.close(); restored.setOnline(true); restored.refresh(); try observationCheck(!restored.ready, "closed cannot revive")
        }
        print("{\"zigbee_contract_groups\":5,\"zigbee_state_groups\":4,\"shared_invalid_vectors\":\(invalid.count),\"hardware\":false,\"native_app_runtime\":false}")
    }
}
