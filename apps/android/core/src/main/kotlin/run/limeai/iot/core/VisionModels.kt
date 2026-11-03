package run.limeai.iot.core

import kotlinx.serialization.json.*
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64

class VisionException(val code: String) : Exception(code) {
    val displayMessage: String get() = when (code) {
        "vision_storage_failed", "vision_record_changed" -> "图片观察记录不可用，已暂停新请求"
        "vision_pending" -> "请先查询或明确放弃原观察任务"
        "vision_capacity" -> "本机观察记录已满"
        "vision_busy" -> "已有观察操作正在处理"
        "vision_unknown" -> "结果未知，请查询原观察任务"
        "invalid_vision_input" -> "请选择不超过2 MiB的PNG或JPEG，并检查问题"
        else -> "观察材料或响应未通过校验"
    }
}
data class VisionCapabilities(val document: JsonObject) {
    val configured get() = document["configured"] == JsonPrimitive(true)
}
data class VisionRecord(val original: JsonObject, val observation: JsonObject?, val rejectedCode: String?, val discardIntents: List<String>, val text: String? = null) {
    // 仅保存摘要及去除 output.text 的观测，原图、问题与结果正文不进入本机账本。
    val key get() = MediaJSON.text(original, "idempotency_key")
    val space get() = MediaJSON.text(original, "space_id")
    val status get() = observation?.let { MediaJSON.text(it, "status") } ?: if (rejectedCode == null) "unresolved" else "rejected"
    val pending get() = status in listOf("unresolved", "running", "unknown")
    val outputExpiresAt get() = observation?.get("output")?.takeUnless { it == JsonNull }?.jsonObject?.get("expires_at")?.let(MediaJSON::time)
    val canDiscard get() = status in listOf("running", "unknown") || status == "succeeded" && observation?.get("output")?.jsonObject?.get("cleared_at") == JsonNull
    val statusText get() = mapOf("unresolved" to "结果待核实", "running" to "正在观察", "succeeded" to "观察完成", "failed" to "观察失败", "unknown" to "结果未知", "discarded" to "已放弃输出", "rejected" to "请求未受理")[status] ?: "结果待核实"
}
object VisionRequests {
    const val MAX_IMAGE_BYTES = 2 * 1024 * 1024
    fun contentType(bytes: ByteArray): String {
        if (bytes.size !in 3..MAX_IMAGE_BYTES) throw VisionException("invalid_vision_input")
        fun prefix(magic: List<Int>) = bytes.size >= magic.size && magic.indices.all { bytes[it].toInt() and 255 == magic[it] }
        return when { prefix(listOf(137,80,78,71,13,10,26,10)) -> "image/png"; prefix(listOf(255,216,255)) -> "image/jpeg"; else -> throw VisionException("invalid_vision_input") }
    }
    fun validatePrompt(prompt: String) {
        try { VisionJSON.text(JsonPrimitive(prompt), 512, 2048) } catch (error: Exception) { throw VisionException("invalid_vision_input") }
    }
    fun input(bytes: ByteArray, contentType: String, prompt: String, retainSeconds: Int = 600, expiresAt: String = SpeechJSON.timestamp(Instant.now().plusSeconds(85))): JsonObject {
        if (bytes.size > MAX_IMAGE_BYTES) throw VisionException("invalid_vision_input")
        return checked(buildJsonObject { put("image_base64", Base64.getEncoder().encodeToString(bytes)); put("content_type", contentType); put("prompt", prompt); put("retain_seconds", retainSeconds); put("expires_at", expiresAt) })
    }
    fun parse(text: String): JsonObject = try {
        checked(IntegerJSON.parse(text, maxBytes = 2_804_396, maxDepth = 3, maxNodes = 32))
    } catch (error: Exception) { throw VisionException("invalid_vision_input") }
    internal fun checked(v: JsonObject): JsonObject = try {
        MediaJSON.fields(v, "image_base64,content_type,prompt,retain_seconds,expires_at")
        val encoded = MediaJSON.str(v["image_base64"]); val type = MediaJSON.str(v["content_type"])
        MediaJSON.require(encoded.length <= 2_796_204 && type in listOf("image/png", "image/jpeg"))
        val bytes = Base64.getDecoder().decode(encoded)
        MediaJSON.require(bytes.size in 3..MAX_IMAGE_BYTES && Base64.getEncoder().encodeToString(bytes) == encoded)
        MediaJSON.require(contentType(bytes) == type)
        VisionJSON.text(v["prompt"], 512, 2048); MediaJSON.integer(v["retain_seconds"], 60, 3600)
        JsonObject(v + ("expires_at" to JsonPrimitive(VisionJSON.requestTime(v["expires_at"]))))
    } catch (error: Exception) { throw VisionException("invalid_vision_input") }
}
internal object VisionJSON {
    fun digest(bytes: ByteArray) = "sha256:" + MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun text(value: JsonElement?, characters: Int, bytes: Int) {
        val text = MediaJSON.str(value)
        var i = 0
        while (i < text.length) {
            if (text[i].isHighSurrogate()) { MediaJSON.require(++i < text.length && text[i].isLowSurrogate()) }
            else MediaJSON.require(!text[i].isLowSurrogate())
            i++
        }
        MediaJSON.require(text.isNotBlank() && text.codePointCount(0, text.length) <= characters && text.toByteArray(Charsets.UTF_8).size <= bytes && !text.any { it.code < 32 && it !in "\n\t" || it.code in 127..159 })
    }
    fun requestTime(value: JsonElement?): String {
        MediaJSON.require(!Regex("\\.\\d{4,}").containsMatchIn(MediaJSON.str(value)))
        return SpeechJSON.timestamp(MediaJSON.time(value))
    }
    fun summary(value: JsonElement?): JsonObject {
        val v = MediaJSON.obj(value); MediaJSON.fields(v, "image_digest,image_bytes,content_type,prompt_digest,retain_seconds,expires_at")
        MediaJSON.hash(v["image_digest"]); MediaJSON.hash(v["prompt_digest"]); MediaJSON.integer(v["image_bytes"], 1, VisionRequests.MAX_IMAGE_BYTES.toLong()); MediaJSON.integer(v["retain_seconds"], 60, 3600)
        MediaJSON.require(MediaJSON.str(v["content_type"]) in listOf("image/png", "image/jpeg"))
        return JsonObject(v + ("expires_at" to JsonPrimitive(requestTime(v["expires_at"]))))
    }
    fun summarize(input: JsonObject): JsonObject {
        val bytes = Base64.getDecoder().decode(MediaJSON.str(input["image_base64"]))
        return buildJsonObject { put("image_digest", digest(bytes)); put("image_bytes", bytes.size); put("content_type", input.getValue("content_type")); put("prompt_digest", digest(MediaJSON.str(input["prompt"]).toByteArray(Charsets.UTF_8))); put("retain_seconds", input.getValue("retain_seconds")); put("expires_at", input.getValue("expires_at")) }
    }
    fun deployment(value: JsonElement?) {
        val v = MediaJSON.obj(value); MediaJSON.fields(v, "adapter,revision,model,data_location")
        MediaJSON.require(v["adapter"] == JsonPrimitive("ollama-vision-v1") && v["data_location"] == JsonPrimitive("local")); MediaJSON.hash(v["revision"])
        MediaJSON.require(MediaJSON.str(v["model"]).matches(Regex("[A-Za-z0-9_:./-]{1,128}")))
    }
    fun capabilities(value: JsonElement?): VisionCapabilities {
        val v = MediaJSON.obj(value)
        if (v["configured"] == JsonPrimitive(false)) MediaJSON.fields(v, "configured,capability")
        else {
            MediaJSON.fields(v, "configured,capability,deployment,content_types,max_image_bytes,max_edge,max_prompt_characters,max_text_bytes,max_characters,max_deadline_seconds,max_retain_seconds,concurrency,streaming,provider_cancellation,input_storage,device_execution")
            MediaJSON.require(v["configured"] == JsonPrimitive(true)); deployment(v["deployment"])
            MediaJSON.require(v["content_types"] == JsonArray(listOf("image/png", "image/jpeg").map(::JsonPrimitive)))
            for ((key, number) in mapOf("max_image_bytes" to 2097152, "max_edge" to 1024, "max_prompt_characters" to 512, "max_text_bytes" to 8192, "max_characters" to 2048, "max_deadline_seconds" to 90, "max_retain_seconds" to 3600, "concurrency" to 1)) MediaJSON.require(v[key] == JsonPrimitive(number))
            MediaJSON.require(v["streaming"] == JsonPrimitive(false) && v["provider_cancellation"] == JsonPrimitive(false) && v["device_execution"] == JsonPrimitive(false) && v["input_storage"] == JsonPrimitive("digest_only"))
        }
        MediaJSON.require(v["capability"] == JsonPrimitive("vision.understand")); return VisionCapabilities(v)
    }
    fun original(origin: String, space: String, key: String, input: JsonObject): JsonObject {
        MediaJSON.id(JsonPrimitive(space)); MediaJSON.id(JsonPrimitive(key)); val checked = summary(input)
        return buildJsonObject { put("version", 1); put("origin", origin); put("space_id", space); put("idempotency_key", key); put("input", checked); put("request_digest", IntegerJSON.digest(buildJsonObject { put("space_id", space); put("idempotency_key", key); put("input", checked) })) }
    }
    fun original(v: JsonObject, origin: String) {
        MediaJSON.fields(v, "version,origin,space_id,idempotency_key,input,request_digest")
        MediaJSON.require(v == original(origin, MediaJSON.text(v, "space_id"), MediaJSON.text(v, "idempotency_key"), MediaJSON.obj(v["input"])))
    }
    fun metadata(v: JsonObject): JsonObject = JsonObject(v + ("input" to summary(v["input"])) + if (v["output"] == JsonNull) emptyMap() else mapOf("output" to JsonObject(MediaJSON.obj(v["output"]).filterKeys { it != "text" })))
    fun task(v: JsonObject, original: JsonObject, previous: JsonObject? = null, stored: Boolean = false) {
        MediaJSON.fields(v, "vision_id,space_id,idempotency_key,request_digest,input,image,deployment,created_at,updated_at,status,output,error_code")
        MediaJSON.require(MediaJSON.id(v["vision_id"], "vision-").length > 7); deployment(v["deployment"])
        val image = MediaJSON.obj(v["image"]); MediaJSON.fields(image, "width,height"); for (key in listOf("width", "height")) MediaJSON.integer(image[key], 1, 1024)
        for (key in listOf("space_id", "idempotency_key", "request_digest")) MediaJSON.require(v[key] == original[key])
        MediaJSON.require(summary(v["input"]) == original["input"])
        val start = MediaJSON.time(v["created_at"]); val updated = MediaJSON.time(v["updated_at"]); val end = MediaJSON.time(original.getValue("input").jsonObject["expires_at"])
        MediaJSON.require(end > start && end <= start.plusSeconds(90) && updated >= start)
        when (MediaJSON.text(v, "status")) {
            "running" -> MediaJSON.require(v["output"] == JsonNull && v["error_code"] == JsonNull && v["created_at"] == v["updated_at"])
            "succeeded" -> {
                val output = MediaJSON.obj(v["output"]); MediaJSON.fields(output, if (stored) "content_digest,expires_at,cleared_at" else "text,content_digest,expires_at,cleared_at")
                MediaJSON.hash(output["content_digest"]); val retain = MediaJSON.integer(original.getValue("input").jsonObject["retain_seconds"], 60, 3600)
                MediaJSON.require(MediaJSON.time(output["expires_at"]) == updated.plusSeconds(retain) && v["error_code"] == JsonNull && updated < end)
                if (output["cleared_at"] != JsonNull) { MediaJSON.require(MediaJSON.time(output["cleared_at"]) >= updated); if (!stored) MediaJSON.require(output["text"] == JsonNull) }
                else if (!stored) { text(output["text"], 2048, 8192); MediaJSON.require(output["content_digest"] == JsonPrimitive(digest(MediaJSON.str(output["text"]).toByteArray(Charsets.UTF_8)))) }
            }
            "discarded" -> MediaJSON.require(v["output"] == JsonNull && v["error_code"] == JsonPrimitive("vision_output_discarded"))
            "unknown" -> MediaJSON.require(v["output"] == JsonNull && MediaJSON.str(v["error_code"]) in listOf("vision_provider_unknown", "vision_deadline_exceeded", "vision_interrupted"))
            "failed" -> MediaJSON.require(v["output"] == JsonNull && MediaJSON.str(v["error_code"]) in listOf("vision_provider_rejected", "invalid_vision_output", "vision_output_too_large", "vision_origin_not_local", "vision_provider_unavailable"))
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
