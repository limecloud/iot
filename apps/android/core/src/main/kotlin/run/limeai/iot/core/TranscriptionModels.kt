package run.limeai.iot.core

import kotlinx.serialization.json.*
import java.security.MessageDigest
import java.time.Instant

class TranscriptionException(val code: String) : Exception(code) {
    val displayMessage: String get() = when (code) {
        "transcription_storage_failed", "transcription_record_changed" -> "识别记录不可用，已暂停新请求"
        "transcription_pending" -> "请先查询或明确放弃原识别任务"
        "transcription_capacity" -> "本机识别记录已满"
        "transcription_busy" -> "已有识别操作正在处理"
        "transcription_unknown" -> "结果未知，请查询原识别任务"
        "invalid_transcription_input" -> "请选择可用的音频并检查识别语言"
        else -> "识别材料或响应未通过校验"
    }
}
data class TranscriptionCapabilities(val document: JsonObject) {
    val configured get() = document["configured"] == JsonPrimitive(true)
}
data class TranscriptionRecord(val original: JsonObject, val observation: JsonObject?, val rejectedCode: String?, val discardIntents: List<String>, val text: String? = null) {
    // observation 为去除 output.text 的任务元数据；不能当作服务器任务提交。
    val key get() = MediaJSON.text(original, "idempotency_key")
    val space get() = MediaJSON.text(original, "space_id")
    val status get() = observation?.let { MediaJSON.text(it, "status") } ?: if (rejectedCode == null) "unresolved" else "rejected"
    val pending get() = status in listOf("unresolved", "running", "unknown")
    val outputExpiresAt get() = observation?.get("output")?.takeUnless { it == JsonNull }?.jsonObject?.get("expires_at")?.let(MediaJSON::time)
    val statusText get() = mapOf("unresolved" to "结果待核实", "running" to "正在识别", "succeeded" to "识别完成", "failed" to "识别失败", "unknown" to "结果未知", "discarded" to "已放弃输出", "rejected" to "请求未受理")[status] ?: "结果待核实"
}
object TranscriptionRequests {
    fun input(mediaId: String, mediaDigest: String, language: String = "auto", expiresAt: String = SpeechJSON.timestamp(Instant.now().plusSeconds(85))): JsonObject = parse(buildJsonObject {
        put("media_id", mediaId); put("media_digest", mediaDigest); put("language", language); put("expires_at", expiresAt)
    }.toString())
    fun parse(text: String): JsonObject = try {
        val v = IntegerJSON.parse(text, maxBytes = 4096, maxDepth = 3, maxNodes = 32); MediaJSON.fields(v, "media_id,media_digest,language,expires_at")
        MediaJSON.id(v["media_id"], "media-"); MediaJSON.hash(v["media_digest"]); MediaJSON.require(MediaJSON.str(v["language"]) in listOf("auto", "zh", "en"))
        MediaJSON.require(!Regex("\\.\\d{4,}").containsMatchIn(MediaJSON.str(v["expires_at"])))
        JsonObject(v + ("expires_at" to JsonPrimitive(SpeechJSON.timestamp(MediaJSON.time(v["expires_at"])))))
    } catch (error: Exception) { throw TranscriptionException("invalid_transcription_input") }
}
internal object TranscriptionJSON {
    fun deployment(value: JsonElement?) {
        val v = MediaJSON.obj(value); MediaJSON.fields(v, "adapter,revision,model,data_location")
        MediaJSON.require(v["adapter"] == JsonPrimitive("local-http-transcription-v1") && v["data_location"] == JsonPrimitive("local")); MediaJSON.hash(v["revision"])
        MediaJSON.require(MediaJSON.str(v["model"]).matches(Regex("[A-Za-z0-9_:./-]{1,128}")))
    }
    fun capabilities(value: JsonElement?): TranscriptionCapabilities {
        val v = MediaJSON.obj(value)
        if (v["configured"] == JsonPrimitive(false)) MediaJSON.fields(v, "configured,capability")
        else {
            MediaJSON.fields(v, "configured,capability,deployment,languages,concurrency,max_audio_bytes,max_audio_seconds,max_text_bytes,max_characters,max_deadline_seconds,streaming,provider_cancellation")
            MediaJSON.require(v["configured"] == JsonPrimitive(true)); deployment(v["deployment"])
            MediaJSON.require(v["languages"] == JsonArray(listOf("auto", "zh", "en").map(::JsonPrimitive)))
            for ((key, number) in mapOf("concurrency" to 1, "max_audio_bytes" to 4194304, "max_audio_seconds" to 60, "max_text_bytes" to 8192, "max_characters" to 2048, "max_deadline_seconds" to 90)) MediaJSON.require(v[key] == JsonPrimitive(number))
            MediaJSON.require(v["streaming"] == JsonPrimitive(false) && v["provider_cancellation"] == JsonPrimitive(false))
        }
        MediaJSON.require(v["capability"] == JsonPrimitive("audio.transcribe")); return TranscriptionCapabilities(v)
    }
    fun original(origin: String, space: String, key: String, input: JsonObject): JsonObject {
        MediaJSON.id(JsonPrimitive(space)); MediaJSON.id(JsonPrimitive(key))
        return buildJsonObject {
            put("version", 1); put("origin", origin); put("space_id", space); put("idempotency_key", key); put("input", input)
            put("request_digest", IntegerJSON.digest(buildJsonObject { put("space_id", space); put("idempotency_key", key); put("input", input) }))
        }
    }
    fun original(v: JsonObject, origin: String) {
        MediaJSON.fields(v, "version,origin,space_id,idempotency_key,input,request_digest")
        val input = TranscriptionRequests.parse(v.getValue("input").toString())
        MediaJSON.require(v == original(origin, MediaJSON.text(v, "space_id"), MediaJSON.text(v, "idempotency_key"), input))
    }
    fun metadata(v: JsonObject): JsonObject = JsonObject(v + ("input" to TranscriptionRequests.parse(v.getValue("input").toString())) + if (v["output"] == JsonNull) emptyMap() else mapOf("output" to JsonObject(MediaJSON.obj(v["output"]).filterKeys { it != "text" })))
    fun task(v: JsonObject, original: JsonObject, previous: JsonObject? = null, stored: Boolean = false) {
        MediaJSON.fields(v, "transcription_id,space_id,idempotency_key,request_digest,input,deployment,created_at,updated_at,status,output,error_code")
        MediaJSON.id(v["transcription_id"], "transcription-"); deployment(v["deployment"])
        for (key in listOf("space_id", "idempotency_key", "request_digest")) MediaJSON.require(v[key] == original[key])
        MediaJSON.require(TranscriptionRequests.parse(v.getValue("input").toString()) == original["input"])
        val start = MediaJSON.time(v["created_at"]); val updated = MediaJSON.time(v["updated_at"]); val end = MediaJSON.time(original.getValue("input").jsonObject["expires_at"])
        MediaJSON.require(end > start && end <= start.plusSeconds(90) && updated >= start)
        when (MediaJSON.text(v, "status")) {
            "running" -> MediaJSON.require(v["output"] == JsonNull && v["error_code"] == JsonNull && v["created_at"] == v["updated_at"])
            "succeeded" -> {
                val output = MediaJSON.obj(v["output"]); MediaJSON.fields(output, if (stored) "content_digest,expires_at,cleared_at" else "text,content_digest,expires_at,cleared_at")
                MediaJSON.hash(output["content_digest"]); val expiry = MediaJSON.time(output["expires_at"])
                MediaJSON.require(expiry > updated && expiry <= start.plusSeconds(86400) && v["error_code"] == JsonNull && updated < end)
                if (output["cleared_at"] != JsonNull) { MediaJSON.require(MediaJSON.time(output["cleared_at"]) >= updated); if (!stored) MediaJSON.require(output["text"] == JsonNull) }
                else if (!stored) {
                    val text = MediaJSON.str(output["text"])
                    MediaJSON.require(text.codePointCount(0, text.length) <= 2048 && text.toByteArray(Charsets.UTF_8).size <= 8192 && !text.any { it.code < 32 && it !in "\n\t" || it.code in 127..159 })
                    val digest = "sha256:" + MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
                    MediaJSON.require(output["content_digest"] == JsonPrimitive(digest))
                }
            }
            "discarded" -> MediaJSON.require(v["output"] == JsonNull && v["error_code"] == JsonPrimitive("transcription_output_discarded"))
            "unknown" -> MediaJSON.require(v["output"] == JsonNull && MediaJSON.str(v["error_code"]) in listOf("transcription_provider_unknown", "transcription_deadline_exceeded", "transcription_interrupted"))
            "failed" -> MediaJSON.require(v["output"] == JsonNull && MediaJSON.str(v["error_code"]) in listOf("transcription_provider_rejected", "invalid_transcription_output", "transcription_output_too_large", "transcription_source_unavailable", "transcription_origin_not_local", "transcription_provider_unavailable"))
            else -> MediaJSON.require(false)
        }
        if (previous != null) {
            val next = metadata(v); val changing = setOf("status", "updated_at", "output", "error_code")
            MediaJSON.require(previous.filterKeys { it !in changing } == next.filterKeys { it !in changing } && updated >= MediaJSON.time(previous["updated_at"]))
            when (MediaJSON.text(previous, "status")) {
                "running" -> Unit
                "unknown" -> MediaJSON.require(MediaJSON.text(v, "status") in listOf("unknown", "discarded"))
                "succeeded" -> {
                    val a = MediaJSON.obj(previous["output"]); val b = MediaJSON.obj(next["output"])
                    MediaJSON.require(previous.filterKeys { it != "output" } == next.filterKeys { it != "output" } && a.filterKeys { it != "cleared_at" } == b.filterKeys { it != "cleared_at" })
                    if (a["cleared_at"] != JsonNull) MediaJSON.require(a == b)
                }
                else -> MediaJSON.require(previous == next)
            }
        }
    }
}
