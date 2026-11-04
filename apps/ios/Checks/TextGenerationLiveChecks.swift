import Foundation
import LimeIoTKit

private enum TextLiveFailure: Error { case check(String), lost, storage }
@MainActor private func check(_ value: Bool, _ name: String) throws { if !value { throw TextLiveFailure.check(name) } }
private actor TextFileStore: SessionStore {
    let path: String
    init(_ path: String) { self.path = path }
    func load(origin: String) throws -> Data? { guard origin.hasSuffix("#text-generations") else { throw TextLiveFailure.storage }; return FileManager.default.fileExists(atPath: path) ? try Data(contentsOf: URL(fileURLWithPath: path)) : nil }
    func save(origin: String, data: Data?) throws {
        guard origin.hasSuffix("#text-generations"), let data else { throw TextLiveFailure.storage }
        if !FileManager.default.fileExists(atPath: path) { guard FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw TextLiveFailure.storage } }
        let file = try FileHandle(forWritingTo: URL(fileURLWithPath: path)); defer { try? file.close() }; try file.truncate(atOffset: 0); try file.write(contentsOf: data); try file.synchronize()
    }
}
private actor TextLiveWire: HTTPTransport {
    let upstream = URLSessionTransport(), drop: Bool
    var posts = 0, otherPosts = 0
    init(drop: Bool) { self.drop = drop }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result = try await upstream.send(request)
        if request.httpMethod == "POST", !request.url!.path.hasSuffix("/auth/session") {
            if request.url!.path.contains("/text-generations") { posts += 1; if drop && request.url!.path.hasSuffix("/text-generations") { throw TextLiveFailure.lost } } else { otherPosts += 1 }
        }
        return result
    }
}
@MainActor func textLiveChecks() async throws {
    let env = ProcessInfo.processInfo.environment, phase = env["LIMEIOT_TEXT_NATIVE_PHASE"]!, space = "space-demo"
    let file = TextFileStore(env["LIMEIOT_TEXT_NATIVE_STORE"]!), wire = TextLiveWire(drop: phase == "create")
    let gateway = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, transport: wire, allowLoopbackHTTP: true); try await gateway.login(token: env["LIMEIOT_TOKEN"]!)
    let s = TextGenerationStore(client: TextGenerationClient(gateway: gateway, store: file), space: space, authFailure: { _ in })
    s.refresh(); await s.waitForIdle(); try check(s.ready && s.outputs.isEmpty && s.messages.isEmpty, "restored metadata only: " + s.message)
    if phase == "create" {
        s.setPrompt("请记住青柠🍋与 é"); s.generate(); await s.waitForIdle(); try check(!s.ready && s.records.count == 1 && s.pending, "lost receipt")
        s.recover(s.records[0].id); await s.waitForIdle()
        for _ in 0..<100 { if s.records[0].status != "running" { break }; try await Task.sleep(for: .milliseconds(50)); s.poll(); await s.waitForIdle() }
        try check(s.text(for: s.records[0].id) == env["LIMEIOT_TEXT_NATIVE_TEXT"], "actual verified response: " + s.message)
        try check(s.messages.isEmpty, "lost context not restored implicitly")
    } else if phase == "restore" {
        try check(s.records.count == 1 && s.records[0].status == "succeeded", "same original after process restart")
        s.recover(s.records[0].id); await s.waitForIdle(); try check(s.text(for: s.records[0].id) == env["LIMEIOT_TEXT_NATIVE_TEXT"], "explicit GET restores answer")
    } else if phase == "unknown-start" {
        s.setPrompt("请记住青柠🍋与 é"); s.generate(); await s.waitForIdle(); try check(s.records.count == 2 && s.records.last?.status == "running" && !s.canGenerate, "real pending request")
    } else if phase == "unknown-restore" {
        try check(s.records.last?.status == "unknown" && s.pending, "gateway restart keeps unknown budget")
        s.setPrompt("不可替换"); s.generate(); try check(await wire.posts == 0, "unknown cannot resubmit")
        let key = s.records.last!.id; s.requestDiscard(key); s.cancelDiscard(); s.confirmDiscard(); try check(await wire.posts == 0, "cancel zero POST")
        s.requestDiscard(key); s.confirmDiscard(); await s.waitForIdle(); try check(s.records.last?.status == "discarded", "explicit abandon: " + s.message)
    } else if phase == "clear" {
        let key = s.records[0].id; s.recover(key); await s.waitForIdle(); s.requestDiscard(key); s.cancelDiscard(); s.confirmDiscard(); try check(await wire.posts == 0, "cancel clear zero POST")
        s.requestDiscard(key); s.confirmDiscard(); await s.waitForIdle(); try check(s.outputs.isEmpty && s.messages.isEmpty && !s.records[0].canDiscard && s.records[0].status == "succeeded", "cleared original kept")
    } else if phase == "cleared-restore" {
        s.recover(s.records[0].id); await s.waitForIdle(); try check(s.outputs.isEmpty && !s.records[0].canDiscard, "clear persists through restart")
    } else { throw TextLiveFailure.check("invalid phase") }
    let posts = await wire.posts, other = await wire.otherPosts
    try check(posts == (["create", "unknown-start", "unknown-restore", "clear"].contains(phase) ? 1 : 0) && other == 0, "exact POST budget")
    let trace: JSONValue = .object(["passed": .bool(true), "phase": .string(phase), "host_ui_state": .bool(true), "text_posts": .integer(posts), "other_posts": .integer(other), "records": .array(s.records.map { .object(["original": $0.original, "observation": $0.observation ?? .null]) })])
    try Data(OtaJSON.canonical(trace).utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_TEXT_NATIVE_TRACE"]!)); s.close()
}
