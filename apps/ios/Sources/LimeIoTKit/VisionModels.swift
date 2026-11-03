import Foundation
import CryptoKit

public struct VisionError: Error, Sendable {
    public let code: String
    public var message: String {
        switch code {
        case "vision_storage_failed", "vision_record_changed": "图片观察记录不可用，已暂停新请求"
        case "vision_pending": "请先查询或明确放弃原观察任务"
        case "vision_capacity": "本机观察记录已满"
        case "vision_busy": "已有观察操作正在处理"
        case "vision_unknown": "结果未知，请查询原观察任务"
        case "invalid_vision_input": "请选择不超过2 MiB的PNG或JPEG，并检查问题"
        default: "观察材料或响应未通过校验"
        }
    }
}
public struct VisionCapabilities: Sendable {
    public let document: JSONValue
    public var configured: Bool { MediaJSON.member(document, "configured") == .bool(true) }
}
public struct VisionRecord: Sendable, Identifiable {
    public let original: JSONValue
    // 仅保存摘要及去除 output.text 的观测，原图、问题与结果正文不进入本机账本。
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
    public var statusText: String { ["unresolved": "结果待核实", "running": "正在观察", "succeeded": "观察完成", "failed": "观察失败", "unknown": "结果未知", "discarded": "已放弃输出", "rejected": "请求未受理"][status] ?? "结果待核实" }
}
public enum VisionRequests {
    public static let maxImageBytes = 2 * 1024 * 1024
    public static func contentType(of bytes: Data) throws -> String {
        guard (3...maxImageBytes).contains(bytes.count) else { throw VisionError(code: "invalid_vision_input") }
        if bytes.starts(with: [137,80,78,71,13,10,26,10]) { return "image/png" }
        if bytes.starts(with: [255,216,255]) { return "image/jpeg" }
        throw VisionError(code: "invalid_vision_input")
    }
    public static func validatePrompt(_ prompt: String) throws {
        do { try VisionJSON.text(.string(prompt), characters: 512, bytes: 2048) }
        catch { throw VisionError(code: "invalid_vision_input") }
    }
    public static func input(bytes: Data, contentType: String, prompt: String, retainSeconds: Int = 600, expiresAt: String? = nil) throws -> JSONValue {
        guard bytes.count <= maxImageBytes else { throw VisionError(code: "invalid_vision_input") }
        return try checked(.object(["image_base64": .string(bytes.base64EncodedString()), "content_type": .string(contentType), "prompt": .string(prompt), "retain_seconds": .integer(retainSeconds), "expires_at": .string(expiresAt ?? SpeechJSON.timestamp(Date().addingTimeInterval(85)))]))
    }
    public static func parse(_ text: String) throws -> JSONValue {
        do { return try checked(IntegerJSON.parse(text, maxBytes: 2_804_396, maxDepth: 3, maxNodes: 32)) }
        catch { throw VisionError(code: "invalid_vision_input") }
    }
    static func checked(_ value: JSONValue) throws -> JSONValue {
        do {
            var v = try MediaJSON.fields(value, "image_base64,content_type,prompt,retain_seconds,expires_at")
            let encoded = try MediaJSON.text(v["image_base64"]), type = try MediaJSON.text(v["content_type"])
            try MediaJSON.require(encoded.utf8.count <= 2_796_204 && ["image/png", "image/jpeg"].contains(type))
            guard let bytes = Data(base64Encoded: encoded), bytes.base64EncodedString() == encoded else { throw MediaJSON.fail() }
            try MediaJSON.require(contentType(of: bytes) == type)
            try VisionJSON.text(v["prompt"], characters: 512, bytes: 2048)
            _ = try MediaJSON.integer(v["retain_seconds"], 60, 3600)
            v["expires_at"] = .string(try VisionJSON.requestTime(v["expires_at"]))
            return .object(v)
        } catch { throw VisionError(code: "invalid_vision_input") }
    }
}
enum VisionJSON {
    static func digest(_ bytes: Data) -> String { "sha256:" + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    static func text(_ value: JSONValue?, characters: Int, bytes: Int) throws {
        let text = try MediaJSON.text(value)
        try MediaJSON.require(!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.unicodeScalars.count <= characters && text.utf8.count <= bytes && text.unicodeScalars.allSatisfy { ($0.value >= 32 || [9,10].contains($0.value)) && !(127...159).contains($0.value) })
    }
    static func requestTime(_ value: JSONValue?) throws -> String {
        try MediaJSON.require(MediaJSON.text(value).range(of: #"\.\d{4,}"#, options: .regularExpression) == nil)
        return try SpeechJSON.timestamp(MediaJSON.time(value))
    }
    static func summary(_ value: JSONValue?) throws -> JSONValue {
        var v = try MediaJSON.fields(value, "image_digest,image_bytes,content_type,prompt_digest,retain_seconds,expires_at")
        try MediaJSON.hash(v["image_digest"]); try MediaJSON.hash(v["prompt_digest"])
        _ = try MediaJSON.integer(v["image_bytes"], 1, VisionRequests.maxImageBytes); _ = try MediaJSON.integer(v["retain_seconds"], 60, 3600)
        try MediaJSON.require(["image/png", "image/jpeg"].contains(MediaJSON.text(v["content_type"])))
        v["expires_at"] = .string(try requestTime(v["expires_at"])); return .object(v)
    }
    static func summarize(_ input: JSONValue) throws -> JSONValue {
        let v = try MediaJSON.object(input), bytes = Data(base64Encoded: try MediaJSON.text(v["image_base64"]))!
        return .object(["image_digest": .string(digest(bytes)), "image_bytes": .integer(bytes.count), "content_type": v["content_type"]!, "prompt_digest": .string(digest(Data(try MediaJSON.text(v["prompt"]).utf8))), "retain_seconds": v["retain_seconds"]!, "expires_at": v["expires_at"]!])
    }
    static func deployment(_ value: JSONValue?) throws {
        let v = try MediaJSON.fields(value, "adapter,revision,model,data_location")
        try MediaJSON.require(v["adapter"] == .string("ollama-vision-v1") && v["data_location"] == .string("local")); try MediaJSON.hash(v["revision"])
        try MediaJSON.require(MediaJSON.text(v["model"]).range(of: #"^[A-Za-z0-9_:./-]{1,128}$"#, options: .regularExpression) != nil)
    }
    static func capabilities(_ value: JSONValue) throws -> VisionCapabilities {
        let v = try MediaJSON.object(value)
        if v["configured"] == .bool(false) { _ = try MediaJSON.fields(value, "configured,capability") }
        else {
            _ = try MediaJSON.fields(value, "configured,capability,deployment,content_types,max_image_bytes,max_edge,max_prompt_characters,max_text_bytes,max_characters,max_deadline_seconds,max_retain_seconds,concurrency,streaming,provider_cancellation,input_storage,device_execution")
            try MediaJSON.require(v["configured"] == .bool(true)); try deployment(v["deployment"])
            try MediaJSON.require(v["content_types"] == .array([.string("image/png"), .string("image/jpeg")]))
            for (key, number) in ["max_image_bytes": 2097152, "max_edge": 1024, "max_prompt_characters": 512, "max_text_bytes": 8192, "max_characters": 2048, "max_deadline_seconds": 90, "max_retain_seconds": 3600, "concurrency": 1] { try MediaJSON.require(v[key] == .integer(number)) }
            try MediaJSON.require(v["streaming"] == .bool(false) && v["provider_cancellation"] == .bool(false) && v["device_execution"] == .bool(false) && v["input_storage"] == .string("digest_only"))
        }
        try MediaJSON.require(v["capability"] == .string("vision.understand")); return VisionCapabilities(document: value)
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
        var v = try MediaJSON.fields(value, "vision_id,space_id,idempotency_key,request_digest,input,image,deployment,created_at,updated_at,status,output,error_code")
        v["input"] = try summary(v["input"]); let o = try MediaJSON.object(original)
        try MediaJSON.id(v["vision_id"], "vision-"); try MediaJSON.require(MediaJSON.text(v["vision_id"]).count > 7); try deployment(v["deployment"])
        let image = try MediaJSON.fields(v["image"], "width,height")
        for key in ["width", "height"] { _ = try MediaJSON.integer(image[key], 1, 1024) }
        for key in ["space_id", "idempotency_key", "request_digest", "input"] { try MediaJSON.require(v[key] == o[key]) }
        let start = try MediaJSON.time(v["created_at"]), updated = try MediaJSON.time(v["updated_at"]), end = try MediaJSON.time(MediaJSON.member(o["input"]!, "expires_at"))
        try MediaJSON.require(end > start && end.timeIntervalSince(start) <= 90 && updated >= start)
        switch try MediaJSON.text(v["status"]) {
        case "running": try MediaJSON.require(v["output"] == .null && v["error_code"] == .null && v["created_at"] == v["updated_at"])
        case "succeeded":
            let output = try MediaJSON.fields(v["output"], stored ? "content_digest,expires_at,cleared_at" : "text,content_digest,expires_at,cleared_at")
            try MediaJSON.hash(output["content_digest"])
            let retain = try MediaJSON.integer(MediaJSON.member(o["input"]!, "retain_seconds"), 60, 3600)
            try MediaJSON.require(MediaJSON.time(output["expires_at"]).timeIntervalSince(updated) == Double(retain) && v["error_code"] == .null && updated < end)
            if output["cleared_at"] != .null { try MediaJSON.require(MediaJSON.time(output["cleared_at"]) >= updated); if !stored { try MediaJSON.require(output["text"] == .null) } }
            else if !stored { try text(output["text"], characters: 2048, bytes: 8192); try MediaJSON.require(output["content_digest"] == .string(digest(Data(MediaJSON.text(output["text"]).utf8)))) }
        case "discarded": try MediaJSON.require(v["output"] == .null && v["error_code"] == .string("vision_output_discarded"))
        case "unknown": try MediaJSON.require(v["output"] == .null && ["vision_provider_unknown", "vision_deadline_exceeded", "vision_interrupted"].contains(MediaJSON.text(v["error_code"])))
        case "failed": try MediaJSON.require(v["output"] == .null && ["vision_provider_rejected", "invalid_vision_output", "vision_output_too_large", "vision_origin_not_local", "vision_provider_unavailable"].contains(MediaJSON.text(v["error_code"])))
        default: throw MediaJSON.fail()
        }
        if let previous {
            let old = try MediaJSON.object(previous), n = try MediaJSON.object(metadata(value)), changing = Set(["status", "updated_at", "output", "error_code"])
            try MediaJSON.require(old.filter { !changing.contains($0.key) } == n.filter { !changing.contains($0.key) } && updated >= MediaJSON.time(old["updated_at"]))
            switch try MediaJSON.text(old["status"]) {
            case "running": break
            case "unknown": try MediaJSON.require(["unknown", "discarded"].contains(MediaJSON.text(v["status"])))
            case "succeeded":
                let a = try MediaJSON.object(old["output"]), b = try MediaJSON.object(n["output"])
                try MediaJSON.require(old.filter { $0.key != "output" } == n.filter { $0.key != "output" } && a.filter { $0.key != "cleared_at" } == b.filter { $0.key != "cleared_at" })
                if a["cleared_at"] != .null { try MediaJSON.require(a == b) }
            default: try MediaJSON.require(previous == .object(n))
            }
        }
    }
}
