import Foundation

public struct CompanionError: Error, Sendable {
    public let code: String
    public var message: String {
        switch code {
        case "invalid_companion_policy", "companion_policy_changed": "角色设置已变化，请停止原会话后重新开始"
        case "companion_record_unavailable": "陪伴记录不可用，已暂停新请求"
        case "companion_history_unavailable": "上下文已清除，请停止原会话后重新开始"
        case "companion_expired": "会话已到期"
        case "companion_stopped": "会话已停止"
        case "companion_turn_budget_exceeded": "本次会话轮数已用完"
        case "companion_not_configured", "companion_configuration_changed": "语音服务未就绪或配置已变化"
        case "companion_preparation_incomplete": "原回合准备未完成，请停止会话"
        case "companion_not_found": "暂无陪伴会话"
        case "companion_busy", "companion_session_pending", "companion_turn_pending": "请先查询或停止原会话"
        default: "结果未知，请查询原会话"
        }
    }
}
public struct CompanionPolicy: Sendable {
    public let document: JSONValue
    public var name: String { MediaJSON.string(document, "name") }
    public var instructions: String { MediaJSON.string(document, "instructions") }
    public var language: String { MediaJSON.string(document, "language") }
    public var voice: String { MediaJSON.string(document, "voice") }
    public let maxTurns: Int
    public let maxSeconds: Int
    public static func parse(_ text: String) throws -> CompanionPolicy {
        do {
            let value = try IntegerJSON.parse(text, maxBytes: 16384, maxDepth: 2, maxNodes: 32)
            let v = try MediaJSON.fields(value, "schema_version,policy_id,version,name,instructions,language,voice,max_turns,max_seconds")
            try MediaJSON.require(v["schema_version"] == .integer(1))
            try CompanionJSON.match(v["policy_id"], #"[a-z][a-z0-9-]{0,63}"#)
            try CompanionJSON.match(v["version"], #"(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})"#)
            let name = try MediaJSON.text(v["name"]), instructions = try MediaJSON.text(v["instructions"])
            try MediaJSON.require(!name.isEmpty && name.unicodeScalars.count <= 80 && !instructions.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}"))).isEmpty && ["auto", "zh", "en"].contains(MediaJSON.text(v["language"])))
            try CompanionJSON.match(v["voice"], #"[A-Za-z0-9_-]{1,64}"#)
            let maxTurns = try MediaJSON.integer(v["max_turns"], 1, 8), maxSeconds = try MediaJSON.integer(v["max_seconds"], 30, 1800)
            _ = try VoiceTextContext(instructions: instructions, history: [])
            return CompanionPolicy(document: value, maxTurns: maxTurns, maxSeconds: maxSeconds)
        } catch { throw CompanionError(code: "invalid_companion_policy") }
    }
}
public struct CompanionRecord: Sendable {
    public let document: JSONValue
    public var id: String { MediaJSON.string(document, "session_id") }
    public var stopped: Bool { MediaJSON.member(document, "stopped") == .bool(true) }
    public var expiresAt: Date { get throws { try VoiceTurnJSON.time(MediaJSON.member(document, "expires_at")) } }
    public var turnCount: Int { CompanionJSON.turns(document).count }
    public static func parse(_ text: String, origin: String, space: String) throws -> CompanionRecord {
        do {
            let value = try IntegerJSON.parse(text, maxBytes: 65535, maxDepth: 16, maxNodes: 8192)
            var v = try MediaJSON.fields(value, "version,origin,space_id,session_id,previous_ids,policy_digest,deployments,created_at,expires_at,max_turns,stopped,history,turns,checksum")
            try MediaJSON.require(v["version"] == .integer(1) && v["origin"] == .string(origin) && v["space_id"] == .string(space))
            try CompanionJSON.match(.string(space), #"[A-Za-z0-9_-]{1,128}"#); try CompanionJSON.match(v["session_id"], #"[A-Za-z0-9_-]{1,64}"#)
            guard case .array(let ids) = v["previous_ids"], ids.count <= 256 else { throw MediaJSON.fail() }
            var unique = Set<String>()
            for id in ids { try CompanionJSON.match(id, #"[A-Za-z0-9_-]{1,64}"#); let text = try MediaJSON.text(id); try MediaJSON.require(id != v["session_id"] && unique.insert(text).inserted) }
            try MediaJSON.hash(v["policy_digest"])
            let deployments = try MediaJSON.fields(v["deployments"], "transcription,text,speech")
            for kind in VoiceTurnJSON.kinds { try MediaJSON.hash(deployments[kind]) }
            let start = try VoiceTurnJSON.time(v["created_at"]), end = try VoiceTurnJSON.time(v["expires_at"])
            try MediaJSON.require(end > start && (end.timeIntervalSince1970 * 1000).rounded() - (start.timeIntervalSince1970 * 1000).rounded() <= 1800000)
            let max = try MediaJSON.integer(v["max_turns"], 1, 8); _ = try MediaJSON.bool(v["stopped"])
            let history = try MediaJSON.fields(v["history"], "digest,message_count"); try MediaJSON.hash(history["digest"])
            let count = try MediaJSON.integer(history["message_count"], 0, 16); try MediaJSON.require(count % 2 == 0)
            guard case .array(let turns) = v["turns"], turns.count <= max else { throw MediaJSON.fail() }
            let checksum = v.removeValue(forKey: "checksum")!; try MediaJSON.hash(checksum); try MediaJSON.require(checksum == .string(IntegerJSON.digest(.object(v))))
            var completed = 0
            for (index, slot) in turns.enumerated() {
                let s = try MediaJSON.fields(slot, "turn_id,media_id,context_digest,completed,record"), done = try MediaJSON.bool(s["completed"])
                try MediaJSON.require(s["turn_id"] == .string(MediaJSON.text(v["session_id"]) + "_t\(index + 1)") && (index == turns.count - 1 || done) && (!done || s["record"] != .null))
                try CompanionJSON.match(s["media_id"], #"media-[A-Za-z0-9_-]{1,122}"#); try MediaJSON.hash(s["context_digest"])
                if s["record"] != .null {
                    let turn = try VoiceTurnRecord.parse(IntegerJSON.canonical(s["record"]!), origin: origin, space: space, contextual: true), t = try MediaJSON.object(turn.document)
                    let context = MediaJSON.member(turn.document, "text_context")
                    try MediaJSON.require(t["version"] == .integer(2) && t["deployments"] == v["deployments"] && t["turn_id"] == s["turn_id"] && MediaJSON.member(t["source"]!, "media_id") == s["media_id"] && MediaJSON.member(context, "digest") == s["context_digest"] && MediaJSON.member(context, "history_messages") == .integer(index * 2))
                    try MediaJSON.require(VoiceTurnJSON.time(t["created_at"]) >= start && turn.expiresAt <= end && (!done || MediaJSON.member(MediaJSON.member(VoiceTurnJSON.job(turn.document, "speech"), "observation"), "status") == .string("succeeded")))
                }
                if done { completed += 1 }
            }
            try MediaJSON.require(count == completed * 2 && (completed != 0 || history["digest"] == .string(IntegerJSON.digest(.array([])))))
            return CompanionRecord(document: value)
        } catch { throw CompanionError(code: "companion_record_unavailable") }
    }
}
public struct CompanionView: Sendable {
    public let record: CompanionRecord
    public let phase: String
    public let historyAvailable: Bool
    public let turnsRemaining: Int
    public let canReply: Bool
    public let stopSettled: Bool
    public let turn: VoiceTurnView?
    public func redactingOutput() -> CompanionView {
        CompanionView(record: record, phase: phase, historyAvailable: historyAvailable, turnsRemaining: turnsRemaining, canReply: canReply, stopSettled: stopSettled,
            turn: turn.map { VoiceTurnView(record: $0.record, phase: $0.phase, stage: $0.stage, transcript: nil, answer: nil, mediaID: nil) })
    }
}
enum CompanionJSON {
    static func match(_ value: JSONValue?, _ pattern: String) throws {
        let text = try MediaJSON.text(value)
        try MediaJSON.require(text.range(of: "^(?:" + pattern + ")$", options: .regularExpression) == text.startIndex..<text.endIndex)
    }
    static func turns(_ value: JSONValue) -> [JSONValue] { if case .array(let turns) = MediaJSON.member(value, "turns") { return turns }; return [] }
    static func settled(_ record: CompanionRecord) -> Bool {
        turns(record.document).allSatisfy { slot in
            let turn = MediaJSON.member(slot, "record")
            return turn == .null || MediaJSON.member(turn, "stopped") == .bool(true) && VoiceTurnJSON.kinds.allSatisfy { kind in
                let job = VoiceTurnJSON.job(turn, kind), observation = MediaJSON.member(job, "observation")
                return job == .null || MediaJSON.member(job, "rejected_code") != .null || observation != .null && ["succeeded", "failed", "discarded"].contains(MediaJSON.string(observation, "status")) && (kind != "text" || MediaJSON.member(observation, "status") != .string("succeeded") || MediaJSON.member(MediaJSON.member(observation, "output"), "cleared_at") != .null)
            }
        }
    }
}
