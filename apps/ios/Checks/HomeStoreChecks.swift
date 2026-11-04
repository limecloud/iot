import Foundation
import LimeIoTKit

private struct HomeCheckFailure: Error { let name: String }
@MainActor private func homeExpect(_ value: Bool, _ name: String) throws { if !value { throw HomeCheckFailure(name: name) } }
private func sameHomeIntent(_ lhs: CommandIntent?, _ rhs: CommandIntent?) throws -> Bool {
    guard let lhs, let rhs else { return false }
    let encoder = JSONEncoder(), decoder = JSONDecoder()
    return try decoder.decode(JSONValue.self, from: encoder.encode(lhs)) == decoder.decode(JSONValue.self, from: encoder.encode(rhs))
}
private let homeOrigin = "https://nas.local"
private actor HomeMemory: SessionStore {
    var values: [String: Data] = [:]
    var pendingMode = "normal"
    func mode(_ value: String) { pendingMode = value }
    func pending() -> Data? { values[homeOrigin + "#pending"] }
    func load(origin: String) -> Data? { values[origin] }
    func save(origin: String, data: Data?) throws {
        if origin.hasSuffix("#pending") {
            if pendingMode == "throw" { throw HomeCheckFailure(name: "storage fixture") }
            if pendingMode == "ignore" || (pendingMode == "ignore-clear" && data == Data("{}".utf8)) { return }
        }
        values[origin] = data
    }
}
private actor HomeWire: HTTPTransport {
    var requests: [URLRequest] = []
    var lose = false, wrong = false, missing = false, offline = false
    var original: [String: Any]?
    func configure(lose: Bool = false, wrong: Bool = false, missing: Bool = false, offline: Bool = false) { self.lose = lose; self.wrong = wrong; self.missing = missing; self.offline = offline }
    func posts() -> Int { requests.filter { $0.url!.path.hasSuffix("/commands") && $0.httpMethod == "POST" }.count }
    private func receipt() throws -> [String: Any] {
        guard var request = original, let operation = request["operation"] as? [String: Any], let path = operation["path"] as? String else { throw HomeCheckFailure(name: "missing original") }
        if wrong { request["device_id"] = "another-device" }
        let json = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: request))
        return ["command_id": "command-original", "status": "confirmed", "request": request, "request_digest": ObservationJSON.digest(json), "error": NSNull(), "run_id": NSNull(), "evidence": ["type": "device_result", "reported": [path: operation["value"]!]]]
    }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let path = request.url!.path
        var body: [String: Any], status = 200, headers: [String: String]? = nil
        if path.hasSuffix("/auth/session") {
            body = ["authenticated": true, "csrf_token": "csrf", "expires_at": "2030-01-01T00:00:00Z"]
            headers = ["Set-Cookie": "__Host-limeiot_session=fixture; Secure"]
        } else if path.hasSuffix("/auth/logout") { body = [:] }
        else if path == "/api/v1/spaces" { body = ["items": [["space_id": "space-demo"]]] }
        else if path.hasSuffix("/devices") {
            if offline { status = 503; body = ["error": ["code": "unavailable"]] }
            else { body = ["items": [["device_id": "device-lamp", "model_revision": "sha256:" + String(repeating: "a", count: 64), "ready": true, "reported": [:]]]] }
        } else if path.hasSuffix("/capabilities") { body = ["models": [:]] }
        else if path.hasSuffix("/commands") && request.httpMethod == "POST" {
            original = try JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any]
            original?["space_id"] = "space-demo"; original?["idempotency_key"] = request.value(forHTTPHeaderField: "Idempotency-Key")!
            if lose { throw URLError(.networkConnectionLost) }
            body = try receipt()
        } else if path.contains("/commands/by-key/") {
            guard path.split(separator: "/").last.map(String.init) == original?["idempotency_key"] as? String else { throw HomeCheckFailure(name: "changed original key") }
            if missing { status = 404; body = ["error": ["code": "command_not_found"]] } else { body = try receipt() }
        } else if ["/commands", "/rule-deployments", "/runs"].contains(where: { path.hasSuffix($0) }) { body = ["items": [], "next_cursor": NSNull()] }
        else { throw HomeCheckFailure(name: "unexpected endpoint: " + path) }
        return (try JSONSerialization.data(withJSONObject: body), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!)
    }
}

@main struct HomeStoreChecks {
    @MainActor static func main() async throws {
        let suite = "run.limeai.iot.home-check-" + UUID().uuidString
        let preferences = UserDefaults(suiteName: suite)!
        defer { preferences.removePersistentDomain(forName: suite) }
        func home(_ memory: HomeMemory, _ wire: HomeWire, restore: Bool = false) async -> HomeStore {
            let result = HomeStore(store: memory, preferences: preferences, transport: wire); result.endpoint = homeOrigin
            await result.connect(token: restore ? nil : "owner-input", restore: restore); return result
        }
        for mode in ["throw", "ignore"] {
            let memory = HomeMemory(), wire = HomeWire(), state = await home(memory, wire)
            try homeExpect(state.online, "initial snapshot"); await memory.mode(mode)
            await state.control(state.snapshot!.devices[0], path: "light.power", value: .bool(true))
            try homeExpect(await wire.posts() == 0 && state.pending.isEmpty && !state.busy, "unverified storage sends nothing")
            try homeExpect(state.message == "无法保存本地操作记录，请稍后重试", "unsent operation reports storage failure")
        }
        do {
            let memory = HomeMemory(), wire = HomeWire(), first = await home(memory, wire)
            await wire.configure(wrong: true)
            await first.control(first.snapshot!.devices[0], path: "light.power", value: .bool(true))
            let original = first.pending["device-lamp"], bytes = await memory.pending()
            var posts = await wire.posts()
            try homeExpect(original != nil && bytes != nil && posts == 1, "wrong receipt retains original")
            let restored = await home(memory, wire, restore: true), device = restored.snapshot!.devices[0]
            try homeExpect(try sameHomeIntent(restored.pending[device.id], original), "recreation retains complete input")
            await restored.control(device, path: "light.power", value: .bool(false)); await restored.recover(device)
            var saved = await memory.pending()
            try homeExpect(saved == bytes && (try sameHomeIntent(restored.pending[device.id], original)), "wrong GET cannot clear")
            await wire.configure(missing: true); await restored.recover(device)
            saved = await memory.pending(); posts = await wire.posts()
            try homeExpect(saved == bytes && posts == 1, "404 cannot clear or resend")
            await wire.configure(); await restored.recover(device)
            saved = await memory.pending(); posts = await wire.posts()
            try homeExpect(restored.pending.isEmpty && saved == Data("{}".utf8) && posts == 1, "valid original GET clears")
        }
        do {
            let memory = HomeMemory(), wire = HomeWire(), first = await home(memory, wire)
            await wire.configure(lose: true); await first.control(first.snapshot!.devices[0], path: "light.power", value: .bool(true))
            let original = await memory.pending(); try homeExpect(original != nil, "loss retains original")
            await first.logout(); let saved = await memory.pending()
            try homeExpect(!first.connected && saved == original, "logout retains original")
            let restored = await home(memory, wire); await restored.recover(restored.snapshot!.devices[0])
            let posts = await wire.posts()
            try homeExpect(restored.pending.isEmpty && posts == 1, "login restores without another POST")
        }
        do {
            let memory = HomeMemory(), wire = HomeWire(), state = await home(memory, wire), device = state.snapshot!.devices[0]
            await memory.mode("ignore-clear"); await state.control(device, path: "light.power", value: .bool(true))
            let saved = await memory.pending()
            try homeExpect(state.pending[device.id] != nil && saved != Data("{}".utf8), "failed clear retains original")
            await memory.mode("normal"); await state.recover(device)
            let posts = await wire.posts()
            try homeExpect(state.pending.isEmpty && posts == 1, "successful clear uses only GET")
        }
        do {
            let memory = HomeMemory(), wire = HomeWire(); try await memory.save(origin: homeOrigin + "#pending", data: Data("{".utf8))
            let state = await home(memory, wire)
            let saved = await memory.pending(), posts = await wire.posts()
            try homeExpect(!state.connected && !state.online && saved == Data("{".utf8) && posts == 0, "corrupt original blocks connection")
        }
        do {
            let memory = HomeMemory(), wire = HomeWire(), state = await home(memory, wire), device = state.snapshot!.devices[0]
            let conversation = state.textGeneration
            let voiceTurn = state.voiceTurn
            try homeExpect(voiceTurn != nil && voiceTurn?.online == true, "voice turn created with connected home")
            try homeExpect(conversation != nil && conversation?.online == true, "text store created with connected home")
            await wire.configure(offline: true); await state.refresh()
            try homeExpect(!state.online && state.snapshot?.devices.first?.id == device.id, "503 retains observation")
            try homeExpect(conversation?.online == false && conversation?.ready == false, "offline pauses text store")
            try homeExpect(voiceTurn?.online == false && voiceTurn?.ready == false && voiceTurn?.visible == nil, "offline pauses voice turn")
            await state.control(device, path: "light.power", value: .bool(true)); try homeExpect(await wire.posts() == 0, "offline forbids control")
            await wire.configure(); await state.refresh(); try homeExpect(state.online, "new snapshot restores online")
            try homeExpect(state.textGeneration === conversation && conversation?.online == true, "same space reuses text store")
            try homeExpect(state.voiceTurn === voiceTurn && voiceTurn?.online == true, "same space reuses voice turn")
            await state.logout(); try homeExpect(state.textGeneration == nil && state.voiceTurn == nil, "logout closes conversation stores")
        }
        print("{\"home_store_groups\":6,\"storage_failure_modes\":2,\"native_app_runtime\":false,\"hardware\":false}")
    }
}
