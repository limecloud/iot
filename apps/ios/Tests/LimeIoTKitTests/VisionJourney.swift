import Foundation
import LimeIoTKit

private enum VisionJourneyFailure: Error { case check(String), lost, storage }
private func visionExpect(_ value: Bool, _ name: String) throws { if !value { throw VisionJourneyFailure.check(name) } }
private func visionObject(_ value: JSONValue) -> [String: JSONValue] { if case .object(let fields) = value { fields } else { [:] } }
private actor VisionFileStore: SessionStore {
    let path: String
    init(_ path: String) { self.path = path }
    func load(origin: String) throws -> Data? { guard origin.hasSuffix("#vision-observations") else { throw VisionJourneyFailure.storage }; return FileManager.default.fileExists(atPath: path) ? try Data(contentsOf: URL(fileURLWithPath: path)) : nil }
    func save(origin: String, data: Data?) throws {
        guard origin.hasSuffix("#vision-observations"), let data else { throw VisionJourneyFailure.storage }
        if !FileManager.default.fileExists(atPath: path) { guard FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw VisionJourneyFailure.storage } }
        let file = try FileHandle(forWritingTo: URL(fileURLWithPath: path)); defer { try? file.close() }
        try file.truncate(atOffset: 0); try file.write(contentsOf: data); try file.synchronize()
    }
}
private actor VisionLiveWire: HTTPTransport {
    let upstream = URLSessionTransport(), drop: Bool
    var posts = 0, otherPosts = 0
    init(drop: Bool) { self.drop = drop }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result = try await upstream.send(request)
        if request.httpMethod == "POST", !request.url!.path.hasSuffix("/auth/session") {
            if request.url!.path.contains("/vision-observations") { posts += 1; if drop && request.url!.path.hasSuffix("/vision-observations") { throw VisionJourneyFailure.lost } }
            else { otherPosts += 1 }
        }
        return result
    }
}
func visionLiveChecks() async throws {
    let env = ProcessInfo.processInfo.environment, phase = env["LIMEIOT_VISION_PHASE"]!, space = "space-demo"
    let vault = VisionFileStore(env["LIMEIOT_VISION_STORE"]!), wire = VisionLiveWire(drop: phase == "create")
    let gateway = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, transport: wire, allowLoopbackHTTP: true); try await gateway.login(token: env["LIMEIOT_TOKEN"]!)
    let client = VisionClient(gateway: gateway, store: vault), bytes = try Data(contentsOf: URL(fileURLWithPath: env["LIMEIOT_VISION_IMAGE"]!)), prompt = "请观察青柠🍋与é，有什么形状？"
    func input(_ record: VisionRecord? = nil) throws -> JSONValue {
        let expires = record.map { visionObject(visionObject($0.original)["input"]!)["expires_at"] }.flatMap { $0 }.flatMap { if case .string(let value) = $0 { value } else { nil } }
        return try VisionRequests.input(bytes: bytes, contentType: "image/png", prompt: prompt, expiresAt: expires)
    }
    try visionExpect(await client.capabilities(space: space).configured, "real capability")
    let restored = try await client.records(space: space); try visionExpect(restored.allSatisfy { $0.text == nil }, "new process restores no plaintext")
    switch phase {
    case "create":
        do { _ = try await client.submit(space: space, input: input(), key: "native-first"); throw VisionJourneyFailure.check("expected lost actual receipt") } catch VisionJourneyFailure.lost {}
        try visionExpect(await client.records(space: space).first?.status == "unresolved", "lost response retains intent")
        var result = try await client.resolve(space: space, key: "native-first")
        for _ in 0..<100 { if result.status != "running" { break }; try await Task.sleep(for: .milliseconds(50)); result = try await client.resolve(space: space, key: "native-first") }
        try visionExpect(result.text == env["LIMEIOT_VISION_TEXT"] && result.status == "succeeded", "real result")
    case "restore":
        try visionExpect(restored.count == 1 && restored[0].status == "succeeded", "same original after gateway restart")
        let result = try await client.submit(space: space, input: input(restored[0]), key: "native-first")
        try visionExpect(result.text == env["LIMEIOT_VISION_TEXT"], "same key only GET")
    case "unknown-start":
        let result = try await client.submit(space: space, input: input(), key: "native-second")
        try visionExpect(result.status == "running", "real in-flight task")
    case "unknown-restore":
        let unknown = try await client.resolve(space: space, key: "native-second"); try visionExpect(unknown.status == "unknown" && unknown.pending, "restart keeps unknown budget")
        do { _ = try await client.submit(space: space, input: input(), key: "replacement"); throw VisionJourneyFailure.check("unknown allowed replacement") } catch let error as VisionError { try visionExpect(error.code == "vision_pending", "pending guard") }
        let discarded = try await client.discard(space: space, key: "native-second", intent: "native-discard")
        try visionExpect(discarded.status == "discarded" && discarded.text == nil, "explicit abandon")
        _ = try await client.discard(space: space, key: "native-second", intent: "native-discard")
    case "clear":
        let cleared = try await client.discard(space: space, key: "native-first", intent: "native-clear")
        try visionExpect(cleared.status == "succeeded" && cleared.text == nil && !cleared.canDiscard, "successful text cleared")
        _ = try await client.discard(space: space, key: "native-first", intent: "native-clear")
    case "cleared-restore":
        let result = try await client.resolve(space: space, key: "native-first")
        try visionExpect(result.text == nil && result.status == "succeeded" && !result.canDiscard, "cleared output remains cleared after restart")
    default: throw VisionJourneyFailure.check("invalid phase")
    }
    let records = try await client.records(space: space), posts = await wire.posts, otherPosts = await wire.otherPosts
    try visionExpect(posts == (["create", "unknown-start", "unknown-restore", "clear"].contains(phase) ? 1 : 0) && otherPosts == 0, "exact POST budget")
    let trace: JSONValue = .object(["passed": .bool(true), "phase": .string(phase), "native_host_library": .bool(true), "vision_posts": .integer(posts), "other_posts": .integer(otherPosts), "records": .array(records.map { .object(["original": $0.original, "observation": $0.observation ?? .null, "discard_intents": .array($0.discardIntents.map(JSONValue.string))]) })])
    try Data(OtaJSON.canonical(trace).utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_VISION_TRACE"]!))
}
