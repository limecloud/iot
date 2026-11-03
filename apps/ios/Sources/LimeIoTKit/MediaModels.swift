import Foundation
import CryptoKit

public struct MediaError: Error, Sendable {
    public let code: String
    public var message: String {
        switch code {
        case "media_storage_failed", "media_record_changed": "无法读取或保存本机音频记录，请检查安全存储"
        case "media_pending_operation": "请先查询同类音频原操作"
        case "media_capacity": "本机音频操作记录已满"
        case "media_unknown": "结果未知，请查询音频原操作"
        case "media_busy": "已有音频操作正在处理"
        case "invalid_media_audio": "请选择不超过4 MiB、60秒的16位PCM WAV文件"
        default: "音频材料或响应未通过校验"
        }
    }
}

public struct MediaItem: Sendable, Identifiable {
    public let metadata: JSONValue
    public let available: Bool
    public let deletedAt: String?
    public var id: String { MediaJSON.string(metadata, "media_id") }
    public var byteLength: Int { MediaJSON.number(metadata, "byte_length") }
    public var expiresAt: String { MediaJSON.string(metadata, "expires_at") }
    public var durationSeconds: Double {
        let audio = MediaJSON.member(metadata, "audio")
        return Double(MediaJSON.number(audio, "frames")) / Double(MediaJSON.number(audio, "sample_rate"))
    }
}
public struct MediaGrant: Sendable, Identifiable {
    public let document: JSONValue
    public var id: String { MediaJSON.string(document, "grant_id") }
    public var mediaId: String { MediaJSON.string(document, "media_id") }
    public var deviceId: String { MediaJSON.string(document, "device_id") }
    public var bindingRevision: String { MediaJSON.string(document, "binding_revision") }
    public var expiresAt: String { MediaJSON.string(document, "expires_at") }
    public var active: Bool {
        MediaJSON.member(document, "active_in_process") == .bool(true) && MediaJSON.member(document, "binding_current") == .bool(true) &&
        MediaJSON.member(document, "revoked_at") == .null && ((try? MediaJSON.time(.string(expiresAt))) ?? .distantPast) > Date()
    }
}
public struct MediaPage: Sendable {
    public let configured: Bool
    public let items: [MediaItem]
    public let grants: [MediaGrant]
}
public struct MediaRecord: Sendable, Identifiable {
    public let original: JSONValue
    public let result: JSONValue?
    public var id: String { MediaJSON.string(original, "idempotency_key") }
    public var space: String { MediaJSON.string(original, "space_id") }
    public var change: JSONValue { MediaJSON.member(original, "change") }
    public var type: String { MediaJSON.string(change, "type") }
    public var statusText: String { result == nil ? "结果待核实" : "原操作已核实" }
}
public enum MediaChanges {
    public static let maxAudioBytes = 4 * 1024 * 1024
    public static func parse(_ text: String) throws -> JSONValue {
        let value = try IntegerJSON.parse(text, maxBytes: 5_596_504, maxDepth: 5, maxNodes: 64)
        try MediaJSON.change(value); return value
    }
    public static func upload(bytes: Data, retainSeconds: Int) throws -> JSONValue {
        _ = try MediaJSON.wav(bytes)
        let value = JSONValue.object(["type": .string("media.upload"), "content_base64": .string(bytes.base64EncodedString()), "retain_seconds": .integer(retainSeconds)])
        try MediaJSON.change(value); return value
    }
    public static func grant(mediaId: String, deviceId: String, bindingRevision: String, validForSeconds: Int) throws -> JSONValue {
        let value = JSONValue.object(["type": .string("media.grant"), "media_id": .string(mediaId), "device_id": .string(deviceId), "expected_binding_revision": .string(bindingRevision), "valid_for_seconds": .integer(validForSeconds)])
        try MediaJSON.change(value); return value
    }
    public static func revoke(grantId: String) throws -> JSONValue {
        let value = JSONValue.object(["type": .string("media.revoke"), "grant_id": .string(grantId)])
        try MediaJSON.change(value); return value
    }
    public static func delete(mediaId: String) throws -> JSONValue {
        let value = JSONValue.object(["type": .string("media.delete"), "media_id": .string(mediaId)])
        try MediaJSON.change(value); return value
    }
}

enum MediaJSON {
    static func fail() -> MediaError { MediaError(code: "invalid_media_document") }
    static func require(_ valid: @autoclosure () throws -> Bool) throws { guard try valid() else { throw fail() } }
    static func object(_ value: JSONValue?) throws -> [String: JSONValue] { guard case .object(let v) = value else { throw fail() }; return v }
    static func fields(_ value: JSONValue?, _ names: String) throws -> [String: JSONValue] { let v = try object(value); try require(Set(v.keys) == Set(names.split(separator: ",").map(String.init))); return v }
    static func text(_ value: JSONValue?) throws -> String { guard case .string(let v) = value else { throw fail() }; return v }
    static func id(_ value: JSONValue?, _ prefix: String = "") throws { let v = try text(value); try require(v.range(of: #"^[A-Za-z0-9_-]{1,128}$"#, options: .regularExpression) != nil && v.hasPrefix(prefix)) }
    static func hash(_ value: JSONValue?) throws { try require(text(value).range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil) }
    static func integer(_ value: JSONValue?, _ min: Int, _ max: Int) throws -> Int { guard case .integer(let n) = value, n >= min, n <= max else { throw fail() }; return n }
    static func bool(_ value: JSONValue?) throws -> Bool { guard case .bool(let b) = value else { throw fail() }; return b }
    static func time(_ value: JSONValue?) throws -> Date {
        let v = try text(value)
        try require(v.utf8.count <= 40 && v.range(of: #"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$"#, options: .regularExpression) != nil)
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: v) { return date }; formatter.formatOptions = [.withInternetDateTime]
        guard let date = formatter.date(from: v) else { throw fail() }; return date
    }
    static func member(_ value: JSONValue, _ key: String) -> JSONValue { if case .object(let v) = value { v[key] ?? .null } else { .null } }
    static func string(_ value: JSONValue, _ key: String) -> String { (try? text(member(value, key))) ?? "" }
    static func number(_ value: JSONValue, _ key: String) -> Int { member(value, key).integer ?? 0 }
    static func audio(_ value: JSONValue?) throws -> Int {
        let v = try fields(value, "sample_rate,channels,bits_per_sample,frames"), rate = try integer(v["sample_rate"], 8000, 48000), channels = try integer(v["channels"], 1, 2)
        try require(v["bits_per_sample"] == .integer(16)); return try integer(v["frames"], 1, rate * 60) * channels * 2 + 44
    }
    static func wav(_ data: Data) throws -> JSONValue {
        guard (46...MediaChanges.maxAudioBytes).contains(data.count) else { throw MediaError(code: "invalid_media_audio") }
        let bytes = Array(data)
        func u16(_ i: Int) -> Int { Int(bytes[i]) | Int(bytes[i + 1]) << 8 }
        func u32(_ i: Int) -> Int { u16(i) | u16(i + 2) << 16 }
        func tag(_ i: Int) -> String { String(decoding: bytes[i..<(i + 4)], as: UTF8.self) }
        guard tag(0) == "RIFF", tag(8) == "WAVE", u32(4) == bytes.count - 8 else { throw MediaError(code: "invalid_media_audio") }
        var p = 12, format: [String: JSONValue]?, dataLength: Int?
        while p < bytes.count {
            guard bytes.count - p >= 8 else { throw MediaError(code: "invalid_media_audio") }
            let size = u32(p + 4), start = p + 8, end = start + size
            guard end <= bytes.count else { throw MediaError(code: "invalid_media_audio") }
            if tag(p) == "fmt " {
                guard format == nil, dataLength == nil, size == 16 else { throw MediaError(code: "invalid_media_audio") }
                let channels = u16(start + 2), rate = u32(start + 4)
                guard u16(start) == 1, (1...2).contains(channels), (8000...48000).contains(rate), u16(start + 14) == 16, u16(start + 12) == channels * 2, u32(start + 8) == rate * channels * 2 else { throw MediaError(code: "invalid_media_audio") }
                format = ["sample_rate": .integer(rate), "channels": .integer(channels), "bits_per_sample": .integer(16)]
            } else if tag(p) == "data" {
                guard format != nil, dataLength == nil, size > 0 else { throw MediaError(code: "invalid_media_audio") }; dataLength = size
            } else { throw MediaError(code: "invalid_media_audio") }
            p = end + size % 2
            guard p <= bytes.count else { throw MediaError(code: "invalid_media_audio") }
        }
        guard var format, let size = dataLength, let channels = format["channels"]?.integer, let rate = format["sample_rate"]?.integer,
              size % (channels * 2) == 0, size / (channels * 2) <= rate * 60 else { throw MediaError(code: "invalid_media_audio") }
        format["frames"] = .integer(size / (channels * 2)); return .object(format)
    }
    static func change(_ value: JSONValue) throws {
        let v = try object(value)
        switch try text(v["type"]) {
        case "media.upload":
            _ = try fields(value, "type,content_base64,retain_seconds"); _ = try integer(v["retain_seconds"], 60, 86400)
            let b64 = try text(v["content_base64"])
            try require(b64.utf8.count <= 5_592_408)
            guard let bytes = Data(base64Encoded: b64), bytes.base64EncodedString() == b64 else { throw fail() }; _ = try wav(bytes)
        case "media.grant":
            _ = try fields(value, "type,media_id,device_id,expected_binding_revision,valid_for_seconds"); try id(v["media_id"]); try id(v["device_id"]); try hash(v["expected_binding_revision"]); _ = try integer(v["valid_for_seconds"], 5, 600)
        case "media.revoke": _ = try fields(value, "type,grant_id"); try id(v["grant_id"])
        case "media.delete": _ = try fields(value, "type,media_id"); try id(v["media_id"])
        default: throw fail()
        }
    }
    static func original(origin: String, space: String, key: String, change value: JSONValue) throws -> JSONValue {
        try id(.string(space)); try id(.string(key)); try change(value)
        var summary = try object(value)
        if summary["type"] == .string("media.upload") {
            let bytes = Data(base64Encoded: try text(summary["content_base64"]))!
            summary.removeValue(forKey: "content_base64")
            summary["byte_length"] = .integer(bytes.count); summary["audio"] = try wav(bytes)
            summary["content_digest"] = .string("sha256:" + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
        }
        let request = JSONValue.object(["space_id": .string(space), "idempotency_key": .string(key), "change": value])
        return .object(["version": .integer(1), "origin": .string(origin), "space_id": .string(space), "idempotency_key": .string(key), "request_digest": .string(IntegerJSON.digest(request)), "change": .object(summary)])
    }
    static func original(_ value: JSONValue, origin: String) throws {
        let v = try fields(value, "version,origin,space_id,idempotency_key,request_digest,change")
        try require(v["version"] == .integer(1) && v["origin"] == .string(origin)); try id(v["space_id"]); try id(v["idempotency_key"]); try hash(v["request_digest"])
        let c = try object(v["change"])
        if c["type"] == .string("media.upload") {
            _ = try fields(v["change"], "type,content_digest,byte_length,audio,retain_seconds"); try hash(c["content_digest"]); _ = try integer(c["retain_seconds"], 60, 86400)
            try require(integer(c["byte_length"], 46, MediaChanges.maxAudioBytes) == audio(c["audio"]))
        } else { try change(v["change"]!) }
    }
    static func metadata(_ value: JSONValue?, space: String) throws {
        let v = try fields(value, "media_id,space_id,content_type,purpose,actor,byte_length,content_digest,audio,created_at,expires_at")
        try id(v["media_id"], "media-"); try require(v["space_id"] == .string(space) && v["content_type"] == .string("audio/wav") && v["purpose"] == .string("device_playback") && v["actor"] == .string("local_owner"))
        try hash(v["content_digest"]); try require(integer(v["byte_length"], 46, MediaChanges.maxAudioBytes) == audio(v["audio"]))
        let duration = try time(v["expires_at"]).timeIntervalSince(time(v["created_at"])); try require((60...86400).contains(duration))
    }
    static func grant(_ v: [String: JSONValue]) throws {
        try id(v["grant_id"], "grant-"); try id(v["media_id"]); try id(v["device_id"]); try hash(v["binding_revision"])
        let duration = try time(v["expires_at"]).timeIntervalSince(time(v["created_at"])); try require(duration > 0 && duration <= 600)
    }
    static func page(_ value: JSONValue, space: String) throws -> MediaPage {
        try id(.string(space)); let v = try fields(value, "space_id,configured,items,grants,next_cursor"), configured = try bool(v["configured"])
        guard case .array(let items) = v["items"], case .array(let grants) = v["grants"] else { throw fail() }
        try require(v["space_id"] == .string(space) && v["next_cursor"] == .null && items.count <= 256 && grants.count <= 512 && (configured || items.isEmpty && grants.isEmpty))
        var objects: [String: JSONValue] = [:], ids = Set<String>()
        let checkedItems = try items.map { item -> MediaItem in
            let i = try fields(item, "metadata,available,deleted_at"); try metadata(i["metadata"], space: space)
            let m = i["metadata"]!, id = string(m, "media_id"), available = try bool(i["available"])
            try require(objects[id] == nil); objects[id] = m
            if i["deleted_at"] != .null { try require(!available && time(i["deleted_at"]) >= time(member(m, "created_at"))) }
            return MediaItem(metadata: m, available: available, deletedAt: i["deleted_at"] == .null ? nil : try text(i["deleted_at"]))
        }
        let checkedGrants = try grants.map { item -> MediaGrant in
            let g = try fields(item, "grant_id,media_id,device_id,binding_revision,created_at,expires_at,active_in_process,binding_current,revoked_at,pulls"); try grant(g)
            let id = try text(g["grant_id"]); try require(ids.insert(id).inserted)
            guard let media = objects[try text(g["media_id"])], case .array(let pulls) = g["pulls"], pulls.count <= 16 else { throw fail() }
            try require(time(g["created_at"]) >= time(member(media, "created_at")) && time(g["expires_at"]) <= time(member(media, "expires_at")))
            let active = try bool(g["active_in_process"]); _ = try bool(g["binding_current"])
            if g["revoked_at"] != .null { try require(!active && time(g["revoked_at"]) >= time(g["created_at"])) }
            for value in pulls {
                let pull = try fields(value, "prepared_at,method,range_start,range_end,status"); _ = try time(pull["prepared_at"])
                try require(["GET", "HEAD"].contains(text(pull["method"])) && [200, 206].contains(integer(pull["status"], 200, 206)))
                let start = try integer(pull["range_start"], 0, number(media, "byte_length") - 1); _ = try integer(pull["range_end"], start, number(media, "byte_length") - 1)
            }
            return MediaGrant(document: item)
        }
        return MediaPage(configured: configured, items: checkedItems, grants: checkedGrants)
    }
    static func operation(_ value: JSONValue, original: JSONValue) throws {
        let o = try object(original), v = try fields(value, "space_id,operation_id,idempotency_key,request_digest,kind,created_at,result"), c = try object(o["change"])
        try id(v["operation_id"], "mediaop-"); _ = try time(v["created_at"])
        try require(v["space_id"] == o["space_id"] && v["idempotency_key"] == o["idempotency_key"] && v["request_digest"] == o["request_digest"] && v["kind"] == c["type"])
        let result = v["result"]!, r = try object(result)
        switch try text(v["kind"]) {
        case "media.upload":
            _ = try fields(result, "type,media"); try require(r["type"] == .string("uploaded")); try metadata(r["media"], space: text(o["space_id"]))
            let m = try object(r["media"]); try require(m["created_at"] == v["created_at"] && m["content_digest"] == c["content_digest"] && m["byte_length"] == c["byte_length"] && m["audio"] == c["audio"])
            try require(time(m["expires_at"]).timeIntervalSince(time(m["created_at"])) == Double(integer(c["retain_seconds"], 60, 86400)))
        case "media.grant":
            _ = try fields(result, "type,grant_id,media_id,device_id,binding_revision,created_at,expires_at,issued_in_process"); try grant(r); _ = try bool(r["issued_in_process"])
            try require(r["type"] == .string("granted") && r["media_id"] == c["media_id"] && r["device_id"] == c["device_id"] && r["binding_revision"] == c["expected_binding_revision"] && r["created_at"] == v["created_at"])
            try require(time(r["expires_at"]).timeIntervalSince(time(r["created_at"])) <= Double(integer(c["valid_for_seconds"], 5, 600)))
        case "media.delete": _ = try fields(result, "type,media_id"); try require(r["type"] == .string("deleted") && r["media_id"] == c["media_id"])
        case "media.revoke": _ = try fields(result, "type,grant_id"); try require(r["type"] == .string("revoked") && r["grant_id"] == c["grant_id"])
        default: throw fail()
        }
    }
    static func stable(_ value: JSONValue) -> JSONValue {
        guard case .object(var v) = value, case .object(var result) = v["result"], result["type"] == .string("granted") else { return value }
        result["issued_in_process"] = .bool(false); v["result"] = .object(result); return .object(v)
    }
    static func scope(_ change: JSONValue) -> String {
        let type = string(change, "type")
        return type + ":" + (type == "media.grant" ? string(change, "device_id") : type == "media.revoke" ? string(change, "grant_id") : type == "media.delete" ? string(change, "media_id") : "")
    }
}
