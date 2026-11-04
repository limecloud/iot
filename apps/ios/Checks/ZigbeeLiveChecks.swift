import Foundation
import LimeIoTKit

private actor JoinFileStore: SessionStore {
    let path: String
    init(_ path: String) { self.path = path }
    func load(origin: String) throws -> Data? { guard origin.hasSuffix("#zigbee-operations") else { throw ObservationCheckFailure.storage }; return FileManager.default.fileExists(atPath: path) ? try Data(contentsOf: URL(fileURLWithPath: path)) : nil }
    func save(origin: String, data: Data?) throws {
        guard origin.hasSuffix("#zigbee-operations"), let data else { throw ObservationCheckFailure.storage }
        if !FileManager.default.fileExists(atPath: path) { guard FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw ObservationCheckFailure.storage } }
        let file = try FileHandle(forWritingTo: URL(fileURLWithPath: path)); defer { try? file.close() }
        try file.truncate(atOffset: 0); try file.write(contentsOf: data); try file.synchronize()
    }
}
private actor JoinLiveWire: HTTPTransport {
    let upstream = URLSessionTransport(), drop: Bool
    var posts = 0
    init(drop: Bool) { self.drop = drop }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result = try await upstream.send(request)
        if request.httpMethod == "POST", request.url!.path.hasSuffix("/zigbee-operations") { posts += 1; if drop && posts == 1 { throw ObservationCheckFailure.lost } }
        return result
    }
}
@MainActor func zigbeeLiveChecks() async throws {
    let env = ProcessInfo.processInfo.environment, phase = env["LIMEIOT_ZIGBEE_PHASE"]!, space = "space-demo"
    let file = JoinFileStore(env["LIMEIOT_ZIGBEE_STORE"]!), wire = JoinLiveWire(drop: phase == "create")
    let gateway = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, transport: wire, allowLoopbackHTTP: true); try await gateway.login(token: env["LIMEIOT_TOKEN"]!)
    func make() async throws -> ZigbeeStore {
        let state = ZigbeeStore(client: ZigbeeClient(gateway: gateway, store: file), space: space, authFailure: { _ in })
        state.refresh(); await state.waitForIdle(); try observationCheck(state.ready, "live join refresh: " + state.message); return state
    }
    var state = try await make()
    if phase == "create" {
        state.prepare(); await state.waitForIdle(); try observationCheck(state.canConfirm && state.records.isEmpty, "live opening review")
        state.confirm(); await state.waitForIdle(); try observationCheck(state.records.count == 1 && state.records[0].result == nil, "lost real receipt remains unknown")
        state.close(); state = try await make(); state.recover(state.records[0].id); await state.waitForIdle(); try observationCheck(state.records[0].accepted, "original GET recovery")
        let sources = ObservationStore(client: ObservationClient(gateway: gateway, store: ObservationMemory()), space: space, authFailure: { _ in })
        sources.updateDevices(try await gateway.snapshot().devices); sources.refresh(); await sources.waitForIdle(); sources.setDevice("zigbee-environment")
        sources.discover(); await sources.waitForIdle(); sources.readEndpoints("1122334455667788"); await sources.waitForIdle(); sources.queryEndpoint(1); await sources.waitForIdle()
        try observationCheck(sources.canConfirm, "live discovery endpoint review: " + sources.message)
        sources.confirm(); await sources.waitForIdle(); try observationCheck(sources.bindings.first?.active == true, "native explicit source binding"); sources.close()
    } else {
        try observationCheck(phase == "restore" && state.records.count == 2, "native process restart restores two originals")
        for record in state.records { state.recover(record.id); await state.waitForIdle() }
    }
    state.prepare(close: true); await state.waitForIdle(); try observationCheck(state.canConfirm, "live separate close review: " + state.message)
    state.confirm(); await state.waitForIdle(); try observationCheck(state.entries.last?.accepted == true, "live explicit close: " + state.message)
    let records = try await ZigbeeClient(gateway: gateway, store: file).records(space: space), posts = await wire.posts
    try observationCheck(posts == (phase == "create" ? 2 : 1) && records.count == (phase == "create" ? 2 : 3), "exact commissioning counts")
    state.close()
    let trace = JSONValue.object(["passed": .bool(true), "phase": .string(phase), "host_ui_state": .bool(true), "commissioning_posts": .integer(posts), "records": .array(records.map { .object(["request": $0.request, "result": $0.result ?? .null]) }), "hardware": .bool(false), "native_app_runtime": .bool(false)])
    try Data(ObservationJSON.canonical(trace).utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_ZIGBEE_TRACE"]!))
}
