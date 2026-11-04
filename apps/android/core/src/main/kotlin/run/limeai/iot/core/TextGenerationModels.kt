package run.limeai.iot.core

import kotlinx.serialization.json.*
import java.security.MessageDigest
import java.time.Instant

class TextGenerationException(val code: String) : Exception(code) {
    val displayMessage: String get() = when (code) {
        "text_storage_failed", "text_record_changed" -> "对话记录不可用，已暂停新请求"
        "text_pending" -> "请先查询或明确放弃原文字任务"
        "text_capacity" -> "本机文字记录已满"
        "text_busy" -> "已有对话操作正在处理"
        "text_unknown" -> "结果未知，请查询原文字任务"
        "invalid_text_input" -> "消息超出上下文限制或格式无效，请缩短消息或开始新对话"
        else -> "文字材料或回答未通过校验"
    }
}
data class TextGenerationMessage(val role: String, val content: String) {
    internal fun document() = buildJsonObject { put("role", role); put("content", content) }
}
data class TextGenerationCapabilities(val document: JsonObject) { val configured get() = document["configured"] == JsonPrimitive(true) }
data class TextGenerationRecord(val original: JsonObject, val observation: JsonObject?, val rejectedCode: String?, val discardIntents: List<String>, val text: String? = null) {
    // 本机仅保存摘要与去正文观测，消息和回答只存在于当前交互内存。
    val key get() = MediaJSON.text(original, "idempotency_key")
    val space get() = MediaJSON.text(original, "space_id")
    val status get() = observation?.let { MediaJSON.text(it, "status") } ?: if (rejectedCode == null) "unresolved" else "rejected"
    val pending get() = status in listOf("unresolved", "running", "unknown")
    val outputExpiresAt get() = observation?.get("output")?.takeUnless { it == JsonNull }?.jsonObject?.get("expires_at")?.let(MediaJSON::time)
    val canDiscard get() = status in listOf("running", "unknown") || status == "succeeded" && observation?.get("output")?.jsonObject?.get("cleared_at") == JsonNull
    val statusText get() = mapOf("unresolved" to "结果待核实", "running" to "正在生成", "succeeded" to "回答已完成", "failed" to "生成未完成", "unknown" to "结果未知", "discarded" to "已放弃输出", "rejected" to "请求未受理")[status] ?: "结果待核实"
}
object TextGenerationRequests {
    fun input(messages: List<TextGenerationMessage>, instructions: String = "", retainSeconds: Int = 600, expiresAt: String = SpeechJSON.timestamp(Instant.now().plusSeconds(85))): JsonObject = checked(buildJsonObject {
        put("instructions", instructions); put("messages", JsonArray(messages.map { it.document() })); put("retain_seconds", retainSeconds); put("expires_at", expiresAt)
    })
    fun parse(text: String): JsonObject = try { checked(IntegerJSON.parse(text, maxBytes = 65536, maxDepth = 4, maxNodes = 128)) }
    catch (error: Exception) { throw TextGenerationException("invalid_text_input") }
    internal fun checked(v: JsonObject): JsonObject = try {
        MediaJSON.fields(v, "instructions,messages,retain_seconds,expires_at")
        TextGenerationJSON.text(v["instructions"], 1024, empty = true)
        val messages = v["messages"] as? JsonArray ?: throw MediaException("invalid_media_document")
        MediaJSON.require(messages.size in 1..15 && messages.size % 2 == 1)
        var bytes = MediaJSON.str(v["instructions"]).toByteArray(Charsets.UTF_8).size
        messages.forEachIndexed { i, value ->
            val m = MediaJSON.obj(value); MediaJSON.fields(m, "role,content")
            MediaJSON.require(m["role"] == JsonPrimitive(if (i % 2 == 0) "user" else "assistant"))
            TextGenerationJSON.text(m["content"], 2048); bytes += MediaJSON.str(m["content"]).toByteArray(Charsets.UTF_8).size
        }
        MediaJSON.require(bytes <= 8192); MediaJSON.integer(v["retain_seconds"], 60, 3600)
        JsonObject(v + ("expires_at" to JsonPrimitive(TextGenerationJSON.requestTime(v["expires_at"]))))
    } catch (error: Exception) { throw TextGenerationException("invalid_text_input") }
}
internal object TextGenerationJSON {
    fun digest(bytes: ByteArray) = "sha256:" + MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun text(value: JsonElement?, maximum: Int, empty: Boolean = false) {
        val text = MediaJSON.str(value); var i = 0
        while (i < text.length) { if (text[i].isHighSurrogate()) MediaJSON.require(++i < text.length && text[i].isLowSurrogate()) else MediaJSON.require(!text[i].isLowSurrogate()); i++ }
        MediaJSON.require((empty || text.any { !it.isWhitespace() && it != '\uFEFF' }) && text.codePointCount(0, text.length) <= maximum && text.toByteArray(Charsets.UTF_8).size <= 8192 && !text.any { it.code < 32 && it !in "\n\t" || it.code in 127..159 })
    }
    fun requestTime(value: JsonElement?): String {
        MediaJSON.require(!Regex("\\.\\d{4,}").containsMatchIn(MediaJSON.str(value)))
        return SpeechJSON.timestamp(MediaJSON.time(value))
    }
    fun summary(value: JsonElement?): JsonObject {
        val v = MediaJSON.obj(value); MediaJSON.fields(v, "context_digest,context_bytes,message_count,retain_seconds,expires_at")
        MediaJSON.hash(v["context_digest"]); MediaJSON.integer(v["context_bytes"], 1, 8192)
        MediaJSON.require(MediaJSON.integer(v["message_count"], 1, 15) % 2 == 1L); MediaJSON.integer(v["retain_seconds"], 60, 3600)
        return JsonObject(v + ("expires_at" to JsonPrimitive(requestTime(v["expires_at"]))))
    }
    fun summarize(input: JsonObject): JsonObject {
        val messages = input.getValue("messages").jsonArray
        val bytes = MediaJSON.str(input["instructions"]).toByteArray(Charsets.UTF_8).size + messages.sumOf { MediaJSON.str(it.jsonObject["content"]).toByteArray(Charsets.UTF_8).size }
        return buildJsonObject { put("context_digest", IntegerJSON.digest(buildJsonObject { put("instructions", input.getValue("instructions")); put("messages", messages) })); put("context_bytes", bytes); put("message_count", messages.size); put("retain_seconds", input.getValue("retain_seconds")); put("expires_at", input.getValue("expires_at")) }
    }
    fun deployment(value: JsonElement?) {
        val v = MediaJSON.obj(value); MediaJSON.fields(v, "adapter,revision,model,data_location")
        MediaJSON.require(v["adapter"] == JsonPrimitive("ollama-text-v1") && v["data_location"] == JsonPrimitive("local")); MediaJSON.hash(v["revision"])
        MediaJSON.require(MediaJSON.str(v["model"]).matches(Regex("[A-Za-z0-9_:./-]{1,128}")))
    }
    fun capabilities(value: JsonElement?): TextGenerationCapabilities {
        val v = MediaJSON.obj(value)
        if (v["configured"] == JsonPrimitive(false)) MediaJSON.fields(v, "configured,capability")
        else {
            MediaJSON.fields(v, "configured,capability,deployment,max_messages,max_context_bytes,max_instructions_characters,max_text_bytes,max_characters,max_output_tokens,max_deadline_seconds,max_retain_seconds,concurrency,streaming,provider_cancellation,input_storage,server_memory,device_execution")
            MediaJSON.require(v["configured"] == JsonPrimitive(true)); deployment(v["deployment"])
            for ((key, number) in mapOf("max_messages" to 15, "max_context_bytes" to 8192, "max_instructions_characters" to 1024, "max_text_bytes" to 8192, "max_characters" to 2048, "max_output_tokens" to 1024, "max_deadline_seconds" to 90, "max_retain_seconds" to 3600, "concurrency" to 1)) MediaJSON.require(v[key] == JsonPrimitive(number))
            for (key in listOf("streaming", "provider_cancellation", "server_memory", "device_execution")) MediaJSON.require(v[key] == JsonPrimitive(false))
            MediaJSON.require(v["input_storage"] == JsonPrimitive("digest_only"))
        }
        MediaJSON.require(v["capability"] == JsonPrimitive("text.generate")); return TextGenerationCapabilities(v)
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
        MediaJSON.fields(v, "text_id,space_id,idempotency_key,request_digest,input,deployment,created_at,updated_at,status,output,usage,error_code")
        MediaJSON.require(MediaJSON.id(v["text_id"], "text-").length > 5); deployment(v["deployment"])
        for (key in listOf("space_id", "idempotency_key", "request_digest")) MediaJSON.require(v[key] == original[key])
        MediaJSON.require(summary(v["input"]) == original["input"])
        val start = MediaJSON.time(v["created_at"]); val updated = MediaJSON.time(v["updated_at"]); val end = MediaJSON.time(original.getValue("input").jsonObject["expires_at"])
        MediaJSON.require(end > start && end <= start.plusSeconds(90) && updated >= start)
        if (v["usage"] != JsonNull) {
            MediaJSON.require(v["status"] == JsonPrimitive("succeeded")); val usage = MediaJSON.obj(v["usage"]); MediaJSON.fields(usage, "input_tokens,output_tokens")
            MediaJSON.integer(usage["input_tokens"], 0, 65536); MediaJSON.integer(usage["output_tokens"], 1, 1024)
        }
        when (MediaJSON.text(v, "status")) {
            "running" -> MediaJSON.require(v["output"] == JsonNull && v["error_code"] == JsonNull && v["created_at"] == v["updated_at"])
            "succeeded" -> {
                val output = MediaJSON.obj(v["output"]); MediaJSON.fields(output, if (stored) "content_digest,expires_at,cleared_at" else "text,content_digest,expires_at,cleared_at")
                MediaJSON.hash(output["content_digest"]); val retain = MediaJSON.integer(original.getValue("input").jsonObject["retain_seconds"], 60, 3600)
                MediaJSON.require(MediaJSON.time(output["expires_at"]) == updated.plusSeconds(retain) && v["error_code"] == JsonNull && updated < end)
                if (output["cleared_at"] != JsonNull) { MediaJSON.require(MediaJSON.time(output["cleared_at"]) >= updated); if (!stored) MediaJSON.require(output["text"] == JsonNull) }
                else if (!stored) { text(output["text"], 2048); MediaJSON.require(output["content_digest"] == JsonPrimitive(digest(MediaJSON.str(output["text"]).toByteArray(Charsets.UTF_8)))) }
            }
            "discarded" -> MediaJSON.require(v["output"] == JsonNull && v["error_code"] == JsonPrimitive("text_output_discarded"))
            "unknown" -> MediaJSON.require(v["output"] == JsonNull && MediaJSON.str(v["error_code"]) in listOf("text_provider_unknown", "text_deadline_exceeded", "text_interrupted"))
            "failed" -> MediaJSON.require(v["output"] == JsonNull && MediaJSON.str(v["error_code"]) in listOf("text_provider_rejected", "invalid_text_output", "text_output_too_large", "text_origin_not_local", "text_provider_unavailable"))
            else -> MediaJSON.require(false)
        }
        if (previous != null) {
            val next = metadata(v); val changing = setOf("status", "updated_at", "output", "usage", "error_code")
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
