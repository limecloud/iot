package run.limeai.iot.core

import kotlinx.serialization.json.*
import java.time.Instant

class VoiceTurnException(val code: String) : Exception(code) {
    val displayMessage: String get() = when (code) {
        "voice_turn_record_unavailable" -> "语音回合记录不可用，已暂停新请求"
        "voice_turn_pending", "voice_turn_busy" -> "请先查询或停止原语音回合"
        "voice_turn_not_configured", "voice_turn_configuration_changed" -> "语音服务未就绪或配置已变化"
        "voice_turn_source_unavailable" -> "原录音已不可用"
        "voice_turn_text_unavailable" -> "原文字已清除或到期"
        "voice_turn_answer_not_speakable" -> "回答超出语音合成限制，请使用原文字回答"
        "voice_turn_not_found" -> "暂无语音回合"
        else -> "语音回合结果未知，请查询原回合"
    }
}
class VoiceTurnRecord internal constructor(val document: JsonObject) {
    val id get() = MediaJSON.text(document, "turn_id")
    val stopped get() = MediaJSON.bool(document["stopped"])
    val expiresAt get() = VoiceTurnJSON.time(document["expires_at"])
    companion object {
        fun parse(text: String, origin: String, space: String, contextual: Boolean = false): VoiceTurnRecord = try {
            val value = IntegerJSON.parse(text, 32768, 8, 512); VoiceTurnJSON.record(value, origin, space, contextual); VoiceTurnRecord(value)
        } catch (error: Exception) { throw VoiceTurnException("voice_turn_record_unavailable") }
    }
}
data class VoiceTurnView(val record: VoiceTurnRecord, val phase: String, val stage: String?, val transcript: String?, val answer: String?, val mediaId: String?)
data class VoiceTurnCapabilities(val transcription: TranscriptionCapabilities, val text: TextGenerationCapabilities, val speech: SpeechCapabilities) {
    val configured get() = transcription.configured && text.configured && speech.configured
    internal fun revision(kind: String): JsonElement = (when (kind) { "transcription" -> transcription.document; "text" -> text.document; else -> speech.document })["deployment"]?.jsonObject?.get("revision") ?: JsonNull
}
class VoiceTextContext(instructions: String, history: List<TextGenerationMessage>) {
    val instructions = instructions
    val history = history.toList()
    init {
        try {
            MediaJSON.require(history.size <= 14 && history.size % 2 == 0)
            TextGenerationRequests.input(history + TextGenerationMessage("user", "_"), instructions, 600, "2030-01-01T00:00:00.000Z")
        } catch (error: Exception) { throw VoiceTurnException("invalid_voice_turn_context") }
    }
    internal val document get() = buildJsonObject {
        put("instructions", instructions)
        put("history", JsonArray(history.map { buildJsonObject { put("role", it.role); put("content", it.content) } }))
    }
    companion object {
        fun parse(text: String): VoiceTextContext = try {
            val v = IntegerJSON.parse(text, 32768, 4, 128); MediaJSON.fields(v, "instructions,history")
            VoiceTextContext(MediaJSON.text(v, "instructions"), v.getValue("history").jsonArray.map {
                val m = MediaJSON.obj(it); MediaJSON.fields(m, "role,content"); TextGenerationMessage(MediaJSON.text(m, "role"), MediaJSON.text(m, "content"))
            })
        } catch (error: Exception) { throw VoiceTurnException("invalid_voice_turn_context") }
    }
}
object VoiceTurnRequests {
    fun input(turnId: String, mediaId: String, language: String = "zh", voice: String): JsonObject = checked(buildJsonObject { put("turn_id", turnId); put("media_id", mediaId); put("language", language); put("voice", voice) })
    internal fun checked(v: JsonObject): JsonObject = try {
        MediaJSON.fields(v, "turn_id,media_id,language,voice")
        for (key in listOf("turn_id", "media_id", "voice")) MediaJSON.id(v[key])
        MediaJSON.require(MediaJSON.text(v, "turn_id").length <= 96 && MediaJSON.text(v, "voice").length <= 64 && MediaJSON.text(v, "media_id").startsWith("media-") && MediaJSON.text(v, "language") in listOf("auto", "zh", "en")); v
    } catch (error: Exception) { throw VoiceTurnException("invalid_voice_turn_request") }
}

// 与网页/CLI共用v1摘要账本格式；正文不进入该文档。
internal object VoiceTurnJSON {
    val kinds = listOf("transcription", "text", "speech")
    const val instructions = "请根据用户的语音内容，用简短、清晰的中文回答。回答不超过300字，不调用工具。"
    fun family(kind: String) = when (kind) { "transcription" -> "audio-transcriptions"; "text" -> "text-generations"; else -> "speech-syntheses" }
    fun time(value: JsonElement?): Instant {
        MediaJSON.require(MediaJSON.str(value).matches(Regex("\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z"))); return MediaJSON.time(value)
    }
    fun pending(observation: JsonElement?) = observation == null || observation == JsonNull || MediaJSON.text(observation.jsonObject, "status") in listOf("running", "unknown")
    fun job(record: JsonObject, kind: String) = record.getValue("jobs").jsonObject.getValue(kind)
    fun settingJob(record: JsonObject, kind: String, value: JsonObject) = JsonObject(record + ("jobs" to JsonObject(record.getValue("jobs").jsonObject + (kind to value))))
    fun observation(value: JsonObject) {
        MediaJSON.fields(value, "identity_digest,terminal_digest,status,updated_at,output,media_id")
        MediaJSON.hash(value["identity_digest"]); if (value["terminal_digest"] != JsonNull) MediaJSON.hash(value["terminal_digest"])
        MediaJSON.require(MediaJSON.text(value, "status") in listOf("running", "succeeded", "failed", "unknown", "discarded")); time(value["updated_at"])
        if (value["media_id"] != JsonNull) MediaJSON.id(value["media_id"], "media-")
        if (value["output"] != JsonNull) {
            val output = MediaJSON.obj(value["output"]); MediaJSON.fields(output, "content_digest,expires_at,cleared_at")
            MediaJSON.hash(output["content_digest"]); time(output["expires_at"]); if (output["cleared_at"] != JsonNull) time(output["cleared_at"])
        }
    }
    fun record(v: JsonObject, origin: String, space: String, contextual: Boolean = false) {
        val withContext = contextual && v["version"] == JsonPrimitive(2)
        MediaJSON.fields(v, "version,origin,space_id,turn_id,created_at,expires_at,source,language,voice,retain_seconds,deployments,jobs,stopped,checksum" + if (withContext) ",text_context" else "")
        MediaJSON.require((v["version"] == JsonPrimitive(1) || withContext) && v["origin"] == JsonPrimitive(origin) && v["space_id"] == JsonPrimitive(space) && v["retain_seconds"] == JsonPrimitive(600))
        if (withContext) {
            val context = MediaJSON.obj(v["text_context"]); MediaJSON.fields(context, "digest,history_messages"); MediaJSON.hash(context["digest"])
            val count = MediaJSON.integer(context["history_messages"], 0, 14); MediaJSON.require(count % 2 == 0L)
        }
        MediaJSON.id(JsonPrimitive(space)); MediaJSON.id(v["turn_id"]); MediaJSON.id(v["voice"])
        MediaJSON.require(MediaJSON.text(v, "voice").length <= 64 && MediaJSON.text(v, "language") in listOf("auto", "zh", "en"))
        val start = time(v["created_at"]); val end = time(v["expires_at"]); val source = MediaJSON.obj(v["source"]); MediaJSON.fields(source, "media_id,content_digest,expires_at")
        MediaJSON.id(source["media_id"], "media-"); MediaJSON.hash(source["content_digest"])
        MediaJSON.require(end > start && end <= start.plusSeconds(300) && end <= time(source["expires_at"]))
        MediaJSON.bool(v["stopped"])
        val deployments = MediaJSON.obj(v["deployments"]); MediaJSON.fields(deployments, "transcription,text,speech"); val jobs = MediaJSON.obj(v["jobs"]); MediaJSON.fields(jobs, "transcription,text,speech")
        for (kind in kinds) MediaJSON.hash(deployments[kind])
        MediaJSON.hash(v["checksum"]); MediaJSON.require(v["checksum"] == JsonPrimitive(IntegerJSON.digest(JsonObject(v - "checksum"))))
        for ((index, kind) in kinds.withIndex()) {
            if (jobs[kind] == JsonNull) continue
            val entry = MediaJSON.obj(jobs[kind]); MediaJSON.fields(entry, "original,observation,rejected_code,discard_attempted"); val original = MediaJSON.obj(entry["original"])
            when (kind) { "transcription" -> TranscriptionJSON.original(original, origin); "text" -> TextGenerationJSON.original(original, origin); else -> SpeechJSON.original(original, origin) }
            MediaJSON.require(original["space_id"] == JsonPrimitive(space) && original["idempotency_key"] == JsonPrimitive(MediaJSON.text(v, "turn_id") + "-" + kind))
            MediaJSON.require(!MediaJSON.bool(entry["discard_attempted"]) || v["stopped"] == JsonPrimitive(true))
            if (entry["rejected_code"] != JsonNull) MediaJSON.require(MediaJSON.str(entry["rejected_code"]).matches(Regex("[a-z][a-z0-9_]{0,63}")))
            if (index > 0) MediaJSON.require((jobs[kinds[index - 1]] as? JsonObject)?.get("observation")?.let { it as? JsonObject }?.get("status") == JsonPrimitive("succeeded"))
            if (entry["observation"] != JsonNull) {
                val observed = MediaJSON.obj(entry["observation"]); observation(observed); val succeeded = observed["status"] == JsonPrimitive("succeeded"); val terminal = MediaJSON.text(observed, "status") in listOf("succeeded", "failed", "discarded")
                MediaJSON.require((observed["terminal_digest"] != JsonNull) == terminal && (observed["output"] != JsonNull) == (succeeded && kind != "speech") && (observed["media_id"] != JsonNull) == (succeeded && kind == "speech") && entry["rejected_code"] == JsonNull)
            }
            if (kind == "transcription") { val input = MediaJSON.obj(original["input"]); MediaJSON.require(input["media_id"] == source["media_id"] && input["media_digest"] == source["content_digest"] && input["language"] == v["language"]) }
            if (kind == "text") { val input = MediaJSON.obj(original["input"]); MediaJSON.require(input["message_count"] == JsonPrimitive(if (withContext) MediaJSON.integer(v.getValue("text_context").jsonObject["history_messages"], 0, 14) + 1 else 1) && input["retain_seconds"] == JsonPrimitive(600)) }
            if (kind == "speech") MediaJSON.require(original["voice"] == v["voice"] && original["retain_seconds"] == JsonPrimitive(600))
        }
    }
    fun observe(task: JsonObject, kind: String, previous: JsonElement?): JsonObject {
        val identityKey = when (kind) { "transcription" -> "transcription_id"; "text" -> "text_id"; else -> "synthesis_id" }
        val identity = buildJsonObject { put("id", task.getValue(identityKey)); for (key in listOf("request_digest", "deployment", "created_at")) put(key, task.getValue(key)) }
        val taskOutput = task["output"] as? JsonObject
        val terminal = buildJsonObject {
            for (key in listOf("status", "updated_at", "error_code")) put(key, task.getValue(key))
            put("usage", task["usage"] ?: JsonNull); put("media_id", task["media_id"] ?: JsonNull)
            put("output", taskOutput?.let { buildJsonObject { put("content_digest", it.getValue("content_digest")); put("expires_at", it.getValue("expires_at")) } } ?: JsonNull)
        }
        val output = taskOutput?.let { buildJsonObject { put("content_digest", it.getValue("content_digest")); put("expires_at", SpeechJSON.timestamp(MediaJSON.time(it["expires_at"]))); put("cleared_at", it["cleared_at"]?.takeUnless { value -> value == JsonNull }?.let { value -> JsonPrimitive(SpeechJSON.timestamp(MediaJSON.time(value))) } ?: JsonNull) } } ?: JsonNull
        val next = buildJsonObject {
            put("identity_digest", IntegerJSON.digest(identity)); put("terminal_digest", if (MediaJSON.text(task, "status") in listOf("succeeded", "failed", "discarded")) JsonPrimitive(IntegerJSON.digest(terminal)) else JsonNull)
            put("status", task.getValue("status")); put("updated_at", SpeechJSON.timestamp(MediaJSON.time(task["updated_at"]))); put("output", output); put("media_id", task["media_id"] ?: JsonNull)
        }
        if (previous != null && previous != JsonNull) {
            val p = MediaJSON.obj(previous); val before = MediaJSON.text(p, "status"); val after = MediaJSON.text(next, "status")
            MediaJSON.require(p["identity_digest"] == next["identity_digest"] && (p["terminal_digest"] == JsonNull || p["terminal_digest"] == next["terminal_digest"]) && time(next["updated_at"]) >= time(p["updated_at"]) && (before !in listOf("succeeded", "failed", "discarded") || before == after) && (before != "unknown" || after in listOf("unknown", "discarded")) && (p["media_id"] == JsonNull || p["media_id"] == next["media_id"]))
            if (p["output"] != JsonNull) {
                val old = MediaJSON.obj(p["output"]); val current = MediaJSON.obj(next["output"])
                MediaJSON.require(old["content_digest"] == current["content_digest"] && old["expires_at"] == current["expires_at"] && (old["cleared_at"] == JsonNull || old["cleared_at"] == current["cleared_at"]))
            }
        }
        return next
    }
}
