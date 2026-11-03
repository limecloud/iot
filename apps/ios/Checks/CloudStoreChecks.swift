import CryptoKit
import Foundation
import LimeIoTKit

private struct CheckFailure: Error { let name: String }
@MainActor private func expect(_ value: Bool, _ name: String) throws { if !value { throw CheckFailure(name: name) } }
@MainActor private func until(_ predicate: () -> Bool) async throws {
    for _ in 0..<500 { if predicate() { return }; try await Task.sleep(for: .milliseconds(20)) }
    throw CheckFailure(name: "state transition timed out")
}
private actor CloudMemoryStore: SessionStore {
    var values: [String: Data] = [:]
    var preparedGate: CloudGate?
    func holdPrepared(_ gate: CloudGate) { preparedGate = gate }
    func load(origin: String) -> Data? { values[origin] }
    func save(origin: String, data: Data?) async {
        values[origin] = data
        if let data, let gate = preparedGate,
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let operations = object["operations"] as? [[String: Any]], !operations.isEmpty {
            preparedGate = nil
            await gate.wait()
        }
    }
}
private actor CloudGate {
    private(set) var entered = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async {
        entered = true
        await withCheckedContinuation { continuation = $0 }
    }
    func release() { continuation?.resume(); continuation = nil }
    func awaitEntry() async throws {
        for _ in 0..<500 { if entered { return }; try await Task.sleep(for: .milliseconds(10)) }
        throw CheckFailure(name: "gate was not reached")
    }
}
private actor CloudTransport: HTTPTransport {
    let origin = "https://control.example"
    let revision = "sha256:" + String(repeating: "a", count: 64)
    let token = String(repeating: "c", count: 64)
    let expiry = ISO8601DateFormatter().string(from: .now.addingTimeInterval(300))
    let sessionExpiry = ISO8601DateFormatter().string(from: .now.addingTimeInterval(3500))
    var requests: [URLRequest] = []
    var command: [String: Any]?
    var offline = false
    var badRevision = false
    var delayPoll = false
    var devicesGate: CloudGate?
    func setOffline(_ value: Bool) { offline = value }
    func setBadRevision(_ value: Bool) { badRevision = value }
    func setDelayPoll(_ value: Bool) { delayPoll = value }
    func holdDevices(_ gate: CloudGate) { devicesGate = gate }
    func pollCount() -> Int { requests.filter { $0.url!.path.hasSuffix("/authorizations/poll") }.count }
    func createCount() -> Int { requests.filter { $0.url!.path.hasSuffix("/remote-commands") && $0.httpMethod == "POST" }.count }
    private func remote(_ status: String) throws -> [String: Any] {
        guard let command else { throw CheckFailure(name: "missing original request") }
        return ["remote_id": "remote-" + String(repeating: "d", count: 64), "space_id": "space-a", "principal_id": "owner", "local_space_id": "local-a", "request_digest": String(repeating: "a", count: 64), "request": command, "status": status, "local_result": NSNull()]
    }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let path = request.url!.path
        var body: [String: Any] = [:], status = 200
        if path == "/api/native/v1/authorizations" {
            let id = "na-" + String(repeating: "b", count: 64)
            body = ["authorization_id": id, "user_code": "ABCDEF12", "verification_uri": origin + "/console/?native=" + id, "expires_at": expiry, "interval_seconds": 3, "status": "pending"]
        } else if path.hasSuffix("/authorizations/poll") {
            if delayPoll { try await Task.sleep(for: .seconds(20)) }
            body = ["status": "approved", "expires_at": expiry, "material": ["version": 1, "origin": origin, "audience": "console", "session": token, "principal_id": "owner", "expires_at": sessionExpiry]]
        } else if path.hasSuffix("/auth/session") {
            let csrf = SHA256.hash(data: Data(("limeiot-csrf:console:" + token).utf8)).map { String(format: "%02x", $0) }.joined()
            body = ["audience": "console", "principal": ["principal_id": "owner", "name": "测试账号"], "csrf_token": csrf, "expires_at": sessionExpiry]
        } else if path.hasSuffix("/auth/logout") { body = ["logged_out": true] }
        else if path == "/api/console/v1/spaces" { body = ["spaces": [["space_id": "space-a", "name": "家庭"], ["space_id": "space-b", "name": "教室"]]] }
        else if path.hasSuffix("/space-b/gateways") { body = ["gateways": []] }
        else if path.hasSuffix("/gateways") { body = ["gateways": [["gateway_id": "gateway-a", "space_id": "space-a", "local_space_id": "local-a", "principal_id": "owner", "scopes": ["devices.read", "commands.write"], "revision": "revision-a", "active": true]]] }
        else if path.hasSuffix("/devices") {
            if let gate = devicesGate { devicesGate = nil; await gate.wait() }
            if offline { status = 503; body = ["error": ["code": "gateway_offline"]] }
            else { body = ["items": [["device_id": "lamp", "model_revision": revision, "ready": true, "reported": ["light.power": ["value": false, "observed_at": "2026-11-02T00:00:00Z", "quality": "current", "source": "device"]]]], "next": NSNull(), "binding_revision": badRevision ? "other" : "revision-a"] }
        } else if path.contains("/model-releases/") { body = ["revision": revision, "model": ["model_id": "light", "services": [["id": "light", "properties": [["id": "power", "schema": ["type": "boolean"], "access": ["read", "write"]]], "events": []]]]] }
        else if path.hasSuffix("/remote-commands") && request.httpMethod == "POST" {
            command = try JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any]
            throw URLError(.networkConnectionLost)
        } else if path.contains("/remote-commands/by-key/") { body = try remote("unknown") }
        else if path.hasSuffix("/reconcile") { body = try remote("accepted") }
        else { throw CheckFailure(name: "unexpected endpoint") }
        return (try JSONSerialization.data(withJSONObject: body), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

@main struct CloudStoreChecks {
    @MainActor static func main() async throws {
        let suite = "run.limeai.iot.cloud-check-" + UUID().uuidString
        let preferences = UserDefaults(suiteName: suite)!
        defer { preferences.removePersistentDomain(forName: suite) }
        let vault = CloudMemoryStore(), transport = CloudTransport()
        let cloud = CloudStore(store: vault, preferences: preferences, transport: transport)
        cloud.endpoint = "https://control.example"
        await cloud.begin(); try expect(cloud.login != nil && cloud.pendingAuthorization, "authorization displayed")
        await cloud.poll(); try expect(await transport.pollCount() == 0, "background must not poll")
        await transport.setDelayPoll(true)
        let interrupted = Task { await cloud.runForeground() }
        for _ in 0..<500 { if await transport.pollCount() > 0 { break }; try await Task.sleep(for: .milliseconds(10)) }
        interrupted.cancel(); await interrupted.value
        try expect(cloud.principal == nil && cloud.pendingAuthorization && !cloud.foreground, "background cancellation keeps original authorization")
        await transport.setDelayPoll(false)
        let active = Task { await cloud.runForeground() }
        try await until { cloud.principal != nil && cloud.online && !cloud.busy }
        let device = cloud.devices[0]
        await cloud.control(device, path: "light.power", value: .bool(true))
        try expect(await transport.createCount() == 1 && cloud.records.count == 1 && cloud.records[0].attempted, "lost command retained")
        try expect(cloud.blocked(device) && !cloud.online, "unknown blocks duplicate control")
        active.cancel(); await active.value
        await transport.setOffline(true)
        let restored = CloudStore(store: vault, preferences: preferences, transport: transport)
        let resumed = Task { await restored.runForeground() }
        try await until { restored.principal != nil && !restored.busy && restored.records.count == 1 }
        try expect(!restored.online, "offline restores original records")
        await restored.control(device, path: "light.power", value: .bool(true))
        await restored.resolve(restored.records[0])
        try expect(await transport.createCount() == 1 && restored.records[0].result?.status == .accepted, "query must not create or claim device completion")
        await restored.forget(restored.records[0]); try expect(restored.records.count == 1, "nonterminal cannot be deleted")
        await transport.setOffline(false); await transport.setBadRevision(true); await restored.refresh()
        try expect(!restored.online, "binding mismatch disables control")
        await restored.selectSpace("space-b")
        try expect(restored.space == "space-b" && restored.devices.isEmpty && restored.models.isEmpty && restored.records.isEmpty && restored.gateway == nil, "space isolation")
        await restored.logout()
        resumed.cancel(); await resumed.value
        try expect(restored.principal == nil && restored.devices.isEmpty, "logout clears visible identity")
        let saved = await vault.values.values.first!
        let state = try JSONSerialization.jsonObject(with: saved) as! [String: Any]
        try expect((state["operations"] as? [Any])?.count == 1 && state["material"] == nil, "logout retains original command without material")
        try await backgroundDuringPrepare()
        try await lateRefreshAfterBackground()
        print("{\"cloud_state_checks\":5,\"platform\":\"swift_host\",\"native_app\":false,\"hardware\":false}")
    }

    @MainActor static func backgroundDuringPrepare() async throws {
        let suite = "run.limeai.iot.cloud-prepare-" + UUID().uuidString
        let preferences = UserDefaults(suiteName: suite)!
        defer { preferences.removePersistentDomain(forName: suite) }
        let vault = CloudMemoryStore(), transport = CloudTransport(), gate = CloudGate()
        let cloud = CloudStore(store: vault, preferences: preferences, transport: transport)
        cloud.endpoint = "https://control.example"; await cloud.begin()
        let foreground = Task { await cloud.runForeground() }
        try await until { cloud.online && !cloud.busy }
        let device = cloud.devices[0]
        await vault.holdPrepared(gate)
        let command = Task { await cloud.control(device, path: "light.power", value: .bool(true)) }
        try await gate.awaitEntry()
        foreground.cancel(); await foreground.value
        await gate.release(); await command.value
        try expect(await transport.createCount() == 0, "background during prepare must not submit a command")
        try expect(!cloud.foreground && !cloud.online && !cloud.busy, "background leaves control disabled")
        let resumed = Task { await cloud.runForeground() }
        try await until { cloud.online && !cloud.busy }
        try expect(cloud.records.count == 1 && !cloud.records[0].attempted, "prepared original survives foreground restoration without submission")
        try expect(await transport.createCount() == 0, "foreground restoration must not submit prepared originals")
        await cloud.forget(cloud.records[0])
        try expect(cloud.records.isEmpty && !cloud.blocked(device), "explicit discard releases an unsent prepared original")
        resumed.cancel(); await resumed.value
    }

    @MainActor static func lateRefreshAfterBackground() async throws {
        let suite = "run.limeai.iot.cloud-refresh-" + UUID().uuidString
        let preferences = UserDefaults(suiteName: suite)!
        defer { preferences.removePersistentDomain(forName: suite) }
        let transport = CloudTransport(), gate = CloudGate()
        let cloud = CloudStore(store: CloudMemoryStore(), preferences: preferences, transport: transport)
        cloud.endpoint = "https://control.example"; await cloud.begin()
        let foreground = Task { await cloud.runForeground() }
        try await until { cloud.online && !cloud.busy }
        await transport.holdDevices(gate)
        let refresh = Task { await cloud.refresh() }
        try await gate.awaitEntry()
        foreground.cancel(); await foreground.value
        await gate.release(); await refresh.value
        try expect(!cloud.online && !cloud.foreground && !cloud.busy, "late refresh must not restore background control")
        try expect(await transport.createCount() == 0, "background refresh has no device effects")
    }
}
