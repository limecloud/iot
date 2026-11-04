import Foundation
import LimeIoTKit

private enum VoiceLiveFailure: Error { case check(String), lost, storage }
private func verify(_ condition: Bool, _ name: String) throws { if !condition { throw VoiceLiveFailure.check(name) } }
private actor VoiceFileStore: SessionStore {
    let path: String
    init(_ path: String) { self.path = path }
    func load(origin: String) throws -> Data? {
        guard origin.hasSuffix("#voice-turns:space-demo") else { throw VoiceLiveFailure.storage }
        return FileManager.default.fileExists(atPath: path) ? try Data(contentsOf: URL(fileURLWithPath: path)) : nil
    }
    func save(origin: String, data: Data?) throws {
        guard origin.hasSuffix("#voice-turns:space-demo"), let data else { throw VoiceLiveFailure.storage }
        if !FileManager.default.fileExists(atPath: path) { guard FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw VoiceLiveFailure.storage } }
        let file = try FileHandle(forWritingTo: URL(fileURLWithPath: path)); defer { try? file.close() }
        try file.truncate(atOffset: 0); try file.write(contentsOf: data); try file.synchronize()
    }
}
private actor VoiceLiveWire: HTTPTransport {
    let upstream = URLSessionTransport(), phase: String
    var posts: [String] = [], other = 0
    init(_ phase: String) { self.phase = phase }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result = try await upstream.send(request), path = request.url!.path
        if request.httpMethod == "POST", !path.hasSuffix("/auth/session") {
            guard let kind = ["audio-transcriptions", "text-generations", "speech-syntheses"].first(where: { path.contains("/" + $0) }) else { other += 1; throw VoiceLiveFailure.check("unexpected effect") }
            posts.append(path.hasSuffix("/discard") ? "discard" : kind)
            if phase == "create" && path.hasSuffix("/audio-transcriptions") || phase == "restore-stop" && path.hasSuffix("/discard") { throw VoiceLiveFailure.lost }
        }
        return result
    }
}
@MainActor func voiceTurnLiveChecks() async throws {
    let env = ProcessInfo.processInfo.environment, phase = env["LIMEIOT_VOICE_NATIVE_PHASE"]!
    let file = VoiceFileStore(env["LIMEIOT_VOICE_NATIVE_STORE"]!), wire = VoiceLiveWire(phase)
    let g = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, transport: wire, allowLoopbackHTTP: true); try await g.login(token: env["LIMEIOT_TOKEN"]!)
    let s = VoiceTurnStore(client: try VoiceTurnClient(gateway: g, store: file, space: "space-demo"), space: "space-demo", authFailure: { _ in })
    s.refresh(); await s.waitForIdle(); try verify(s.ready && s.visible?.answer == nil && s.visible?.transcript == nil && s.visible?.mediaID == nil, "restore summary only: " + s.message)
    if phase == "create" {
        s.selectMedia(env["LIMEIOT_VOICE_NATIVE_MEDIA"]!); s.selectVoice("local"); s.start(); await s.waitForIdle()
        try verify(!s.ready && s.record != nil, "lost ASR receipt keeps original")
        for _ in 0..<100 { s.recover(); await s.waitForIdle(); if s.view?.phase != "running" { break }; try await Task.sleep(for: .milliseconds(50)) }
        try verify(s.view?.phase == "ready" && s.canContinue, "ASR resolved without next stage: " + s.message)
    } else if phase == "resume" {
        try verify(s.canContinue && s.visible?.transcript == nil, "restart requires explicit continue")
        s.poll(); await s.waitForIdle(); try verify(await wire.posts.isEmpty, "restore no automatic progression")
        s.continueTurn(); await s.waitForIdle()
        for _ in 0..<100 { if s.view?.phase != "running" { break }; try await Task.sleep(for: .milliseconds(50)); s.poll(); await s.waitForIdle() }
        try verify(s.view?.phase == "succeeded" && s.visible?.answer == env["LIMEIOT_VOICE_NATIVE_ANSWER"] && s.visible?.mediaID != nil, "complete actual three-stage result: " + s.message)
    } else if phase == "restore-stop" {
        s.recover(); await s.waitForIdle(); try verify(s.visible?.answer == env["LIMEIOT_VOICE_NATIVE_ANSWER"] && s.visible?.mediaID != nil, "explicit GET restores completed result")
        s.requestStop(); s.cancelStop(); s.confirmStop(); try verify(await wire.posts.isEmpty, "cancel stop zero POST")
        s.requestStop(); s.confirmStop(); await s.waitForIdle(); try verify(!s.ready && s.visible == nil, "lost discard receipt hides body")
        s.recover(); await s.waitForIdle(); s.requestStop(); s.confirmStop(); await s.waitForIdle()
        try verify(s.view?.phase == "stopped" && s.visible == nil, "stop resolved by GET only")
    } else if phase == "cleared" {
        s.recover(); await s.waitForIdle(); s.poll(); await s.waitForIdle(); try verify(s.view?.phase == "stopped" && s.visible == nil, "cleared state survives restart")
    } else { throw VoiceLiveFailure.check("invalid phase") }
    let posts = await wire.posts, expected = phase == "create" ? ["audio-transcriptions"] : phase == "resume" ? ["text-generations", "speech-syntheses"] : phase == "restore-stop" ? ["discard"] : []
    let other = await wire.other; try verify(posts == expected && other == 0, "exact POST budget")
    let trace: JSONValue = .object(["passed": .bool(true), "phase": .string(phase), "posts": .array(posts.map(JSONValue.string)), "record": s.record!.document, "host_ui_state": .bool(true)])
    try Data(OtaJSON.canonical(trace).utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_VOICE_NATIVE_TRACE"]!)); s.close()
}
