package run.limeai.iot.core

import kotlinx.serialization.json.*
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

class SpeechException(val code: String) : Exception(code) {
    val displayMessage: String get() = when (code) {
        "speech_storage_failed", "speech_record_changed" -> "语音记录不可用，已暂停新请求"
        "speech_pending" -> "请先查询或明确放弃原语音任务"
        "speech_capacity" -> "本机语音记录已满"
        "speech_busy" -> "已有语音操作正在处理"
        "speech_unknown" -> "结果未知，请查询原语音任务"
        "invalid_speech_input" -> "请填写1000字以内的文本，并检查声音和保留时间"
        else -> "语音材料或响应未通过校验"
    }
}
data class SpeechCapabilities(val document: JsonObject) {
    val configured get() = document["configured"] == JsonPrimitive(true)
    val voices get() = (document["voices"] as? JsonArray)?.map { it.jsonPrimitive.content }.orEmpty()
}
data class SpeechRecord(val original: JsonObject, val result: JsonObject?, val rejectedCode: String?, val discardIntents: List<String>) {
    val key get() = MediaJSON.text(original, "idempotency_key")
    val space get() = MediaJSON.text(original, "space_id")
    val status get() = result?.let { MediaJSON.text(it, "status") } ?: if (rejectedCode == null) "unresolved" else "rejected"
    val pending get() = status in listOf("unresolved", "running", "unknown")
    val mediaId get() = result?.get("media_id")?.takeUnless { it == JsonNull }?.jsonPrimitive?.content
    val statusText get() = mapOf("unresolved" to "结果待核实", "running" to "正在生成", "succeeded" to "生成完成", "failed" to "生成失败", "unknown" to "结果未知", "discarded" to "已放弃输出", "rejected" to "请求未受理")[status] ?: "结果待核实"
}
object SpeechRequests {
    fun input(text: String, voice: String, retainSeconds: Int = 600, expiresAt: String = SpeechJSON.timestamp(Instant.now().plusSeconds(85))): JsonObject = parse(buildJsonObject {
        put("text", text); put("voice", voice); put("retain_seconds", retainSeconds); put("expires_at", expiresAt)
    }.toString())
    fun parse(text: String): JsonObject = try {
        val v = IntegerJSON.parse(text, maxBytes = 8192, maxDepth = 3, maxNodes = 32); MediaJSON.fields(v, "text,voice,retain_seconds,expires_at")
        val input = MediaJSON.str(v["text"])
        MediaJSON.require(input.any { !it.isWhitespace() && it != '\uFEFF' } && input.codePointCount(0, input.length) <= 1000 && input.toByteArray(Charsets.UTF_8).size <= 4096 && !input.any { it.code < 32 && it !in "\n\t" || it.code in 127..159 })
        SpeechJSON.voice(v["voice"]); MediaJSON.integer(v["retain_seconds"], 60, 86400)
        MediaJSON.require(!Regex("\\.\\d{4,}").containsMatchIn(MediaJSON.str(v["expires_at"])))
        JsonObject(v + ("expires_at" to JsonPrimitive(SpeechJSON.timestamp(MediaJSON.time(v["expires_at"])))))
    } catch (error: Exception) { throw SpeechException("invalid_speech_input") }
}
internal object SpeechJSON {
    fun timestamp(time: Instant): String = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC).format(time)
    fun voice(value: JsonElement?) { MediaJSON.id(value); MediaJSON.require(MediaJSON.str(value).length <= 64) }
    fun deployment(value: JsonElement?) {
        val v = MediaJSON.obj(value); MediaJSON.fields(v, "adapter,revision,model,data_location")
        MediaJSON.require(v["adapter"] == JsonPrimitive("local-http-speech-v1") && v["data_location"] == JsonPrimitive("local")); MediaJSON.hash(v["revision"])
        MediaJSON.require(MediaJSON.str(v["model"]).matches(Regex("[A-Za-z0-9_:./-]{1,128}")))
    }
    fun capabilities(value: JsonElement?): SpeechCapabilities {
        val v = MediaJSON.obj(value)
        if (v["configured"] == JsonPrimitive(false)) MediaJSON.fields(v, "configured,capability")
        else {
            MediaJSON.fields(v, "configured,capability,deployment,voices,concurrency,max_text_bytes,max_characters,max_output_bytes,max_audio_seconds,max_deadline_seconds,streaming,provider_cancellation")
            MediaJSON.require(v["configured"] == JsonPrimitive(true)); deployment(v["deployment"])
            val voices = v["voices"] as? JsonArray ?: throw MediaException("invalid_media_document")
            MediaJSON.require(voices.size in 1..32); voices.forEach(::voice); MediaJSON.require(voices.distinct().size == voices.size)
            for ((key, number) in mapOf("concurrency" to 1, "max_text_bytes" to 4096, "max_characters" to 1000, "max_output_bytes" to 4194304, "max_audio_seconds" to 60, "max_deadline_seconds" to 90)) MediaJSON.require(v[key] == JsonPrimitive(number))
            MediaJSON.require(v["streaming"] == JsonPrimitive(false) && v["provider_cancellation"] == JsonPrimitive(false))
        }
        MediaJSON.require(v["capability"] == JsonPrimitive("audio.synthesize")); return SpeechCapabilities(v)
    }
    fun original(origin: String, space: String, key: String, input: JsonObject): JsonObject {
        MediaJSON.id(JsonPrimitive(space)); MediaJSON.id(JsonPrimitive(key)); val text = MediaJSON.str(input["text"])
        val request = buildJsonObject { put("space_id", space); put("idempotency_key", key); put("input", input) }
        return buildJsonObject {
            put("version", 1); put("origin", origin); put("space_id", space); put("idempotency_key", key); put("request_digest", IntegerJSON.digest(request))
            put("input_digest", "sha256:" + MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) })
            put("input_characters", text.codePointCount(0, text.length)); for (name in listOf("voice", "retain_seconds", "expires_at")) put(name, input.getValue(name))
        }
    }
    fun original(v: JsonObject, origin: String) {
        MediaJSON.fields(v, "version,origin,space_id,idempotency_key,request_digest,input_digest,input_characters,voice,retain_seconds,expires_at")
        MediaJSON.require(v["version"] == JsonPrimitive(1) && v["origin"] == JsonPrimitive(origin)); MediaJSON.id(v["space_id"]); MediaJSON.id(v["idempotency_key"])
        MediaJSON.hash(v["request_digest"]); MediaJSON.hash(v["input_digest"]); MediaJSON.integer(v["input_characters"], 1, 1000); voice(v["voice"]); MediaJSON.integer(v["retain_seconds"], 60, 86400); MediaJSON.time(v["expires_at"])
    }
    fun task(v: JsonObject, original: JsonObject, previous: JsonObject? = null) {
        MediaJSON.fields(v, "synthesis_id,space_id,idempotency_key,request_digest,input_digest,input_characters,voice,retain_seconds,expires_at,deployment,created_at,updated_at,status,media_id,error_code")
        MediaJSON.id(v["synthesis_id"], "speech-"); deployment(v["deployment"])
        for (key in listOf("space_id", "idempotency_key", "request_digest", "input_digest", "input_characters", "voice", "retain_seconds")) MediaJSON.require(v[key] == original[key])
        val start = MediaJSON.time(v["created_at"]); val end = MediaJSON.time(v["expires_at"]); val updated = MediaJSON.time(v["updated_at"])
        MediaJSON.require(end == MediaJSON.time(original["expires_at"]) && end > start && end <= start.plusSeconds(90) && updated >= start)
        when (MediaJSON.text(v, "status")) {
            "running" -> MediaJSON.require(v["media_id"] == JsonNull && v["error_code"] == JsonNull && v["created_at"] == v["updated_at"])
            "succeeded" -> { MediaJSON.id(v["media_id"], "media-"); MediaJSON.require(v["error_code"] == JsonNull && updated < end) }
            "discarded" -> MediaJSON.require(v["media_id"] == JsonNull && v["error_code"] == JsonPrimitive("speech_output_discarded"))
            "unknown" -> MediaJSON.require(v["media_id"] == JsonNull && MediaJSON.str(v["error_code"]) in listOf("speech_provider_unknown", "speech_deadline_exceeded", "speech_interrupted"))
            "failed" -> MediaJSON.require(v["media_id"] == JsonNull && MediaJSON.str(v["error_code"]) in listOf("speech_provider_rejected", "invalid_speech_audio", "speech_output_too_large", "speech_output_unavailable", "speech_origin_not_local", "speech_provider_unavailable"))
            else -> MediaJSON.require(false)
        }
        if (previous != null) {
            val changing = setOf("status", "updated_at", "media_id", "error_code")
            MediaJSON.require(previous.filterKeys { it !in changing } == v.filterKeys { it !in changing } && updated >= MediaJSON.time(previous["updated_at"]))
            when (MediaJSON.text(previous, "status")) {
                "running" -> Unit
                "unknown" -> MediaJSON.require(MediaJSON.text(v, "status") in listOf("unknown", "discarded"))
                else -> MediaJSON.require(previous == v)
            }
        }
    }
}
