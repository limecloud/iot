package run.limeai.iot.core

import kotlinx.serialization.json.*
import java.security.MessageDigest
import java.time.Duration
import java.time.Instant
import java.util.Base64

class MediaException(val code: String) : Exception(code) {
    val displayMessage: String get() = when (code) {
        "media_storage_failed", "media_record_changed" -> "无法读取或保存本机音频记录，请检查安全存储"
        "media_pending_operation" -> "请先查询同类音频原操作"
        "media_capacity" -> "本机音频操作记录已满"
        "media_unknown" -> "结果未知，请查询音频原操作"
        "media_busy" -> "已有音频操作正在处理"
        "invalid_media_audio" -> "请选择不超过4 MiB、60秒的16位PCM WAV文件"
        else -> "音频材料或响应未通过校验"
    }
}
class MediaItem internal constructor(val metadata: JsonObject, val available: Boolean, val deletedAt: String?) {
    val id: String get() = MediaJSON.text(metadata, "media_id")
    val byteLength: Long get() = MediaJSON.integer(metadata["byte_length"], 46, MediaChanges.MAX_AUDIO_BYTES.toLong())
    val expiresAt: String get() = MediaJSON.text(metadata, "expires_at")
    val durationSeconds: Double get() = MediaJSON.obj(metadata["audio"]).let { it.getValue("frames").jsonPrimitive.long.toDouble() / it.getValue("sample_rate").jsonPrimitive.long }
}
class MediaGrant internal constructor(val document: JsonObject) {
    val id: String get() = MediaJSON.text(document, "grant_id")
    val mediaId: String get() = MediaJSON.text(document, "media_id")
    val deviceId: String get() = MediaJSON.text(document, "device_id")
    val bindingRevision: String get() = MediaJSON.text(document, "binding_revision")
    val expiresAt: String get() = MediaJSON.text(document, "expires_at")
    val active: Boolean get() = document["active_in_process"] == JsonPrimitive(true) && document["binding_current"] == JsonPrimitive(true) && document["revoked_at"] == JsonNull && MediaJSON.time(document["expires_at"]) > Instant.now()
}
class MediaPage internal constructor(val configured: Boolean, val items: List<MediaItem>, val grants: List<MediaGrant>)
class MediaRecord internal constructor(val original: JsonObject, val result: JsonObject?) {
    val key: String get() = MediaJSON.text(original, "idempotency_key")
    val space: String get() = MediaJSON.text(original, "space_id")
    val change: JsonObject get() = MediaJSON.obj(original["change"])
    val type: String get() = MediaJSON.text(change, "type")
    val statusText: String get() = if (result == null) "结果待核实" else "原操作已核实"
}
object MediaChanges {
    const val MAX_AUDIO_BYTES = 4 * 1024 * 1024
    fun parse(text: String): JsonObject = IntegerJSON.parse(text, 5_596_504, 5, 64).also(MediaJSON::change)
    fun upload(bytes: ByteArray, retainSeconds: Int): JsonObject {
        MediaJSON.wav(bytes)
        return buildJsonObject { put("type", "media.upload"); put("content_base64", Base64.getEncoder().encodeToString(bytes)); put("retain_seconds", retainSeconds) }.also(MediaJSON::change)
    }
    fun grant(mediaId: String, deviceId: String, bindingRevision: String, validForSeconds: Int): JsonObject = buildJsonObject {
        put("type", "media.grant"); put("media_id", mediaId); put("device_id", deviceId); put("expected_binding_revision", bindingRevision); put("valid_for_seconds", validForSeconds)
    }.also(MediaJSON::change)
    fun revoke(grantId: String): JsonObject = buildJsonObject { put("type", "media.revoke"); put("grant_id", grantId) }.also(MediaJSON::change)
    fun delete(mediaId: String): JsonObject = buildJsonObject { put("type", "media.delete"); put("media_id", mediaId) }.also(MediaJSON::change)
}

internal object MediaJSON {
    private fun fail(): Nothing = throw MediaException("invalid_media_document")
    fun require(value: Boolean) { if (!value) fail() }
    fun obj(value: JsonElement?): JsonObject = value as? JsonObject ?: fail()
    fun fields(value: JsonObject, names: String) { require(value.keys == names.split(',').toSet()) }
    fun str(value: JsonElement?): String = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: fail()
    fun text(value: JsonObject, key: String): String = str(value[key])
    fun id(value: JsonElement?, prefix: String = ""): String = str(value).also { require(it.matches(Regex("[A-Za-z0-9_-]{1,128}")) && it.startsWith(prefix)) }
    fun hash(value: JsonElement?) { require(str(value).matches(Regex("sha256:[a-f0-9]{64}"))) }
    fun integer(value: JsonElement?, min: Long, max: Long): Long = (value as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull?.takeIf { it in min..max } ?: fail()
    fun bool(value: JsonElement?): Boolean = (value as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull ?: fail()
    fun time(value: JsonElement?): Instant {
        val text = str(value)
        require(text.length <= 40 && text.matches(Regex("\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d{1,9})?(?:Z|[+-]\\d\\d:\\d\\d)")))
        return runCatching { Instant.parse(text) }.getOrElse { fail() }
    }
    private fun duration(value: JsonObject): Duration = Duration.between(time(value["created_at"]), time(value["expires_at"]))
    fun audio(value: JsonElement?): Long {
        val v = obj(value); fields(v, "sample_rate,channels,bits_per_sample,frames")
        val rate = integer(v["sample_rate"], 8000, 48000); val channels = integer(v["channels"], 1, 2)
        require(v["bits_per_sample"] == JsonPrimitive(16))
        return integer(v["frames"], 1, rate * 60) * channels * 2 + 44
    }
    fun wav(bytes: ByteArray): JsonObject {
        fun invalid(): Nothing = throw MediaException("invalid_media_audio")
        if (bytes.size !in 46..MediaChanges.MAX_AUDIO_BYTES) invalid()
        fun u16(i: Int): Long = (bytes[i].toLong() and 255) or ((bytes[i + 1].toLong() and 255) shl 8)
        fun u32(i: Int): Long = u16(i) or (u16(i + 2) shl 16)
        fun tag(i: Int) = String(bytes, i, 4, Charsets.US_ASCII)
        if (tag(0) != "RIFF" || tag(8) != "WAVE" || u32(4) != bytes.size.toLong() - 8) invalid()
        var p = 12; var rate = 0L; var channels = 0L; var length: Long? = null
        while (p < bytes.size) {
            if (bytes.size - p < 8) invalid()
            val size = u32(p + 4); val start = p + 8; val end = start.toLong() + size
            if (end > bytes.size) invalid()
            when (tag(p)) {
                "fmt " -> {
                    if (rate != 0L || length != null || size != 16L) invalid()
                    channels = u16(start + 2); rate = u32(start + 4)
                    if (u16(start) != 1L || channels !in 1..2 || rate !in 8000..48000 || u16(start + 14) != 16L || u16(start + 12) != channels * 2 || u32(start + 8) != rate * channels * 2) invalid()
                }
                "data" -> { if (rate == 0L || length != null || size == 0L) invalid(); length = size }
                else -> invalid()
            }
            p = (end + size % 2).toInt(); if (p > bytes.size) invalid()
        }
        val size = length ?: invalid()
        if (channels == 0L || size % (channels * 2) != 0L || size / (channels * 2) > rate * 60) invalid()
        return buildJsonObject { put("sample_rate", rate); put("channels", channels); put("bits_per_sample", 16); put("frames", size / (channels * 2)) }
    }
    fun change(v: JsonObject) {
        when (text(v, "type")) {
            "media.upload" -> {
                fields(v, "type,content_base64,retain_seconds"); integer(v["retain_seconds"], 60, 86400)
                val encoded = text(v, "content_base64"); require(encoded.length <= 5_592_408)
                val bytes = runCatching { Base64.getDecoder().decode(encoded) }.getOrElse { fail() }
                require(Base64.getEncoder().encodeToString(bytes) == encoded); wav(bytes)
            }
            "media.grant" -> { fields(v, "type,media_id,device_id,expected_binding_revision,valid_for_seconds"); id(v["media_id"]); id(v["device_id"]); hash(v["expected_binding_revision"]); integer(v["valid_for_seconds"], 5, 600) }
            "media.revoke" -> { fields(v, "type,grant_id"); id(v["grant_id"]) }
            "media.delete" -> { fields(v, "type,media_id"); id(v["media_id"]) }
            else -> fail()
        }
    }
    fun original(origin: String, space: String, key: String, value: JsonObject): JsonObject {
        id(JsonPrimitive(space)); id(JsonPrimitive(key)); change(value)
        val summary = if (value["type"] == JsonPrimitive("media.upload")) {
            val bytes = Base64.getDecoder().decode(text(value, "content_base64"))
            buildJsonObject {
                put("type", "media.upload"); put("retain_seconds", value.getValue("retain_seconds")); put("byte_length", bytes.size); put("audio", wav(bytes))
                put("content_digest", "sha256:" + MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
            }
        } else value
        val request = buildJsonObject { put("space_id", space); put("idempotency_key", key); put("change", value) }
        return buildJsonObject { put("version", 1); put("origin", origin); put("space_id", space); put("idempotency_key", key); put("request_digest", IntegerJSON.digest(request)); put("change", summary) }
    }
    fun original(v: JsonObject, origin: String) {
        fields(v, "version,origin,space_id,idempotency_key,request_digest,change")
        require(v["version"] == JsonPrimitive(1) && v["origin"] == JsonPrimitive(origin)); id(v["space_id"]); id(v["idempotency_key"]); hash(v["request_digest"])
        val c = obj(v["change"])
        if (c["type"] == JsonPrimitive("media.upload")) {
            fields(c, "type,content_digest,byte_length,audio,retain_seconds"); hash(c["content_digest"]); integer(c["retain_seconds"], 60, 86400)
            require(integer(c["byte_length"], 46, MediaChanges.MAX_AUDIO_BYTES.toLong()) == audio(c["audio"]))
        } else change(c)
    }
    private fun metadata(v: JsonObject, space: String) {
        fields(v, "media_id,space_id,content_type,purpose,actor,byte_length,content_digest,audio,created_at,expires_at")
        id(v["media_id"], "media-")
        require(v["space_id"] == JsonPrimitive(space) && v["content_type"] == JsonPrimitive("audio/wav") && v["purpose"] == JsonPrimitive("device_playback") && v["actor"] == JsonPrimitive("local_owner"))
        hash(v["content_digest"]); require(integer(v["byte_length"], 46, MediaChanges.MAX_AUDIO_BYTES.toLong()) == audio(v["audio"]))
        require(duration(v) >= Duration.ofSeconds(60) && duration(v) <= Duration.ofSeconds(86400))
    }
    private fun grant(v: JsonObject) {
        id(v["grant_id"], "grant-"); id(v["media_id"]); id(v["device_id"]); hash(v["binding_revision"])
        require(duration(v) > Duration.ZERO && duration(v) <= Duration.ofSeconds(600))
    }
    fun page(v: JsonObject, space: String): MediaPage {
        id(JsonPrimitive(space)); fields(v, "space_id,configured,items,grants,next_cursor")
        val configured = bool(v["configured"]); val items = v["items"] as? JsonArray ?: fail(); val grants = v["grants"] as? JsonArray ?: fail()
        require(v["space_id"] == JsonPrimitive(space) && v["next_cursor"] == JsonNull && items.size <= 256 && grants.size <= 512 && (configured || items.isEmpty() && grants.isEmpty()))
        val objects = mutableMapOf<String, JsonObject>(); val ids = mutableSetOf<String>()
        val checkedItems = items.map { value ->
            val i = obj(value); fields(i, "metadata,available,deleted_at"); val m = obj(i["metadata"]); metadata(m, space)
            val available = bool(i["available"]); require(objects.put(text(m, "media_id"), m) == null)
            if (i["deleted_at"] != JsonNull) require(!available && time(i["deleted_at"]) >= time(m["created_at"]))
            MediaItem(m, available, i["deleted_at"]?.takeUnless { it == JsonNull }?.let(::str))
        }
        val checkedGrants = grants.map { value ->
            val g = obj(value); fields(g, "grant_id,media_id,device_id,binding_revision,created_at,expires_at,active_in_process,binding_current,revoked_at,pulls"); grant(g)
            require(ids.add(text(g, "grant_id")))
            val media = objects[text(g, "media_id")] ?: fail(); val pulls = g["pulls"] as? JsonArray ?: fail()
            require(time(g["created_at"]) >= time(media["created_at"]) && time(g["expires_at"]) <= time(media["expires_at"]) && pulls.size <= 16)
            val active = bool(g["active_in_process"]); bool(g["binding_current"])
            if (g["revoked_at"] != JsonNull) require(!active && time(g["revoked_at"]) >= time(g["created_at"]))
            for (pull in pulls) {
                val p = obj(pull); fields(p, "prepared_at,method,range_start,range_end,status"); time(p["prepared_at"])
                require(text(p, "method") in listOf("GET", "HEAD") && integer(p["status"], 200, 206) in listOf(200L, 206L))
                val size = integer(media["byte_length"], 46, MediaChanges.MAX_AUDIO_BYTES.toLong())
                val start = integer(p["range_start"], 0, size - 1); integer(p["range_end"], start, size - 1)
            }
            MediaGrant(g)
        }
        return MediaPage(configured, checkedItems, checkedGrants)
    }
    fun operation(v: JsonObject, original: JsonObject) {
        fields(v, "space_id,operation_id,idempotency_key,request_digest,kind,created_at,result")
        id(v["operation_id"], "mediaop-"); time(v["created_at"]); val c = obj(original["change"]); val r = obj(v["result"])
        require(v["space_id"] == original["space_id"] && v["idempotency_key"] == original["idempotency_key"] && v["request_digest"] == original["request_digest"] && v["kind"] == c["type"])
        when (text(v, "kind")) {
            "media.upload" -> {
                fields(r, "type,media"); require(r["type"] == JsonPrimitive("uploaded")); val m = obj(r["media"]); metadata(m, text(original, "space_id"))
                require(m["created_at"] == v["created_at"] && m["content_digest"] == c["content_digest"] && m["byte_length"] == c["byte_length"] && m["audio"] == c["audio"])
                require(duration(m) == Duration.ofSeconds(integer(c["retain_seconds"], 60, 86400)))
            }
            "media.grant" -> {
                fields(r, "type,grant_id,media_id,device_id,binding_revision,created_at,expires_at,issued_in_process"); grant(r); bool(r["issued_in_process"])
                require(r["type"] == JsonPrimitive("granted") && r["media_id"] == c["media_id"] && r["device_id"] == c["device_id"] && r["binding_revision"] == c["expected_binding_revision"] && r["created_at"] == v["created_at"])
                require(duration(r) <= Duration.ofSeconds(integer(c["valid_for_seconds"], 5, 600)))
            }
            "media.delete" -> { fields(r, "type,media_id"); require(r["type"] == JsonPrimitive("deleted") && r["media_id"] == c["media_id"]) }
            "media.revoke" -> { fields(r, "type,grant_id"); require(r["type"] == JsonPrimitive("revoked") && r["grant_id"] == c["grant_id"]) }
            else -> fail()
        }
    }
    fun stable(value: JsonObject): JsonObject {
        val result = obj(value["result"])
        return if (result["type"] != JsonPrimitive("granted")) value else JsonObject(value + ("result" to JsonObject(result + ("issued_in_process" to JsonPrimitive(false)))))
    }
    fun scope(change: JsonObject): String = text(change, "type").let { type -> type + ":" + when (type) { "media.grant" -> text(change, "device_id"); "media.revoke" -> text(change, "grant_id"); "media.delete" -> text(change, "media_id"); else -> "" } }
}
