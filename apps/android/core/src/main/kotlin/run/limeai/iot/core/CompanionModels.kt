package run.limeai.iot.core

import kotlinx.serialization.json.*
import java.time.Instant

class CompanionException(val code: String) : Exception(code) {
    val displayMessage: String get() = when (code) {
        "invalid_companion_policy", "companion_policy_changed" -> "角色设置已变化，请停止原会话后重新开始"
        "companion_record_unavailable" -> "陪伴记录不可用，已暂停新请求"
        "companion_history_unavailable" -> "上下文已清除，请停止原会话后重新开始"
        "companion_expired" -> "会话已到期"
        "companion_stopped" -> "会话已停止"
        "companion_turn_budget_exceeded" -> "本次会话轮数已用完"
        "companion_not_configured", "companion_configuration_changed" -> "语音服务未就绪或配置已变化"
        "companion_preparation_incomplete" -> "原回合准备未完成，请停止会话"
        "companion_not_found" -> "暂无陪伴会话"
        "companion_busy", "companion_session_pending", "companion_turn_pending" -> "请先查询或停止原会话"
        else -> "结果未知，请查询原会话"
    }
}
class CompanionPolicy private constructor(val document: JsonObject) {
    val name get() = MediaJSON.text(document, "name")
    val instructions get() = MediaJSON.text(document, "instructions")
    val language get() = MediaJSON.text(document, "language")
    val voice get() = MediaJSON.text(document, "voice")
    val maxTurns get() = MediaJSON.integer(document["max_turns"], 1, 8).toInt()
    val maxSeconds get() = MediaJSON.integer(document["max_seconds"], 30, 1800).toInt()
    companion object {
        fun parse(text: String): CompanionPolicy = try {
            val v = IntegerJSON.parse(text, 16384, 2, 32)
            MediaJSON.fields(v, "schema_version,policy_id,version,name,instructions,language,voice,max_turns,max_seconds")
            MediaJSON.require(v["schema_version"] == JsonPrimitive(1))
            CompanionJSON.match(v["policy_id"], "[a-z][a-z0-9-]{0,63}")
            CompanionJSON.match(v["version"], "(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})")
            val name = MediaJSON.text(v, "name"); val instructions = MediaJSON.text(v, "instructions")
            MediaJSON.require(name.isNotEmpty() && name.codePointCount(0, name.length) <= 80 && instructions.trim { it.isWhitespace() || it == '\uFEFF' }.isNotEmpty() && MediaJSON.text(v, "language") in listOf("auto", "zh", "en"))
            CompanionJSON.match(v["voice"], "[A-Za-z0-9_-]{1,64}")
            MediaJSON.integer(v["max_turns"], 1, 8); MediaJSON.integer(v["max_seconds"], 30, 1800)
            VoiceTextContext(instructions, emptyList()); CompanionPolicy(v)
        } catch (error: Exception) { throw CompanionException("invalid_companion_policy") }
    }
}
class CompanionRecord internal constructor(val document: JsonObject) {
    val id get() = MediaJSON.text(document, "session_id")
    val stopped get() = MediaJSON.bool(document["stopped"])
    val expiresAt: Instant get() = VoiceTurnJSON.time(document["expires_at"])
    val turnCount get() = CompanionJSON.turns(document).size
    companion object {
        fun parse(text: String, origin: String, space: String): CompanionRecord = try {
            val v = IntegerJSON.parse(text, 65535, 16, 8192)
            MediaJSON.fields(v, "version,origin,space_id,session_id,previous_ids,policy_digest,deployments,created_at,expires_at,max_turns,stopped,history,turns,checksum")
            MediaJSON.require(v["version"] == JsonPrimitive(1) && v["origin"] == JsonPrimitive(origin) && v["space_id"] == JsonPrimitive(space))
            CompanionJSON.match(JsonPrimitive(space), "[A-Za-z0-9_-]{1,128}"); CompanionJSON.match(v["session_id"], "[A-Za-z0-9_-]{1,64}")
            val ids = v.getValue("previous_ids").jsonArray
            MediaJSON.require(ids.size <= 256 && ids.distinct().size == ids.size)
            ids.forEach { CompanionJSON.match(it, "[A-Za-z0-9_-]{1,64}"); MediaJSON.require(it != v["session_id"]) }
            MediaJSON.hash(v["policy_digest"])
            val deployments = MediaJSON.obj(v["deployments"]); MediaJSON.fields(deployments, "transcription,text,speech")
            VoiceTurnJSON.kinds.forEach { MediaJSON.hash(deployments[it]) }
            val start = VoiceTurnJSON.time(v["created_at"]); val end = VoiceTurnJSON.time(v["expires_at"])
            MediaJSON.require(end > start && end.toEpochMilli() - start.toEpochMilli() <= 1800000)
            val max = MediaJSON.integer(v["max_turns"], 1, 8); MediaJSON.bool(v["stopped"])
            val history = MediaJSON.obj(v["history"]); MediaJSON.fields(history, "digest,message_count"); MediaJSON.hash(history["digest"])
            val count = MediaJSON.integer(history["message_count"], 0, 16); MediaJSON.require(count % 2 == 0L)
            val turns = v.getValue("turns").jsonArray; MediaJSON.require(turns.size <= max)
            MediaJSON.hash(v["checksum"]); MediaJSON.require(v["checksum"] == JsonPrimitive(IntegerJSON.digest(JsonObject(v - "checksum"))))
            var completed = 0
            turns.forEachIndexed { index, element ->
                val s = MediaJSON.obj(element); MediaJSON.fields(s, "turn_id,media_id,context_digest,completed,record"); val done = MediaJSON.bool(s["completed"])
                MediaJSON.require(s["turn_id"] == JsonPrimitive(MediaJSON.text(v, "session_id") + "_t${index + 1}") && (index == turns.size - 1 || done) && (!done || s["record"] != JsonNull))
                CompanionJSON.match(s["media_id"], "media-[A-Za-z0-9_-]{1,122}"); MediaJSON.hash(s["context_digest"])
                if (s["record"] != JsonNull) {
                    val turn = VoiceTurnRecord.parse(IntegerJSON.canonical(s.getValue("record")), origin, space, true); val t = turn.document; val context = t.getValue("text_context").jsonObject
                    MediaJSON.require(t["version"] == JsonPrimitive(2) && t["deployments"] == v["deployments"] && t["turn_id"] == s["turn_id"] && t.getValue("source").jsonObject["media_id"] == s["media_id"] && context["digest"] == s["context_digest"] && context["history_messages"] == JsonPrimitive(index * 2))
                    MediaJSON.require(VoiceTurnJSON.time(t["created_at"]) >= start && turn.expiresAt <= end && (!done || VoiceTurnJSON.job(t, "speech").jsonObject.getValue("observation").jsonObject["status"] == JsonPrimitive("succeeded")))
                }
                if (done) completed++
            }
            MediaJSON.require(count == completed * 2L && (completed != 0 || history["digest"] == JsonPrimitive(IntegerJSON.digest(JsonArray(emptyList())))))
            CompanionRecord(v)
        } catch (error: Exception) { throw CompanionException("companion_record_unavailable") }
    }
}
data class CompanionView(val record: CompanionRecord, val phase: String, val historyAvailable: Boolean, val turnsRemaining: Int, val canReply: Boolean, val stopSettled: Boolean, val turn: VoiceTurnView?)
internal object CompanionJSON {
    fun match(value: JsonElement?, pattern: String) { MediaJSON.require(MediaJSON.str(value).matches(Regex(pattern))) }
    fun turns(value: JsonObject) = value.getValue("turns").jsonArray.map { it.jsonObject }
    fun settled(record: CompanionRecord) = turns(record.document).all { slot ->
        val turn = slot["record"] as? JsonObject
        turn == null || turn["stopped"] == JsonPrimitive(true) && VoiceTurnJSON.kinds.all { kind ->
            val job = VoiceTurnJSON.job(turn, kind) as? JsonObject; val observed = job?.get("observation") as? JsonObject
            job == null || job["rejected_code"] != JsonNull || observed != null && MediaJSON.text(observed, "status") in listOf("succeeded", "failed", "discarded") && (kind != "text" || observed["status"] != JsonPrimitive("succeeded") || observed.getValue("output").jsonObject["cleared_at"] != JsonNull)
        }
    }
    fun messages(history: List<TextGenerationMessage>) = JsonArray(history.map { buildJsonObject { put("role", it.role); put("content", it.content) } })
}
