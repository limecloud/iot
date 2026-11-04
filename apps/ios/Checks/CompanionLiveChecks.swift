import Foundation
import LimeIoTKit

private enum CompanionLiveFailure: Error { case check(String), lost, storage }
private func verify(_ valid: Bool, _ name: String) throws { if !valid { throw CompanionLiveFailure.check(name) } }
private actor CompanionFileStore: SessionStore {
    let path: String
    init(_ path: String) { self.path = path }
    func load(origin: String) throws -> Data? {
        guard origin.hasSuffix("#companion:space-demo") else { throw CompanionLiveFailure.storage }
        return FileManager.default.fileExists(atPath: path) ? try Data(contentsOf: URL(fileURLWithPath: path)) : nil
    }
    func save(origin: String, data: Data?) throws {
        guard origin.hasSuffix("#companion:space-demo"), let data else { throw CompanionLiveFailure.storage }
        if !FileManager.default.fileExists(atPath: path) { guard FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw CompanionLiveFailure.storage } }
        let file = try FileHandle(forWritingTo: URL(fileURLWithPath: path)); defer { try? file.close() }
        try file.truncate(atOffset: 0); try file.write(contentsOf: data); try file.synchronize()
    }
}
private actor CompanionLiveWire: HTTPTransport {
    let upstream = URLSessionTransport(), phase: String
    var posts: [String] = [], lost = false
    init(_ phase: String) { self.phase = phase }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result = try await upstream.send(request), path = request.url!.path
        if request.httpMethod == "POST", !path.hasSuffix("/auth/session") {
            guard let kind = ["audio-transcriptions", "text-generations", "speech-syntheses"].first(where: { path.contains("/" + $0) }) else { throw CompanionLiveFailure.check("unexpected endpoint") }
            posts.append(path.hasSuffix("/discard") ? "discard" : kind)
            if phase == "restore-stop", path.hasSuffix("/discard"), !lost { lost = true; throw CompanionLiveFailure.lost }
        }
        return result
    }
}
@MainActor func companionLiveChecks() async throws {
    let env = ProcessInfo.processInfo.environment, phase = env["LIMEIOT_COMPANION_NATIVE_PHASE"]!
    let file = CompanionFileStore(env["LIMEIOT_COMPANION_NATIVE_STORE"]!), wire = CompanionLiveWire(phase)
    let g = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, transport: wire, allowLoopbackHTTP: true); try await g.login(token: env["LIMEIOT_TOKEN"]!)
    let s = CompanionStore(client: try CompanionClient(gateway: g, store: file, space: "space-demo"), space: "space-demo", authFailure: { _ in })
    s.refresh(); await s.waitForIdle(); try verify(s.ready && s.visible?.answer == nil && s.visible?.mediaID == nil, "restore summary only: " + s.message)
    if phase == "two-turns" {
        s.selectVoice("local"); s.start(); await s.waitForIdle(); try verify(s.view?.phase == "ready", "start: " + s.message)
        try verify(await wire.posts.isEmpty, "start zero inference")
        for index in 1...2 {
            s.selectMedia(env["LIMEIOT_COMPANION_NATIVE_MEDIA"]!); try verify(s.canReply, "explicit next recording enabled")
            s.reply(); await s.waitForIdle()
            for _ in 0..<100 { if s.view?.phase != "running" { break }; try await Task.sleep(for: .milliseconds(50)); s.poll(); await s.waitForIdle() }
            try verify(s.view?.phase == "succeeded" && s.visible?.answer == env["LIMEIOT_COMPANION_NATIVE_ANSWER"] && s.visible?.mediaID != nil && s.record?.turnCount == index, "actual turn: " + s.message)
        }
        s.pause(); await s.waitForIdle(); s.refresh(); await s.waitForIdle()
        try verify(s.view?.historyAvailable == false && !s.canReply && !s.canContinue && s.visible?.answer == nil, "background clears context")
    } else if phase == "restore-stop" {
        try verify(s.view?.historyAvailable == false && !s.canContinue && !s.canReply, "new process has no history")
        s.poll(); await s.waitForIdle(); try verify(await wire.posts.isEmpty, "restore GET only")
        s.recover(); await s.waitForIdle(); try verify(s.visible?.answer == env["LIMEIOT_COMPANION_NATIVE_ANSWER"], "explicit GET original answer")
        s.requestStop(); s.cancelStop(); s.confirmStop(); try verify(await wire.posts.isEmpty, "cancel stop zero POST")
        s.requestStop(); s.confirmStop(); await s.waitForIdle(); try verify(!s.ready && s.visible == nil, "lost discard receipt stays hidden")
        s.recover(); await s.waitForIdle(); s.requestStop(); s.confirmStop(); await s.waitForIdle()
        try verify(s.view?.stopSettled == true && s.visible == nil, "both original answers cleared")
    } else if phase == "cleared" {
        s.recover(); await s.waitForIdle(); s.poll(); await s.waitForIdle(); try verify(s.view?.stopSettled == true && s.visible == nil, "stopped survives restart")
    } else { throw CompanionLiveFailure.check("invalid phase") }
    let posts = await wire.posts, expected = phase == "two-turns" ? ["audio-transcriptions", "text-generations", "speech-syntheses", "audio-transcriptions", "text-generations", "speech-syntheses"] : phase == "restore-stop" ? ["discard", "discard"] : []
    try verify(posts == expected, "exact POST budget")
    let trace: JSONValue = .object(["passed": .bool(true), "phase": .string(phase), "posts": .array(posts.map(JSONValue.string)), "record": s.record!.document, "host_ui_state": .bool(true)])
    try Data(OtaJSON.canonical(trace).utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_COMPANION_NATIVE_TRACE"]!)); s.close(); await s.waitForIdle()
}
