import Foundation

public struct VoiceTurnError: Error, Sendable {
    public let code: String
    public var message: String {
        switch code {
        case "voice_turn_record_unavailable": "语音回合记录不可用，已暂停新请求"
        case "voice_turn_pending", "voice_turn_busy": "请先查询或停止原语音回合"
        case "voice_turn_not_configured", "voice_turn_configuration_changed": "语音服务未就绪或配置已变化"
        case "voice_turn_source_unavailable": "原录音已不可用"
        case "voice_turn_text_unavailable": "原文字已清除或到期"
        case "voice_turn_answer_not_speakable": "回答超出语音合成限制，请使用原文字回答"
        case "voice_turn_not_found": "暂无语音回合"
        default: "语音回合结果未知，请查询原回合"
        }
    }
}
public struct VoiceTurnRecord: Sendable {
    public let document: JSONValue
    public var id: String { MediaJSON.string(document, "turn_id") }
    public var stopped: Bool { MediaJSON.member(document, "stopped") == .bool(true) }
    public var expiresAt: Date { get throws { try VoiceTurnJSON.time(MediaJSON.member(document, "expires_at")) } }
    public static func parse(_ text: String, origin: String, space: String, contextual: Bool = false) throws -> VoiceTurnRecord {
        do {
            let value = try IntegerJSON.parse(text, maxBytes: 32768, maxDepth: 8, maxNodes: 512)
            try VoiceTurnJSON.record(value, origin: origin, space: space, contextual: contextual)
            return VoiceTurnRecord(document: value)
        } catch { throw VoiceTurnError(code: "voice_turn_record_unavailable") }
    }
}
public struct VoiceTurnView: Sendable {
    public let record: VoiceTurnRecord
    public let phase: String
    public let stage: String?
    public let transcript: String?
    public let answer: String?
    public let mediaID: String?
    public init(record: VoiceTurnRecord, phase: String, stage: String?, transcript: String?, answer: String?, mediaID: String?) {
        self.record = record; self.phase = phase; self.stage = stage; self.transcript = transcript; self.answer = answer; self.mediaID = mediaID
    }
}
public struct VoiceTurnCapabilities: Sendable {
    public let transcription: TranscriptionCapabilities
    public let text: TextGenerationCapabilities
    public let speech: SpeechCapabilities
    public var configured: Bool { transcription.configured && text.configured && speech.configured }
    func revision(_ kind: String) -> JSONValue {
        let document = kind == "transcription" ? transcription.document : kind == "text" ? text.document : speech.document
        return MediaJSON.member(MediaJSON.member(document, "deployment"), "revision")
    }
}
public struct VoiceTextContext: Sendable {
    public let instructions: String
    public let history: [TextGenerationMessage]
    public init(instructions: String, history: [TextGenerationMessage]) throws {
        guard history.count <= 14, history.count % 2 == 0 else { throw VoiceTurnError(code: "invalid_voice_turn_context") }
        do { _ = try TextGenerationRequests.input(messages: history + [.init(role: "user", content: "_")], instructions: instructions, expiresAt: "2030-01-01T00:00:00.000Z") }
        catch { throw VoiceTurnError(code: "invalid_voice_turn_context") }
        self.instructions = instructions; self.history = history
    }
    public static func parse(_ text: String) throws -> VoiceTextContext {
        do {
            let v = try MediaJSON.fields(IntegerJSON.parse(text, maxBytes: 32768, maxDepth: 4, maxNodes: 128), "instructions,history")
            guard case .array(let values) = v["history"] else { throw MediaJSON.fail() }
            return try .init(instructions: MediaJSON.text(v["instructions"]), history: values.map {
                let m = try MediaJSON.fields($0, "role,content"); return try .init(role: MediaJSON.text(m["role"]), content: MediaJSON.text(m["content"]))
            })
        } catch { throw VoiceTurnError(code: "invalid_voice_turn_context") }
    }
    var document: JSONValue { .object(["instructions": .string(instructions), "history": .array(history.map(\.document))]) }
}
public enum VoiceTurnRequests {
    public static func input(turnID: String, mediaID: String, language: String = "zh", voice: String) throws -> JSONValue {
        let input: JSONValue = .object(["turn_id": .string(turnID), "media_id": .string(mediaID), "language": .string(language), "voice": .string(voice)])
        return try checked(input)
    }
    static func checked(_ value: JSONValue) throws -> JSONValue {
        do {
            let v = try MediaJSON.fields(value, "turn_id,media_id,language,voice")
            for key in ["turn_id", "media_id", "voice"] { try MediaJSON.id(v[key]) }
            try MediaJSON.require(MediaJSON.text(v["turn_id"]).count <= 96 && MediaJSON.text(v["voice"]).count <= 64 && MediaJSON.text(v["media_id"]).hasPrefix("media-") && ["auto", "zh", "en"].contains(MediaJSON.text(v["language"])))
            return value
        } catch { throw VoiceTurnError(code: "invalid_voice_turn_request") }
    }
}

// 与网页/CLI共用v1摘要账本格式；正文不进入该文档。
enum VoiceTurnJSON {
    static let kinds = ["transcription", "text", "speech"]
    static let instructions = "请根据用户的语音内容，用简短、清晰的中文回答。回答不超过300字，不调用工具。"
    static func family(_ kind: String) -> String { kind == "transcription" ? "audio-transcriptions" : kind == "text" ? "text-generations" : "speech-syntheses" }
    static func time(_ value: JSONValue?) throws -> Date {
        let text = try MediaJSON.text(value)
        try MediaJSON.require(text.range(of: #"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$"#, options: .regularExpression) != nil)
        return try MediaJSON.time(value)
    }
    static func pending(_ observation: JSONValue) -> Bool { observation == .null || ["running", "unknown"].contains(MediaJSON.string(observation, "status")) }
    static func job(_ record: JSONValue, _ kind: String) -> JSONValue { MediaJSON.member(MediaJSON.member(record, "jobs"), kind) }
    static func settingJob(_ record: JSONValue, _ kind: String, _ value: JSONValue) throws -> JSONValue {
        var body = try MediaJSON.object(record), jobs = try MediaJSON.object(body["jobs"])
        jobs[kind] = value; body["jobs"] = .object(jobs); return .object(body)
    }
    static func observation(_ value: JSONValue) throws {
        let v = try MediaJSON.fields(value, "identity_digest,terminal_digest,status,updated_at,output,media_id")
        try MediaJSON.hash(v["identity_digest"]); if v["terminal_digest"] != .null { try MediaJSON.hash(v["terminal_digest"]) }
        try MediaJSON.require(["running", "succeeded", "failed", "unknown", "discarded"].contains(MediaJSON.text(v["status"]))); _ = try time(v["updated_at"])
        if v["media_id"] != .null { try MediaJSON.id(v["media_id"]); try MediaJSON.require(MediaJSON.text(v["media_id"]).hasPrefix("media-")) }
        if v["output"] != .null {
            let output = try MediaJSON.fields(v["output"], "content_digest,expires_at,cleared_at")
            try MediaJSON.hash(output["content_digest"]); _ = try time(output["expires_at"])
            if output["cleared_at"] != .null { _ = try time(output["cleared_at"]) }
        }
    }
    static func record(_ value: JSONValue, origin: String, space: String, contextual: Bool = false) throws {
        let withContext = contextual && MediaJSON.member(value, "version") == .integer(2)
        var v = try MediaJSON.fields(value, "version,origin,space_id,turn_id,created_at,expires_at,source,language,voice,retain_seconds,deployments,jobs,stopped,checksum" + (withContext ? ",text_context" : ""))
        try MediaJSON.require((v["version"] == .integer(1) || withContext) && v["origin"] == .string(origin) && v["space_id"] == .string(space) && v["retain_seconds"] == .integer(600))
        if withContext {
            let context = try MediaJSON.fields(v["text_context"], "digest,history_messages")
            try MediaJSON.hash(context["digest"]); let count = try MediaJSON.integer(context["history_messages"], 0, 14); try MediaJSON.require(count % 2 == 0)
        }
        try MediaJSON.id(.string(space)); try MediaJSON.id(v["turn_id"]); try MediaJSON.id(v["voice"])
        try MediaJSON.require(MediaJSON.text(v["voice"]).count <= 64 && ["auto", "zh", "en"].contains(MediaJSON.text(v["language"])))
        let start = try time(v["created_at"]), end = try time(v["expires_at"]), source = try MediaJSON.fields(v["source"], "media_id,content_digest,expires_at")
        try MediaJSON.id(source["media_id"]); try MediaJSON.hash(source["content_digest"])
        try MediaJSON.require(MediaJSON.text(source["media_id"]).hasPrefix("media-") && end > start && (end.timeIntervalSince1970 * 1000).rounded() - (start.timeIntervalSince1970 * 1000).rounded() <= 300000 && end <= time(source["expires_at"]))
        _ = try MediaJSON.bool(v["stopped"])
        let deployments = try MediaJSON.fields(v["deployments"], "transcription,text,speech"), jobs = try MediaJSON.fields(v["jobs"], "transcription,text,speech")
        for kind in kinds { try MediaJSON.hash(deployments[kind]) }
        let checksum = v.removeValue(forKey: "checksum")!; try MediaJSON.hash(checksum); try MediaJSON.require(checksum == .string(IntegerJSON.digest(.object(v))))
        for (index, kind) in kinds.enumerated() {
            guard jobs[kind] != .null else { continue }
            let entry = try MediaJSON.fields(jobs[kind], "original,observation,rejected_code,discard_attempted"), original = entry["original"]!, o = try MediaJSON.object(original)
            if kind == "transcription" { try TranscriptionJSON.original(original, origin: origin) }
            else if kind == "text" { try TextGenerationJSON.original(original, origin: origin) }
            else { try SpeechJSON.original(original, origin: origin) }
            try MediaJSON.require(o["space_id"] == .string(space) && o["idempotency_key"] == .string(MediaJSON.text(v["turn_id"]) + "-" + kind))
            let discard = try MediaJSON.bool(entry["discard_attempted"])
            try MediaJSON.require(!discard || v["stopped"] == .bool(true))
            if entry["rejected_code"] != .null { try MediaJSON.require(MediaJSON.text(entry["rejected_code"]).range(of: #"^[a-z][a-z0-9_]{0,63}$"#, options: .regularExpression) != nil) }
            if index > 0 { try MediaJSON.require(MediaJSON.member(MediaJSON.member(jobs[kinds[index - 1]]!, "observation"), "status") == .string("succeeded")) }
            if entry["observation"] != .null {
                let observed = entry["observation"]!; try observation(observed)
                let succeeded = MediaJSON.member(observed, "status") == .string("succeeded"), terminal = ["succeeded", "failed", "discarded"].contains(MediaJSON.string(observed, "status"))
                try MediaJSON.require((MediaJSON.member(observed, "terminal_digest") != .null) == terminal && (MediaJSON.member(observed, "output") != .null) == (succeeded && kind != "speech") && (MediaJSON.member(observed, "media_id") != .null) == (succeeded && kind == "speech") && entry["rejected_code"] == .null)
            }
            if kind == "transcription" { let input = try MediaJSON.object(o["input"]); try MediaJSON.require(input["media_id"] == source["media_id"] && input["media_digest"] == source["content_digest"] && input["language"] == v["language"]) }
            if kind == "text" { let input = try MediaJSON.object(o["input"]); try MediaJSON.require(input["message_count"] == .integer(withContext ? (try MediaJSON.integer(MediaJSON.member(v["text_context"]!, "history_messages"), 0, 14)) + 1 : 1) && input["retain_seconds"] == .integer(600)) }
            if kind == "speech" { try MediaJSON.require(o["voice"] == v["voice"] && o["retain_seconds"] == .integer(600)) }
        }
    }
    static func observe(_ task: JSONValue, kind: String, previous: JSONValue) throws -> JSONValue {
        let t = try MediaJSON.object(task), identityKey = kind == "transcription" ? "transcription_id" : kind == "text" ? "text_id" : "synthesis_id"
        let identity: JSONValue = .object(["id": t[identityKey]!, "request_digest": t["request_digest"]!, "deployment": t["deployment"]!, "created_at": t["created_at"]!])
        let taskOutput = t["output"] ?? .null
        let terminal: JSONValue = .object(["status": t["status"]!, "updated_at": t["updated_at"]!, "error_code": t["error_code"]!, "usage": t["usage"] ?? .null, "media_id": t["media_id"] ?? .null, "output": taskOutput == .null ? .null : .object(["content_digest": MediaJSON.member(taskOutput, "content_digest"), "expires_at": MediaJSON.member(taskOutput, "expires_at")])])
        var output = JSONValue.null
        if taskOutput != .null {
            let cleared = MediaJSON.member(taskOutput, "cleared_at")
            output = .object(["content_digest": MediaJSON.member(taskOutput, "content_digest"), "expires_at": .string(try SpeechJSON.timestamp(MediaJSON.time(MediaJSON.member(taskOutput, "expires_at")))), "cleared_at": cleared == .null ? .null : .string(try SpeechJSON.timestamp(MediaJSON.time(cleared)))])
        }
        let next: JSONValue = .object(["identity_digest": .string(IntegerJSON.digest(identity)), "terminal_digest": ["succeeded", "failed", "discarded"].contains(MediaJSON.string(task, "status")) ? .string(IntegerJSON.digest(terminal)) : .null, "status": t["status"]!, "updated_at": .string(try SpeechJSON.timestamp(MediaJSON.time(t["updated_at"]))), "output": output, "media_id": t["media_id"] ?? .null])
        if previous != .null {
            let p = try MediaJSON.object(previous), n = try MediaJSON.object(next), before = MediaJSON.string(previous, "status"), after = MediaJSON.string(next, "status")
            try MediaJSON.require(p["identity_digest"] == n["identity_digest"] && (p["terminal_digest"] == .null || p["terminal_digest"] == n["terminal_digest"]) && time(n["updated_at"]) >= time(p["updated_at"]) && (!["succeeded", "failed", "discarded"].contains(before) || before == after) && (before != "unknown" || ["unknown", "discarded"].contains(after)) && (p["media_id"] == .null || p["media_id"] == n["media_id"]))
            if p["output"] != .null {
                let old = try MediaJSON.object(p["output"]), current = try MediaJSON.object(n["output"])
                try MediaJSON.require(old["content_digest"] == current["content_digest"] && old["expires_at"] == current["expires_at"] && (old["cleared_at"] == .null || old["cleared_at"] == current["cleared_at"]))
            }
        }
        return next
    }
}
