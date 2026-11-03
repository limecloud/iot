import Foundation
import CryptoKit

public struct SpeechError: Error, Sendable {
    public let code: String
    public var message: String {
        switch code {
        case "speech_storage_failed", "speech_record_changed": "语音记录不可用，已暂停新请求"
        case "speech_pending": "请先查询或明确放弃原语音任务"
        case "speech_capacity": "本机语音记录已满"
        case "speech_busy": "已有语音操作正在处理"
        case "speech_unknown": "结果未知，请查询原语音任务"
        case "invalid_speech_input": "请填写1000字以内的文本，并检查声音和保留时间"
        default: "语音材料或响应未通过校验"
        }
    }
}
public struct SpeechCapabilities: Sendable {
    public let document: JSONValue
    public var configured: Bool { MediaJSON.member(document, "configured") == .bool(true) }
    public var voices: [String] { if case .array(let items) = MediaJSON.member(document, "voices") { items.compactMap { try? MediaJSON.text($0) } } else { [] } }
}
public struct SpeechRecord: Sendable, Identifiable {
    public let original: JSONValue
    public let result: JSONValue?
    public let rejectedCode: String?
    public let discardIntents: [String]
    public var id: String { MediaJSON.string(original, "idempotency_key") }
    public var space: String { MediaJSON.string(original, "space_id") }
    public var status: String { result.map { MediaJSON.string($0, "status") } ?? (rejectedCode == nil ? "unresolved" : "rejected") }
    public var pending: Bool { ["unresolved", "running", "unknown"].contains(status) }
    public var mediaId: String? { guard let result, case .string(let id) = MediaJSON.member(result, "media_id") else { return nil }; return id }
    public var statusText: String { ["unresolved": "结果待核实", "running": "正在生成", "succeeded": "生成完成", "failed": "生成失败", "unknown": "结果未知", "discarded": "已放弃输出", "rejected": "请求未受理"][status] ?? "结果待核实" }
}
public enum SpeechRequests {
    public static func input(text: String, voice: String, retainSeconds: Int = 600, expiresAt: String? = nil) throws -> JSONValue {
        try parse(IntegerJSON.canonical(.object(["text": .string(text), "voice": .string(voice), "retain_seconds": .integer(retainSeconds), "expires_at": .string(expiresAt ?? SpeechJSON.timestamp(Date().addingTimeInterval(85)))])))
    }
    public static func parse(_ text: String) throws -> JSONValue {
        do {
            let value = try IntegerJSON.parse(text, maxBytes: 8192, maxDepth: 3, maxNodes: 32), v = try MediaJSON.fields(value, "text,voice,retain_seconds,expires_at")
            let input = try MediaJSON.text(v["text"]), scalars = input.unicodeScalars
            let whitespace = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}"))
            try MediaJSON.require(!input.trimmingCharacters(in: whitespace).isEmpty && scalars.count <= 1000 && input.utf8.count <= 4096 && scalars.allSatisfy { ($0.value >= 32 || [9, 10].contains($0.value)) && !(127...159).contains($0.value) })
            try SpeechJSON.voice(v["voice"]); _ = try MediaJSON.integer(v["retain_seconds"], 60, 86400)
            let time = try MediaJSON.text(v["expires_at"])
            try MediaJSON.require(time.range(of: #"\.\d{4,}"#, options: .regularExpression) == nil)
            var normalized = v; normalized["expires_at"] = .string(SpeechJSON.timestamp(try MediaJSON.time(v["expires_at"])))
            return .object(normalized)
        } catch { throw SpeechError(code: "invalid_speech_input") }
    }
}
enum SpeechJSON {
    static func timestamp(_ date: Date) -> String { let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; format.timeZone = TimeZone(secondsFromGMT: 0); return format.string(from: date) }
    static func voice(_ value: JSONValue?) throws { try MediaJSON.id(value); try MediaJSON.require(MediaJSON.text(value).utf8.count <= 64) }
    static func deployment(_ value: JSONValue?) throws {
        let v = try MediaJSON.fields(value, "adapter,revision,model,data_location")
        try MediaJSON.require(v["adapter"] == .string("local-http-speech-v1") && v["data_location"] == .string("local"))
        try MediaJSON.hash(v["revision"])
        try MediaJSON.require(MediaJSON.text(v["model"]).range(of: #"^[A-Za-z0-9_:./-]{1,128}$"#, options: .regularExpression) != nil)
    }
    static func capabilities(_ value: JSONValue) throws -> SpeechCapabilities {
        let v = try MediaJSON.object(value)
        if v["configured"] == .bool(false) { _ = try MediaJSON.fields(value, "configured,capability") }
        else {
            _ = try MediaJSON.fields(value, "configured,capability,deployment,voices,concurrency,max_text_bytes,max_characters,max_output_bytes,max_audio_seconds,max_deadline_seconds,streaming,provider_cancellation")
            try MediaJSON.require(v["configured"] == .bool(true)); try deployment(v["deployment"])
            guard case .array(let voices) = v["voices"], (1...32).contains(voices.count) else { throw MediaJSON.fail() }
            for item in voices { try voice(item) }
            try MediaJSON.require(Set(try voices.map { try MediaJSON.text($0) }).count == voices.count)
            for (name, number) in ["concurrency": 1, "max_text_bytes": 4096, "max_characters": 1000, "max_output_bytes": 4194304, "max_audio_seconds": 60, "max_deadline_seconds": 90] { try MediaJSON.require(v[name] == .integer(number)) }
            try MediaJSON.require(v["streaming"] == .bool(false) && v["provider_cancellation"] == .bool(false))
        }
        try MediaJSON.require(v["capability"] == .string("audio.synthesize")); return SpeechCapabilities(document: value)
    }
    static func original(origin: String, space: String, key: String, input: JSONValue) throws -> JSONValue {
        try MediaJSON.id(.string(space)); try MediaJSON.id(.string(key))
        let v = try MediaJSON.object(input), text = try MediaJSON.text(v["text"])
        return .object(["version": .integer(1), "origin": .string(origin), "space_id": .string(space), "idempotency_key": .string(key),
                        "request_digest": .string(IntegerJSON.digest(.object(["space_id": .string(space), "idempotency_key": .string(key), "input": input]))),
                        "input_digest": .string("sha256:" + SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()),
                        "input_characters": .integer(text.unicodeScalars.count), "voice": v["voice"]!, "retain_seconds": v["retain_seconds"]!, "expires_at": v["expires_at"]!])
    }
    static func original(_ value: JSONValue, origin: String) throws {
        let v = try MediaJSON.fields(value, "version,origin,space_id,idempotency_key,request_digest,input_digest,input_characters,voice,retain_seconds,expires_at")
        try MediaJSON.require(v["version"] == .integer(1) && v["origin"] == .string(origin))
        try MediaJSON.id(v["space_id"]); try MediaJSON.id(v["idempotency_key"]); try MediaJSON.hash(v["request_digest"]); try MediaJSON.hash(v["input_digest"])
        _ = try MediaJSON.integer(v["input_characters"], 1, 1000); try voice(v["voice"]); _ = try MediaJSON.integer(v["retain_seconds"], 60, 86400); _ = try MediaJSON.time(v["expires_at"])
    }
    static func task(_ value: JSONValue, original: JSONValue, previous: JSONValue? = nil) throws {
        let v = try MediaJSON.fields(value, "synthesis_id,space_id,idempotency_key,request_digest,input_digest,input_characters,voice,retain_seconds,expires_at,deployment,created_at,updated_at,status,media_id,error_code"), o = try MediaJSON.object(original)
        try MediaJSON.id(v["synthesis_id"], "speech-"); try deployment(v["deployment"])
        for key in ["space_id", "idempotency_key", "request_digest", "input_digest", "input_characters", "voice", "retain_seconds"] { try MediaJSON.require(v[key] == o[key]) }
        let start = try MediaJSON.time(v["created_at"]), end = try MediaJSON.time(v["expires_at"]), updated = try MediaJSON.time(v["updated_at"])
        try MediaJSON.require(end == MediaJSON.time(o["expires_at"]) && end > start && end.timeIntervalSince(start) <= 90 && updated >= start)
        switch try MediaJSON.text(v["status"]) {
        case "running": try MediaJSON.require(v["media_id"] == .null && v["error_code"] == .null && v["created_at"] == v["updated_at"])
        case "succeeded": try MediaJSON.id(v["media_id"], "media-"); try MediaJSON.require(v["error_code"] == .null && updated < end)
        case "discarded": try MediaJSON.require(v["media_id"] == .null && v["error_code"] == .string("speech_output_discarded"))
        case "unknown": try MediaJSON.require(v["media_id"] == .null && ["speech_provider_unknown", "speech_deadline_exceeded", "speech_interrupted"].contains(MediaJSON.text(v["error_code"])))
        case "failed": try MediaJSON.require(v["media_id"] == .null && ["speech_provider_rejected", "invalid_speech_audio", "speech_output_too_large", "speech_output_unavailable", "speech_origin_not_local", "speech_provider_unavailable"].contains(MediaJSON.text(v["error_code"])))
        default: throw MediaJSON.fail()
        }
        if let previous {
            let old = try MediaJSON.object(previous), changing = Set(["status", "updated_at", "media_id", "error_code"])
            try MediaJSON.require(old.filter { !changing.contains($0.key) } == v.filter { !changing.contains($0.key) } && updated >= MediaJSON.time(old["updated_at"]))
            let status = try MediaJSON.text(old["status"])
            if status == "unknown" { try MediaJSON.require(["unknown", "discarded"].contains(MediaJSON.text(v["status"]))) }
            else if status != "running" { try MediaJSON.require(previous == value) }
        }
    }
}
