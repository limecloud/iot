import Foundation
import CryptoKit

public struct TranscriptionError: Error, Sendable {
    public let code: String
    public var message: String {
        switch code {
        case "transcription_storage_failed", "transcription_record_changed": "识别记录不可用，已暂停新请求"
        case "transcription_pending": "请先查询或明确放弃原识别任务"
        case "transcription_capacity": "本机识别记录已满"
        case "transcription_busy": "已有识别操作正在处理"
        case "transcription_unknown": "结果未知，请查询原识别任务"
        case "invalid_transcription_input": "请选择可用的音频并检查识别语言"
        default: "识别材料或响应未通过校验"
        }
    }
}
public struct TranscriptionCapabilities: Sendable {
    public let document: JSONValue
    public var configured: Bool { MediaJSON.member(document, "configured") == .bool(true) }
}
public struct TranscriptionRecord: Sendable, Identifiable {
    public let original: JSONValue
    // observation 为去除 output.text 的任务元数据；不能当作服务器任务提交。
    public let observation: JSONValue?
    public let rejectedCode: String?
    public let discardIntents: [String]
    public let text: String?
    public var id: String { MediaJSON.string(original, "idempotency_key") }
    public var space: String { MediaJSON.string(original, "space_id") }
    public var status: String { observation.map { MediaJSON.string($0, "status") } ?? (rejectedCode == nil ? "unresolved" : "rejected") }
    public var pending: Bool { ["unresolved", "running", "unknown"].contains(status) }
    public var outputExpiresAt: Date? { observation.flatMap { try? MediaJSON.time(MediaJSON.member(MediaJSON.member($0, "output"), "expires_at")) } }
    public var statusText: String { ["unresolved": "结果待核实", "running": "正在识别", "succeeded": "识别完成", "failed": "识别失败", "unknown": "结果未知", "discarded": "已放弃输出", "rejected": "请求未受理"][status] ?? "结果待核实" }
}
public enum TranscriptionRequests {
    public static func input(mediaId: String, mediaDigest: String, language: String = "auto", expiresAt: String? = nil) throws -> JSONValue {
        try parse(IntegerJSON.canonical(.object(["media_id": .string(mediaId), "media_digest": .string(mediaDigest), "language": .string(language), "expires_at": .string(expiresAt ?? SpeechJSON.timestamp(Date().addingTimeInterval(85)))])))
    }
    public static func parse(_ text: String) throws -> JSONValue {
        do {
            let value = try IntegerJSON.parse(text, maxBytes: 4096, maxDepth: 3, maxNodes: 32)
            var v = try MediaJSON.fields(value, "media_id,media_digest,language,expires_at")
            try MediaJSON.id(v["media_id"], "media-"); try MediaJSON.hash(v["media_digest"])
            try MediaJSON.require(["auto", "zh", "en"].contains(MediaJSON.text(v["language"])))
            try MediaJSON.require(MediaJSON.text(v["expires_at"]).range(of: #"\.\d{4,}"#, options: .regularExpression) == nil)
            v["expires_at"] = .string(SpeechJSON.timestamp(try MediaJSON.time(v["expires_at"])))
            return .object(v)
        } catch { throw TranscriptionError(code: "invalid_transcription_input") }
    }
}
enum TranscriptionJSON {
    static func deployment(_ value: JSONValue?) throws {
        let v = try MediaJSON.fields(value, "adapter,revision,model,data_location")
        try MediaJSON.require(v["adapter"] == .string("local-http-transcription-v1") && v["data_location"] == .string("local"))
        try MediaJSON.hash(v["revision"])
        try MediaJSON.require(MediaJSON.text(v["model"]).range(of: #"^[A-Za-z0-9_:./-]{1,128}$"#, options: .regularExpression) != nil)
    }
    static func capabilities(_ value: JSONValue) throws -> TranscriptionCapabilities {
        let v = try MediaJSON.object(value)
        if v["configured"] == .bool(false) { _ = try MediaJSON.fields(value, "configured,capability") }
        else {
            _ = try MediaJSON.fields(value, "configured,capability,deployment,languages,concurrency,max_audio_bytes,max_audio_seconds,max_text_bytes,max_characters,max_deadline_seconds,streaming,provider_cancellation")
            try MediaJSON.require(v["configured"] == .bool(true)); try deployment(v["deployment"])
            try MediaJSON.require(v["languages"] == .array([.string("auto"), .string("zh"), .string("en")]))
            for (name, number) in ["concurrency": 1, "max_audio_bytes": 4194304, "max_audio_seconds": 60, "max_text_bytes": 8192, "max_characters": 2048, "max_deadline_seconds": 90] { try MediaJSON.require(v[name] == .integer(number)) }
            try MediaJSON.require(v["streaming"] == .bool(false) && v["provider_cancellation"] == .bool(false))
        }
        try MediaJSON.require(v["capability"] == .string("audio.transcribe")); return TranscriptionCapabilities(document: value)
    }
    static func original(origin: String, space: String, key: String, input: JSONValue) throws -> JSONValue {
        try MediaJSON.id(.string(space)); try MediaJSON.id(.string(key))
        return .object(["version": .integer(1), "origin": .string(origin), "space_id": .string(space), "idempotency_key": .string(key), "input": input,
                        "request_digest": .string(IntegerJSON.digest(.object(["space_id": .string(space), "idempotency_key": .string(key), "input": input])))])
    }
    static func original(_ value: JSONValue, origin: String) throws {
        let v = try MediaJSON.fields(value, "version,origin,space_id,idempotency_key,input,request_digest")
        let input = try TranscriptionRequests.parse(IntegerJSON.canonical(v["input"]!))
        try MediaJSON.require(v["version"] == .integer(1) && v["origin"] == .string(origin) && value == original(origin: origin, space: MediaJSON.text(v["space_id"]), key: MediaJSON.text(v["idempotency_key"]), input: input))
    }
    static func metadata(_ value: JSONValue) throws -> JSONValue {
        var v = try MediaJSON.object(value)
        v["input"] = try TranscriptionRequests.parse(IntegerJSON.canonical(v["input"]!))
        if v["output"] != .null { var output = try MediaJSON.object(v["output"]); output.removeValue(forKey: "text"); v["output"] = .object(output) }
        return .object(v)
    }
    static func task(_ value: JSONValue, original: JSONValue, previous: JSONValue? = nil, stored: Bool = false) throws {
        var v = try MediaJSON.fields(value, "transcription_id,space_id,idempotency_key,request_digest,input,deployment,created_at,updated_at,status,output,error_code")
        let o = try MediaJSON.object(original)
        v["input"] = try TranscriptionRequests.parse(IntegerJSON.canonical(v["input"]!))
        try MediaJSON.id(v["transcription_id"], "transcription-"); try deployment(v["deployment"])
        for key in ["space_id", "idempotency_key", "request_digest", "input"] { try MediaJSON.require(v[key] == o[key]) }
        let start = try MediaJSON.time(v["created_at"]), updated = try MediaJSON.time(v["updated_at"]), end = try MediaJSON.time(MediaJSON.member(o["input"]!, "expires_at"))
        try MediaJSON.require(end > start && end.timeIntervalSince(start) <= 90 && updated >= start)
        switch try MediaJSON.text(v["status"]) {
        case "running": try MediaJSON.require(v["output"] == .null && v["error_code"] == .null && v["created_at"] == v["updated_at"])
        case "succeeded":
            let output = try MediaJSON.fields(v["output"], stored ? "content_digest,expires_at,cleared_at" : "text,content_digest,expires_at,cleared_at")
            try MediaJSON.hash(output["content_digest"])
            let expiry = try MediaJSON.time(output["expires_at"])
            try MediaJSON.require(expiry > updated && expiry <= start.addingTimeInterval(86400) && v["error_code"] == .null && updated < end)
            if output["cleared_at"] != .null { try MediaJSON.require(MediaJSON.time(output["cleared_at"]) >= updated); if !stored { try MediaJSON.require(output["text"] == .null) } }
            else if !stored {
                let text = try MediaJSON.text(output["text"])
                try MediaJSON.require(text.unicodeScalars.count <= 2048 && text.utf8.count <= 8192 && text.unicodeScalars.allSatisfy { ($0.value >= 32 || [9, 10].contains($0.value)) && !(127...159).contains($0.value) })
                let digest = "sha256:" + SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
                try MediaJSON.require(output["content_digest"] == .string(digest))
            }
        case "discarded": try MediaJSON.require(v["output"] == .null && v["error_code"] == .string("transcription_output_discarded"))
        case "unknown": try MediaJSON.require(v["output"] == .null && ["transcription_provider_unknown", "transcription_deadline_exceeded", "transcription_interrupted"].contains(MediaJSON.text(v["error_code"])))
        case "failed": try MediaJSON.require(v["output"] == .null && ["transcription_provider_rejected", "invalid_transcription_output", "transcription_output_too_large", "transcription_source_unavailable", "transcription_origin_not_local", "transcription_provider_unavailable"].contains(MediaJSON.text(v["error_code"])))
        default: throw MediaJSON.fail()
        }
        if let previous {
            let old = try MediaJSON.object(previous), next = try metadata(value), n = try MediaJSON.object(next), changing = Set(["status", "updated_at", "output", "error_code"])
            try MediaJSON.require(old.filter { !changing.contains($0.key) } == n.filter { !changing.contains($0.key) } && updated >= MediaJSON.time(old["updated_at"]))
            switch try MediaJSON.text(old["status"]) {
            case "running": break
            case "unknown": try MediaJSON.require(["unknown", "discarded"].contains(MediaJSON.text(v["status"])))
            case "succeeded":
                let a = try MediaJSON.object(old["output"]), b = try MediaJSON.object(n["output"])
                try MediaJSON.require(old.filter { $0.key != "output" } == n.filter { $0.key != "output" } && a.filter { $0.key != "cleared_at" } == b.filter { $0.key != "cleared_at" })
                if a["cleared_at"] != .null { try MediaJSON.require(a == b) }
            default: try MediaJSON.require(previous == next)
            }
        }
    }
}
