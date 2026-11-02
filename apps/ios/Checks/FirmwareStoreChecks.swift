import Foundation
import LimeIoTKit

private enum Failure: Error { case check(String), lost }
@MainActor private func expect(_ value: Bool, _ name: String) throws { if !value { throw Failure.check(name) } }
private actor Memory: SessionStore {
    var values: [String: Data] = [:]
    func load(origin: String) -> Data? { values[origin] }
    func save(origin: String, data: Data?) { values[origin] = data }
}
private actor Wire: HTTPTransport {
    var upstream = URLSessionTransport(), posts = 0
    func reconnect() { upstream = URLSessionTransport() }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result = try await upstream.send(request)
        if request.httpMethod == "POST", request.url!.path.hasSuffix("/ota-operations") {
            posts += 1
            if let body = request.httpBody, case .object(let c) = try OtaJSON.parse(String(data: body, encoding: .utf8)!), c["type"] == .string("tasks.execute") { throw Failure.lost }
        }
        return result
    }
}
@main struct FirmwareStoreChecks {
    @MainActor static func main() async throws {
        let env = ProcessInfo.processInfo.environment, space = "space-demo", origin = env["LIMEIOT_ENDPOINT"]!
        let vector = try OtaJSON.parse(String(contentsOfFile: env["LIMEIOT_OTA_VECTOR"]!, encoding: .utf8), response: true)
        guard case .object(let root) = vector, case .object(let input) = root["request"], let trust = input["trust"], let manifest = input["manifest"], case .object(let t) = trust, let fingerprint = t["signing_key_id"] else { throw Failure.check("vector") }
        let vault = Memory(), wire = Wire()
        func connect() async throws -> FirmwareStore {
            let gateway = try GatewayClient(endpoint: origin, transport: wire, store: vault, allowLoopbackHTTP: true)
            try await gateway.login(token: env["LIMEIOT_TOKEN"]!)
            return FirmwareStore(client: OtaClient(gateway: gateway, store: vault), space: space, authFailure: { _ in })
        }
        func checkpoint(_ name: String) async throws {
            let (_, response) = try await URLSession.shared.data(from: URL(string: env["LIMEIOT_OTA_FIXTURE"]! + "/" + name)!)
            try expect((response as? HTTPURLResponse)?.statusCode == 200, "fixture " + name)
        }
        let store = try await connect()
        await store.refresh(); try expect(store.ready, "state loaded")
        await store.submit { .object(["type": .string("trust.add"), "trust": trust, "expected_signing_key_id": fingerprint]) }
        try expect(store.ready && store.trusts.count == 1 && store.records.count == 1, "independent trust")
        let trusted = store.trusts[0]
        let plan = JSONValue.object(["type": .string("tasks.plan"), "device_id": .string("device-lamp"), "trust_id": .string(trusted.id), "manifest": manifest, "expires_at": .string(ISO8601DateFormatter().string(from: Date().addingTimeInterval(600)))])
        await store.submit { plan }; let cancelledId = store.tasks[0].id
        await store.review(cancelledId); await store.transition("tasks.cancel")
        try expect(store.tasks[0].status == "cancelled" && store.reviewed == nil, "cancel and discard review")
        await store.submit { plan }; let id = store.tasks.first { $0.status == "planned" }!.id
        await store.transition("tasks.approve"); try expect(await wire.posts == 4, "no write without current review")
        await store.review(id); await store.transition("tasks.approve")
        try expect(store.reviewed == nil && store.tasks.first { $0.id == id }?.status == "approved", "approval discards review")
        await store.transition("tasks.execute"); try expect(await wire.posts == 5, "approval cannot chain install")
        try await checkpoint("approved")
        await store.review(id); await store.transition("tasks.execute")
        try expect(!store.ready && store.records.count == 6 && store.records.last?.result == nil, "lost response retained and writes disabled")
        await store.refresh(); await store.submit { plan }
        try expect(await wire.posts == 6, "new device plan blocked by unknown original")
        let original = store.records.first { $0.type == "tasks.execute" }!.id
        store.close(); await store.transition("tasks.execute")
        try await checkpoint("restart"); await wire.reconnect()
        let resumed = try await connect(); await resumed.refresh()
        try expect(resumed.records.count == 6 && resumed.tasks.first { $0.id == id }?.status == "unknown", "relogin retains original records")
        await resumed.recover(original); try expect(await wire.posts == 6, "resolve is GET only")
        await resumed.review(id)
        try expect(resumed.reviewed?.allowedActions == ["tasks.reconcile"], "unknown cannot install again")
        await resumed.transition("tasks.reconcile"); try await checkpoint("complete")
        for _ in 0..<40 { await resumed.refresh(); if resumed.tasks.first(where: { $0.id == id })?.status == "succeeded" { break }; try await Task.sleep(for: .milliseconds(100)) }
        try expect(resumed.tasks.first { $0.id == id }?.status == "succeeded", "actual terminal evidence")
        await resumed.submit { OtaChanges.revoke(trust: trusted) }
        try expect(resumed.records.count == 8 && resumed.records.allSatisfy { $0.result != nil } && !resumed.trusts[0].active, "all decisions retained")
        let posts = await wire.posts; try expect(posts == 8, "exact explicit writes")
        try Data("{\"passed\":true,\"posts\":\(posts),\"original_records\":8,\"host_ui_state\":true,\"hardware\":false,\"native_app_runtime\":false}".utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_OTA_TRACE"]!))
    }
}
