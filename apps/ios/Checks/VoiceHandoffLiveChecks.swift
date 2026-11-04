import Foundation
import LimeIoTKit

private enum VoiceCheckError: Error { case check(String) }
@MainActor private func expect(_ value: Bool, _ name: String) throws { if !value { throw VoiceCheckError.check(name) } }
private actor VoiceVault: SessionStore {
    let directory: URL
    init(_ directory: String) { self.directory = URL(fileURLWithPath: directory) }
    private func file(_ origin: String) throws -> URL {
        guard let name = ["media-operations", "audio-transcriptions", "text-generations", "speech-syntheses"].first(where: { origin.hasSuffix("#" + $0) }) else { throw VoiceCheckError.check("journal domain") }
        return directory.appendingPathComponent(name + ".json")
    }
    func load(origin: String) throws -> Data? { let url = try file(origin); return FileManager.default.fileExists(atPath: url.path) ? try Data(contentsOf: url) : nil }
    func save(origin: String, data: Data?) throws {
        let url = try file(origin); guard let data else { throw VoiceCheckError.check("unexpected removal") }
        if !FileManager.default.fileExists(atPath: url.path) { guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw VoiceCheckError.check("journal create") } }
        let file = try FileHandle(forWritingTo: url); defer { try? file.close() }
        try file.truncate(atOffset: 0); try file.write(contentsOf: data); try file.synchronize()
    }
}
private actor VoiceWire: HTTPTransport {
    let upstream = URLSessionTransport()
    var posts: [String] = []
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        if request.httpMethod == "POST", !request.url!.path.hasSuffix("/auth/session") { posts.append(request.url!.lastPathComponent) }
        return try await upstream.send(request)
    }
}
@MainActor private final class VoiceInput: RecordingInput {
    var samples: (@Sendable ([Int16]) -> Void)?
    var starts = 0, closes = 0
    func start(samples: @escaping @Sendable ([Int16]) -> Void, interrupted: @escaping @Sendable () -> Void) { starts += 1; self.samples = samples }
    func close() { closes += 1 }
}
@main struct VoiceHandoffChecks {
    @MainActor static func waitFor(_ condition: () -> Bool, _ poll: () async -> Void) async throws {
        for _ in 0..<200 { if condition() { return }; await poll(); try await Task.sleep(for: .milliseconds(50)) }
        try expect(condition(), "stage did not complete")
    }
    @MainActor static func main() async throws {
        let env = ProcessInfo.processInfo.environment, phase = env["LIMEIOT_VOICE_NATIVE_PHASE"]!, space = "space-demo"
        let wire = VoiceWire(), vault = VoiceVault(env["LIMEIOT_VOICE_NATIVE_STORE"]!)
        let gateway = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, transport: wire, allowLoopbackHTTP: true); try await gateway.login(token: env["LIMEIOT_TOKEN"]!)
        let media = MediaStore(client: MediaClient(gateway: gateway, store: vault), space: space, authFailure: { _ in })
        let transcription = TranscriptionStore(client: TranscriptionClient(gateway: gateway, store: vault), media: MediaClient(gateway: gateway, store: vault), space: space, authFailure: { _ in })
        let text = TextGenerationStore(client: TextGenerationClient(gateway: gateway, store: vault), space: space, authFailure: { _ in })
        let speech = SpeechStore(client: SpeechClient(gateway: gateway, store: vault), space: space, authFailure: { _ in }, onGenerated: { await media.useGenerated($0) })
        media.refresh(); await media.waitForIdle(); transcription.refresh(); await transcription.waitForIdle(); text.refresh(); await text.waitForIdle(); speech.refresh(); await speech.waitForIdle()
        try expect(media.ready && transcription.ready && text.ready && speech.ready, "all native stores ready")
        let input = VoiceInput()
        let recorder = RecordingStore(factory: { input }, completed: media.selectRecording, cleared: media.clearRecording); recorder.setAvailable(true)
        if phase == "create" {
            recorder.authorize(recorder.request()!, granted: true); for _ in 0..<10 { input.samples?([Int16](repeating: 321, count: 1600)) }; recorder.finish()
            try expect(input.closes == 1 && media.canUpload, "recording prepared"); try expect(await wire.posts.isEmpty, "recording zero POST")
            media.setRetention(600); media.upload(); await media.waitForIdle(); try expect(media.ready, media.message)
            let record = media.records.first { $0.type == "media.upload" }!
            guard case .object(let decision) = record.result, case .object(let result) = decision["result"], case .object(let source) = result["media"], case .string(let sourceID) = source["media_id"] else { throw VoiceCheckError.check("upload result") }
            transcription.refresh(); await transcription.waitForIdle(); transcription.selectMedia(sourceID); transcription.selectLanguage("zh"); transcription.generate(); await transcription.waitForIdle()
            try await waitFor({ transcription.records.last?.status == "succeeded" }, { transcription.poll(); await transcription.waitForIdle() })
            let recognized = transcription.text(for: transcription.records.last!.id)!
            let beforeText = await wire.posts.count; try expect(text.prepareQuestion(recognized) && text.prompt == recognized && text.messages.isEmpty, "ASR to fresh question")
            try expect(await wire.posts.count == beforeText, "preparing question zero POST"); text.generate(); await text.waitForIdle()
            try await waitFor({ text.records.last?.status == "succeeded" }, { text.poll(); await text.waitForIdle() })
            let answer = text.text(for: text.records.last!.id)!, beforeSpeech = await wire.posts.count
            try expect(speech.prepareAnswer(answer) && speech.text == answer, "answer to speech draft")
            try expect(await wire.posts.count == beforeSpeech, "preparing speech zero POST"); speech.generate(); await speech.waitForIdle()
            try await waitFor({ speech.records.last?.status == "succeeded" }, { speech.poll(); await speech.waitForIdle() })
            try expect(media.selectedMedia == speech.records.last!.mediaId && !media.approved, "generated media selected without permission")
            try expect(try await gateway.snapshot().commands.items.isEmpty, "models never command devices")
            media.approve(true); media.grant(); await media.waitForIdle(); try expect(media.ready && !media.approved, "separate explicit grant")
            let device = try await gateway.snapshot().devices.first { $0.id == "device-lamp" }!
            var command = try await gateway.create(space: space, intent: CommandIntent(device: device, path: "playback.play", value: .object(["media_id": .string(speech.records.last!.mediaId!)]), type: "action.invoke"))
            for _ in 0..<50 { if command.status == "confirmed" { break }; try await Task.sleep(for: .milliseconds(100)); command = try await gateway.command(space: space, id: command.commandId) }
            try expect(command.status == "confirmed", "separate playback confirmed")
        } else {
            try expect(input.starts == 0 && text.prompt.isEmpty && text.messages.isEmpty && speech.text.isEmpty && transcription.outputs.isEmpty && text.outputs.isEmpty && !media.approved, "new process has no restored drafts or automatic handoff")
            try expect(media.page!.grants.allSatisfy { !$0.active }, "restart does not restore grants")
            for record in media.records { media.recover(record.id); await media.waitForIdle() }
            transcription.recover(transcription.records[0].id); await transcription.waitForIdle(); text.recover(text.records[0].id); await text.waitForIdle(); speech.recover(speech.records[0].id); await speech.waitForIdle()
            try expect(text.prompt.isEmpty && speech.text.isEmpty && !media.approved && text.messages.isEmpty, "explicit reads do not prepare next stage")
        }
        let posts = await wire.posts
        try expect(transcription.records.count == 1 && text.records.count == 1 && speech.records.count == 1 && media.records.count == 2, "one native request per stage")
        let trace = JSONValue.object(["passed": .bool(true), "phase": .string(phase), "posts": .array(posts.map(JSONValue.string)), "recording_starts": .integer(input.starts), "recording_closes": .integer(input.closes), "transcription_key": .string(transcription.records[0].id), "text_key": .string(text.records[0].id), "speech_key": .string(speech.records[0].id), "generated_media": .string(speech.records[0].mediaId!), "host_ui_state": .bool(true), "system_microphone": .bool(false), "native_app_runtime": .bool(false)])
        recorder.close(); media.close(); transcription.close(); text.close(); speech.close()
        try Data(trace.jsonText.utf8).write(to: URL(fileURLWithPath: env["LIMEIOT_VOICE_NATIVE_TRACE"]!))
    }
}
