import Foundation
import CryptoKit

public struct TextGenerationError: Error, Sendable {
    public let code: String
    public var message: String {
        switch code {
        case "text_storage_failed", "text_record_changed": "对话记录不可用，已暂停新请求"
        case "text_pending": "请先查询或明确放弃原文字任务"
        case "text_capacity": "本机文字记录已满"
        case "text_busy": "已有对话操作正在处理"
        case "text_unknown": "结果未知，请查询原文字任务"
        case "invalid_text_input": "消息超出上下文限制或格式无效，请缩短消息或开始新对话"
        default: "文字材料或回答未通过校验"
        }
    }
}
public struct TextGenerationMessage: Sendable, Equatable {
    public let role: String
    public let content: String
    public init(role: String, content: String) { self.role = role; self.content = content }
    var document: JSONValue { .object(["role": .string(role), "content": .string(content)]) }
}
public struct TextGenerationCapabilities: Sendable {
    public let document: JSONValue
    public var configured: Bool { MediaJSON.member(document, "configured") == .bool(true) }
}
public struct TextGenerationRecord: Sendable, Identifiable {
    public let original: JSONValue
    // 本机仅保存摘要与去正文观测，消息和回答只存在于当前交互内存。
    public let observation: JSONValue?
    public let rejectedCode: String?
    public let discardIntents: [String]
    public let text: String?
    public var id: String { MediaJSON.string(original, "idempotency_key") }
    public var space: String { MediaJSON.string(original, "space_id") }
    public var status: String { observation.map { MediaJSON.string($0, "status") } ?? (rejectedCode == nil ? "unresolved" : "rejected") }
    public var pending: Bool { ["unresolved", "running", "unknown"].contains(status) }
    public var outputExpiresAt: Date? { observation.flatMap { try? MediaJSON.time(MediaJSON.member(MediaJSON.member($0, "output"), "expires_at")) } }
    public var canDiscard: Bool { ["running", "unknown"].contains(status) || status == "succeeded" && observation.map { MediaJSON.member(MediaJSON.member($0, "output"), "cleared_at") == .null } == true }
    public var statusText: String { ["unresolved": "结果待核实", "running": "正在生成", "succeeded": "回答已完成", "failed": "生成未完成", "unknown": "结果未知", "discarded": "已放弃输出", "rejected": "请求未受理"][status] ?? "结果待核实" }
}
public enum TextGenerationRequests {
    public static func input(messages: [TextGenerationMessage], instructions: String = "", retainSeconds: Int = 600, expiresAt: String? = nil) throws -> JSONValue {
        try checked(.object(["instructions": .string(instructions), "messages": .array(messages.map(\.document)), "retain_seconds": .integer(retainSeconds), "expires_at": .string(expiresAt ?? SpeechJSON.timestamp(Date().addingTimeInterval(85)))]))
    }
    public static func parse(_ text: String) throws -> JSONValue {
        do { return try checked(IntegerJSON.parse(text, maxBytes: 65536, maxDepth: 4, maxNodes: 128)) }
        catch { throw TextGenerationError(code: "invalid_text_input") }
    }
    static func checked(_ value: JSONValue) throws -> JSONValue {
        do {
            var v = try MediaJSON.fields(value, "instructions,messages,retain_seconds,expires_at")
            try TextGenerationJSON.text(v["instructions"], maximum: 1024, empty: true)
            guard case .array(let messages) = v["messages"], (1...15).contains(messages.count), messages.count % 2 == 1 else { throw MediaJSON.fail() }
            var bytes = try MediaJSON.text(v["instructions"]).utf8.count
            for (i, message) in messages.enumerated() {
                let m = try MediaJSON.fields(message, "role,content")
                try MediaJSON.require(m["role"] == .string(i % 2 == 0 ? "user" : "assistant"))
                try TextGenerationJSON.text(m["content"], maximum: 2048)
                bytes += try MediaJSON.text(m["content"]).utf8.count
            }
            try MediaJSON.require(bytes <= 8192); _ = try MediaJSON.integer(v["retain_seconds"], 60, 3600)
            v["expires_at"] = .string(try TextGenerationJSON.requestTime(v["expires_at"]))
            return .object(v)
        } catch { throw TextGenerationError(code: "invalid_text_input") }
    }
}
enum TextGenerationJSON {
    static func digest(_ bytes: Data) -> String { "sha256:" + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    static func text(_ value: JSONValue?, maximum: Int, empty: Bool = false) throws {
        let s = try MediaJSON.text(value), scalars = s.unicodeScalars
        let whitespace = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}"))
        try MediaJSON.require((empty || !s.trimmingCharacters(in: whitespace).isEmpty) && scalars.count <= maximum && s.utf8.count <= 8192 && scalars.allSatisfy { ($0.value >= 32 || [9,10].contains($0.value)) && !(127...159).contains($0.value) })
    }
    static func requestTime(_ value: JSONValue?) throws -> String {
        try MediaJSON.require(MediaJSON.text(value).range(of: #"\.\d{4,}"#, options: .regularExpression) == nil)
        return try SpeechJSON.timestamp(MediaJSON.time(value))
    }
    static func summary(_ value: JSONValue?) throws -> JSONValue {
        var v = try MediaJSON.fields(value, "context_digest,context_bytes,message_count,retain_seconds,expires_at")
        try MediaJSON.hash(v["context_digest"]); _ = try MediaJSON.integer(v["context_bytes"], 1, 8192)
        let count = try MediaJSON.integer(v["message_count"], 1, 15); try MediaJSON.require(count % 2 == 1)
        _ = try MediaJSON.integer(v["retain_seconds"], 60, 3600); v["expires_at"] = .string(try requestTime(v["expires_at"]))
        return .object(v)
    }
    static func summarize(_ input: JSONValue) throws -> JSONValue {
        let v = try MediaJSON.object(input)
        guard case .array(let messages) = v["messages"] else { throw MediaJSON.fail() }
        var bytes = try MediaJSON.text(v["instructions"]).utf8.count
        for message in messages { bytes += try MediaJSON.text(MediaJSON.member(message, "content")).utf8.count }
        return .object(["context_digest": .string(IntegerJSON.digest(.object(["instructions": v["instructions"]!, "messages": v["messages"]!]))), "context_bytes": .integer(bytes), "message_count": .integer(messages.count), "retain_seconds": v["retain_seconds"]!, "expires_at": v["expires_at"]!])
    }
    static func deployment(_ value: JSONValue?) throws {
        let v = try MediaJSON.fields(value, "adapter,revision,model,data_location")
        try MediaJSON.require(v["adapter"] == .string("ollama-text-v1") && v["data_location"] == .string("local")); try MediaJSON.hash(v["revision"])
        try MediaJSON.require(MediaJSON.text(v["model"]).range(of: #"^[A-Za-z0-9_:./-]{1,128}$"#, options: .regularExpression) != nil)
    }
    static func capabilities(_ value: JSONValue) throws -> TextGenerationCapabilities {
        let v = try MediaJSON.object(value)
        if v["configured"] == .bool(false) { _ = try MediaJSON.fields(value, "configured,capability") }
        else {
            _ = try MediaJSON.fields(value, "configured,capability,deployment,max_messages,max_context_bytes,max_instructions_characters,max_text_bytes,max_characters,max_output_tokens,max_deadline_seconds,max_retain_seconds,concurrency,streaming,provider_cancellation,input_storage,server_memory,device_execution")
            try MediaJSON.require(v["configured"] == .bool(true)); try deployment(v["deployment"])
            for (key, number) in ["max_messages": 15, "max_context_bytes": 8192, "max_instructions_characters": 1024, "max_text_bytes": 8192, "max_characters": 2048, "max_output_tokens": 1024, "max_deadline_seconds": 90, "max_retain_seconds": 3600, "concurrency": 1] { try MediaJSON.require(v[key] == .integer(number)) }
            for key in ["streaming", "provider_cancellation", "server_memory", "device_execution"] { try MediaJSON.require(v[key] == .bool(false)) }
            try MediaJSON.require(v["input_storage"] == .string("digest_only"))
        }
        try MediaJSON.require(v["capability"] == .string("text.generate")); return TextGenerationCapabilities(document: value)
    }
    static func original(origin: String, space: String, key: String, input: JSONValue) throws -> JSONValue {
        try MediaJSON.id(.string(space)); try MediaJSON.id(.string(key)); let checked = try summary(input)
        return .object(["version": .integer(1), "origin": .string(origin), "space_id": .string(space), "idempotency_key": .string(key), "input": checked, "request_digest": .string(IntegerJSON.digest(.object(["space_id": .string(space), "idempotency_key": .string(key), "input": checked])))])
    }
    static func original(_ value: JSONValue, origin: String) throws {
        let v = try MediaJSON.fields(value, "version,origin,space_id,idempotency_key,input,request_digest")
        try MediaJSON.require(value == original(origin: origin, space: MediaJSON.text(v["space_id"]), key: MediaJSON.text(v["idempotency_key"]), input: v["input"]!))
    }
    static func metadata(_ value: JSONValue) throws -> JSONValue {
        var v = try MediaJSON.object(value); v["input"] = try summary(v["input"])
        if v["output"] != .null { var output = try MediaJSON.object(v["output"]); output.removeValue(forKey: "text"); v["output"] = .object(output) }
        return .object(v)
    }
    static func task(_ value: JSONValue, original: JSONValue, previous: JSONValue? = nil, stored: Bool = false) throws {
        var v = try MediaJSON.fields(value, "text_id,space_id,idempotency_key,request_digest,input,deployment,created_at,updated_at,status,output,usage,error_code")
        let o = try MediaJSON.object(original); v["input"] = try summary(v["input"])
        try MediaJSON.id(v["text_id"], "text-"); try MediaJSON.require(MediaJSON.text(v["text_id"]).count > 5); try deployment(v["deployment"])
        for key in ["space_id", "idempotency_key", "request_digest", "input"] { try MediaJSON.require(v[key] == o[key]) }
        let start = try MediaJSON.time(v["created_at"]), updated = try MediaJSON.time(v["updated_at"]), end = try MediaJSON.time(MediaJSON.member(o["input"]!, "expires_at"))
        try MediaJSON.require(end > start && end.timeIntervalSince(start) <= 90 && updated >= start)
        if v["usage"] != .null {
            try MediaJSON.require(v["status"] == .string("succeeded")); let usage = try MediaJSON.fields(v["usage"], "input_tokens,output_tokens")
            _ = try MediaJSON.integer(usage["input_tokens"], 0, 65536); _ = try MediaJSON.integer(usage["output_tokens"], 1, 1024)
        }
        switch try MediaJSON.text(v["status"]) {
        case "running": try MediaJSON.require(v["output"] == .null && v["error_code"] == .null && v["created_at"] == v["updated_at"])
        case "succeeded":
            let output = try MediaJSON.fields(v["output"], stored ? "content_digest,expires_at,cleared_at" : "text,content_digest,expires_at,cleared_at")
            try MediaJSON.hash(output["content_digest"]); let retain = try MediaJSON.integer(MediaJSON.member(o["input"]!, "retain_seconds"), 60, 3600)
            try MediaJSON.require(MediaJSON.time(output["expires_at"]).timeIntervalSince(updated) == Double(retain) && v["error_code"] == .null && updated < end)
            if output["cleared_at"] != .null { try MediaJSON.require(MediaJSON.time(output["cleared_at"]) >= updated); if !stored { try MediaJSON.require(output["text"] == .null) } }
            else if !stored { try text(output["text"], maximum: 2048); try MediaJSON.require(output["content_digest"] == .string(digest(Data(MediaJSON.text(output["text"]).utf8)))) }
        case "discarded": try MediaJSON.require(v["output"] == .null && v["error_code"] == .string("text_output_discarded"))
        case "unknown": try MediaJSON.require(v["output"] == .null && ["text_provider_unknown", "text_deadline_exceeded", "text_interrupted"].contains(MediaJSON.text(v["error_code"])))
        case "failed": try MediaJSON.require(v["output"] == .null && ["text_provider_rejected", "invalid_text_output", "text_output_too_large", "text_origin_not_local", "text_provider_unavailable"].contains(MediaJSON.text(v["error_code"])))
        default: throw MediaJSON.fail()
        }
        if let previous {
            let old = try MediaJSON.object(previous), next = try MediaJSON.object(metadata(value)), changing = Set(["status", "updated_at", "output", "usage", "error_code"])
            try MediaJSON.require(old.filter { !changing.contains($0.key) } == next.filter { !changing.contains($0.key) } && updated >= MediaJSON.time(old["updated_at"]))
            switch try MediaJSON.text(old["status"]) {
            case "running": break
            case "unknown": try MediaJSON.require(["unknown", "discarded"].contains(MediaJSON.text(v["status"])))
            case "succeeded":
                let a = try MediaJSON.object(old["output"]), b = try MediaJSON.object(next["output"])
                try MediaJSON.require(old.filter { $0.key != "output" } == next.filter { $0.key != "output" } && a.filter { $0.key != "cleared_at" } == b.filter { $0.key != "cleared_at" })
                if a["cleared_at"] != .null { try MediaJSON.require(a == b) }
            default: try MediaJSON.require(previous == .object(next))
            }
        }
    }
}
