import Foundation
import LimeIoTKit

private actor SourceFileStore: SessionStore {
    let path: String
    init(_ path: String) { self.path = path }
    func load(origin: String) throws -> Data? {
        guard origin.hasSuffix("#observation-operations") else { throw ObservationCheckFailure.storage }
        return FileManager.default.fileExists(atPath: path) ? try Data(contentsOf: URL(fileURLWithPath: path)) : nil
    }
    func save(origin: String, data: Data?) throws {
        guard origin.hasSuffix("#observation-operations"), let data else { throw ObservationCheckFailure.storage }
        if !FileManager.default.fileExists(atPath: path) { guard FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw ObservationCheckFailure.storage } }
        let file = try FileHandle(forWritingTo: URL(fileURLWithPath: path)); defer { try? file.close() }
        try file.truncate(atOffset: 0); try file.write(contentsOf: data); try file.synchronize()
    }
}
private actor SourceLiveWire: HTTPTransport {
    let upstream = URLSessionTransport(), drop: Bool
    var posts = 0, queries = 0
    var discoveries = 0, endpointQueries = 0
    init(drop: Bool) { self.drop = drop }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result = try await upstream.send(request)
        if request.httpMethod == "POST", request.url!.path.hasSuffix("/observation-operations") { posts += 1; if drop && posts == 1 { throw ObservationCheckFailure.lost } }
        if request.httpMethod == "POST", request.url!.path.hasSuffix("/observation-candidates") { queries += 1 }
        if request.httpMethod == "POST", request.url!.path.hasSuffix("/observation-discoveries") { discoveries += 1 }
        if request.httpMethod == "POST", request.url!.path.hasSuffix("/observation-endpoints") { endpointQueries += 1 }
        return result
    }
}
@MainActor func observationLiveChecks() async throws {
    let env = ProcessInfo.processInfo.environment, phase = env["LIMEIOT_OBSERVATION_PHASE"]!, space = "space-demo"
    let onOff = env["LIMEIOT_OBSERVATION_PROFILE"] == "on_off", device = env["LIMEIOT_OBSERVATION_PROFILE"] == "on_off" ? "zigbee-switch" : "zigbee-environment", ieee = env["LIMEIOT_OBSERVATION_PROFILE"] == "on_off" ? "1122334455667789" : "1122334455667788"
    let file = SourceFileStore(env["LIMEIOT_OBSERVATION_STORE"]!), wire = SourceLiveWire(drop: phase == "create")
    let gateway = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, transport: wire, allowLoopbackHTTP: true)
    try await gateway.login(token: env["LIMEIOT_TOKEN"]!)
    func make() async throws -> ObservationStore {
        let s = ObservationStore(client: ObservationClient(gateway: gateway, store: file), space: space, authFailure: { _ in })
        s.updateDevices(try await gateway.snapshot().devices); s.refresh(); await s.waitForIdle(); try observationCheck(s.ready, "live refresh: " + s.message)
        try observationCheck(s.discovery == nil && s.endpoints == nil, "discovery is not restored from durable records")
        s.setIEEE(ieee); s.setDevice(device); return s
    }
    func discoverAndQuery(_ state: ObservationStore) async throws {
        state.discover(); await state.waitForIdle()
        try observationCheck(state.discovery?.items.contains(where: { $0.id == ieee }) == true && state.review == nil, "live discovery: " + state.message)
        state.readEndpoints(ieee); await state.waitForIdle()
        try observationCheck(state.endpoints?.items.contains(where: { $0.id == 1 && (onOff ? $0.supportsOnOff : $0.supportsEnvironment) }) == true && state.device == device, "live endpoints: " + state.message)
        state.queryEndpoint(1); await state.waitForIdle(); try observationCheck(state.canConfirm, "live endpoint query: " + state.message)
        try observationCheck(state.review?.candidate?.profile == (onOff ? .onOff : .environment), "queried write authority")
    }
    func sample() async throws {
        for _ in 0..<100 {
            if let sensor = try await gateway.snapshot().devices.first(where: { $0.id == device }), sensor.ready, sensor.reported[onOff ? "light.power" : "environment.temperature"]?.quality == "confirmed" { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw ObservationCheckFailure.check("live source sample missing")
    }
    let state = try await make()
    if phase == "create" {
        try await discoverAndQuery(state)
        state.confirm(); await state.waitForIdle(); try observationCheck(state.records.first?.pending == true, "real lost response preserved")
        try await sample(); state.close()
        let restored = try await make(); let key = restored.records[0].id
        restored.recover(key); await restored.waitForIdle(); try observationCheck(restored.records[0].status == "applied", "recover actual decision")
        restored.reviewRevoke(device); await restored.waitForIdle(); try observationCheck(restored.canConfirm, "live revoke review")
        restored.confirm(); await restored.waitForIdle(); try observationCheck(restored.bindings.first?.active == false, "live revoke: " + restored.message)
        restored.recover(key); await restored.waitForIdle(); try observationCheck(restored.bindings.first?.active == false, "old applied does not reactivate")
        restored.close()
    } else if phase == "restore" {
        try observationCheck(state.records.count == 2 && state.bindings.first?.active == false, "revoked source survives SQLite and native restart")
        state.recover(state.records[0].id); await state.waitForIdle(); try observationCheck(state.bindings.first?.active == false, "restored old receipt stays historical")
        try await discoverAndQuery(state)
        state.confirm(); await state.waitForIdle(); try observationCheck(state.bindings.first?.active == true, "live rebind: " + state.message)
        try await sample(); state.close()
    } else { throw ObservationCheckFailure.check("invalid phase") }
    let records = try await ObservationClient(gateway: gateway, store: file).records(space: space), posts = await wire.posts, queries = await wire.queries
    let discoveries = await wire.discoveries, endpointQueries = await wire.endpointQueries
    try observationCheck(discoveries == 1 && endpointQueries == 1, "explicit discovery and endpoint query once per phase")
    try observationCheck(posts == (phase == "create" ? 2 : 1) && queries == 1 && records.count == (phase == "create" ? 2 : 3), "exact native decision and query counts")
    let trace = JSONValue.object(["passed": .bool(true), "phase": .string(phase), "host_ui_state": .bool(true), "decision_posts": .integer(posts), "query_posts": .integer(queries), "discovery_posts": .integer(discoveries), "endpoint_posts": .integer(endpointQueries), "records": .array(records.map { .object(["request": $0.request, "result": $0.result ?? .null]) }), "hardware": .bool(false), "native_app_runtime": .bool(false)])
    try Data(ObservationJSON.canonical(trace).utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_OBSERVATION_TRACE"]!))
}
