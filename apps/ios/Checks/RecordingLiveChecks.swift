import Foundation
import LimeIoTKit

private enum RecordingLiveError: Error { case check(String), lost }
@MainActor private func expect(_ value: Bool, _ name: String) throws { if !value { throw RecordingLiveError.check(name) } }
private actor RecordingVault: SessionStore {
    let path: URL
    init(_ path: String) { self.path = URL(fileURLWithPath: path) }
    func load(origin: String) throws -> Data? { FileManager.default.fileExists(atPath: path.path) ? try Data(contentsOf: path) : nil }
    func save(origin: String, data: Data?) throws {
        guard let data else { throw RecordingLiveError.check("unexpected removal") }
        if !FileManager.default.fileExists(atPath: path.path) { guard FileManager.default.createFile(atPath: path.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw RecordingLiveError.check("store create") } }
        let file = try FileHandle(forWritingTo: path); defer { try? file.close() }
        try file.truncate(atOffset: 0); try file.write(contentsOf: data); try file.synchronize()
    }
}
private actor RecordingWire: HTTPTransport {
    let upstream = URLSessionTransport(), drop: Bool
    var posts = 0, gets = 0, other = 0
    init(drop: Bool) { self.drop = drop }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result = try await upstream.send(request), path = request.url!.path
        if request.httpMethod == "POST", path.hasSuffix("/media-operations") { posts += 1; if drop { throw RecordingLiveError.lost } }
        else if request.httpMethod == "POST", !path.hasSuffix("/auth/session") { other += 1 }
        if request.httpMethod == "GET", path.contains("/media-operations/by-key/") { gets += 1 }
        return result
    }
}
@MainActor private final class RecordingLiveInput: RecordingInput {
    var samples: (@Sendable ([Int16]) -> Void)?
    var closes = 0
    func start(samples: @escaping @Sendable ([Int16]) -> Void, interrupted: @escaping @Sendable () -> Void) { self.samples = samples }
    func close() { closes += 1 }
}
@MainActor func recordingLiveChecks() async throws {
    let env = ProcessInfo.processInfo.environment, phase = env["LIMEIOT_RECORDING_NATIVE_PHASE"]!
    let wire = RecordingWire(drop: phase == "create"), vault = RecordingVault(env["LIMEIOT_RECORDING_NATIVE_STORE"]!)
    let gateway = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, transport: wire, allowLoopbackHTTP: true)
    try await gateway.login(token: env["LIMEIOT_TOKEN"]!)
    let media = MediaStore(client: MediaClient(gateway: gateway, store: vault), space: "space-demo", authFailure: { _ in })
    media.refresh(); await media.waitForIdle(); try expect(media.ready, "media ready")
    let input = RecordingLiveInput(); var opened = 0
    let recorder = RecordingStore(factory: { opened += 1; return input }, completed: media.selectRecording, cleared: media.clearRecording)
    recorder.setAvailable(true)
    if phase == "create" {
        recorder.authorize(recorder.request()!, granted: true)
        for _ in 0..<10 { input.samples?([Int16](repeating: 321, count: 1600)) }
        try expect(await wire.posts == 0, "no upload during capture"); recorder.finish()
        try expect(!recorder.busy && input.closes == 1 && media.fileName == "recording.wav", "capture stopped and selection retained")
        try expect(await wire.posts == 0 && !FileManager.default.fileExists(atPath: env["LIMEIOT_RECORDING_NATIVE_STORE"]!), "completion neither sends nor persists audio")
        media.setRetention(600); media.upload(); await media.waitForIdle()
        let count = await wire.posts
        try expect(!media.ready && media.records.count == 1 && media.records[0].result == nil && count == 1, "lost upload receipt keeps original")
    } else {
        try expect(media.records.count == 1 && media.fileName.isEmpty && opened == 0, "new process does not record again")
        media.upload(); try expect(await wire.posts == 0, "no upload without in-memory selection")
    }
    media.recover(media.records[0].id); await media.waitForIdle()
    let gets = await wire.gets
    try expect(media.ready && gets > 0 && media.records[0].result != nil && media.page!.grants.isEmpty, "original GET recovery without authorization")
    try expect(try await gateway.snapshot().commands.items.isEmpty, "no implicit device commands")
    let record = media.records[0]
    recorder.close(); media.close(); media.upload()
    let posts = await wire.posts, other = await wire.other
    try expect(posts == (phase == "create" ? 1 : 0) && other == 0, "only explicit upload")
    let trace = JSONValue.object(["passed": .bool(true), "phase": .string(phase), "posts": .integer(posts), "other_posts": .integer(other), "gets": .integer(await wire.gets), "input_opened": .integer(opened), "input_closed": .integer(input.closes), "original": record.original, "result": record.result!, "host_ui_state": .bool(true), "system_microphone": .bool(false), "native_app_runtime": .bool(false)])
    try Data(trace.jsonText.utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_RECORDING_NATIVE_TRACE"]!))
}
