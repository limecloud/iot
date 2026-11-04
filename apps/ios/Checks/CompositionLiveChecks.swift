import Foundation
import LimeIoTKit

private enum CompositionLiveFailure: Error { case check(String), storage, lost }
private func verify(_ value: Bool, _ name: String) throws { if !value { throw CompositionLiveFailure.check(name) } }
private actor CompositionFileStore: SessionStore {
    let path: String
    init(_ path: String) { self.path = path }
    func load(origin: String) throws -> Data? {
        guard origin.hasSuffix("#composition:space-demo") else { throw CompositionLiveFailure.storage }
        return FileManager.default.fileExists(atPath: path) ? try Data(contentsOf: URL(fileURLWithPath: path)) : nil
    }
    func save(origin: String, data: Data?) throws {
        guard origin.hasSuffix("#composition:space-demo"), let data else { throw CompositionLiveFailure.storage }
        if !FileManager.default.fileExists(atPath: path) { guard FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw CompositionLiveFailure.storage } }
        let file = try FileHandle(forWritingTo: URL(fileURLWithPath: path)); defer { try? file.close() }
        try file.truncate(atOffset: 0); try file.write(contentsOf: data); try file.synchronize()
    }
}
private actor CompositionLiveWire: HTTPTransport {
    let upstream = URLSessionTransport(), phase: String
    var posts: [String] = []
    init(_ phase: String) { self.phase = phase }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result = try await upstream.send(request), path = request.url!.path
        if request.httpMethod == "POST", !path.hasSuffix("/auth/session") {
            posts.append(request.url!.lastPathComponent)
            if phase == "deploy-lost", path.hasSuffix("/rule-deployments") { throw CompositionLiveFailure.lost }
        }
        return result
    }
}
@MainActor func compositionLiveChecks() async throws {
    let env = ProcessInfo.processInfo.environment, phase = env["LIMEIOT_COMPOSITION_PHASE"]!
    let file = CompositionFileStore(env["LIMEIOT_COMPOSITION_STORE"]!), wire = CompositionLiveWire(phase)
    let gateway = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, transport: wire, allowLoopbackHTTP: true)
    try await gateway.login(token: env["LIMEIOT_TOKEN"]!)
    let client = try CompositionClient(gateway: gateway, store: file, space: "space-demo")
    let state = CompositionStore(client: client, authFailure: { _ in })
    state.updateDevices(try await gateway.snapshot().devices); state.refresh(); await state.waitForIdle()
    if phase == "deploy" || phase == "deploy-lost" {
        try verify(state.record == nil, "fresh original")
        state.bind("touch", device: "device-button"); state.bind("light", device: "device-lamp"); await state.waitForIdle()
        state.plan(); await state.waitForIdle(); try verify(state.canDeploy, "actual plan: " + state.message)
        state.deploy(); await state.waitForIdle()
        try verify(state.record?.state == (phase == "deploy" ? "acknowledged" : "attempted"), "actual submit: " + state.message)
        try verify(await wire.posts == ["rules:validate", "rules:simulate", "rule-deployments"], "single POST budget")
    } else if phase == "query-stop" || phase == "query-stopped" {
        let original = state.record!.json; state.query(); await state.waitForIdle()
        try verify(state.record?.json == original && !state.canDeploy, "original unchanged after GET")
        let status = try await client.resolve()
        if phase == "query-stop" { guard let deployment = status.deployment else { throw CompositionLiveFailure.check("deployment missing") }; try await gateway.stop(space: "space-demo", deployment: deployment) }
        else { try verify(status.deployment == nil, "current stopped") }
        try verify(await wire.posts == (phase == "query-stop" ? ["stop"] : []), "restored process no deployment")
    } else { throw CompositionLiveFailure.check("unknown phase") }
    let trace: JSONValue = .object(["passed": .bool(true), "phase": .string(phase), "host_ui_state": .bool(true), "record": state.record!.document, "posts": .array(await wire.posts.map(JSONValue.string))])
    try Data(OtaJSON.canonical(trace).utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_COMPOSITION_TRACE"]!))
    state.close(); await state.waitForIdle()
}
