package run.limeai.iot.core

import kotlinx.serialization.json.*
import java.time.Instant

enum class ObservationProfile { Environment, OnOff }

class ObservationException(val code: String) : Exception(code) {
    val displayMessage get() = mapOf(
        "invalid_observation_document" to "接入资料未通过核对，请重新读取",
        "observation_storage_failed" to "无法保存接入记录，请检查本机安全存储",
        "observation_record_changed" to "本机接入记录已变化，请重新打开连接",
        "observation_pending_operation" to "此设备或来源有未确认操作，请查询原操作",
        "observation_capacity" to "本机接入记录已满",
        "observation_record_missing" to "未找到本机原请求",
        "observation_review_expired" to "核对已失效，请重新查询设备"
    )[code] ?: "接入操作尚未确认，请查询原操作"
}
@ConsistentCopyVisibility
data class ObservationCandidate internal constructor(val document: JsonObject) {
    val profile get() = if ("write_paths" in document) ObservationProfile.OnOff else ObservationProfile.Environment
    val id get() = ObservationJSON.text(ObservationJSON.obj(document["source"]), "adapter_id")
    val model get() = ObservationJSON.text(ObservationJSON.obj(document["signature"]), "model")
    val manufacturer get() = ObservationJSON.text(ObservationJSON.obj(document["signature"]), "manufacturer")
    val ieee get() = ObservationJSON.text(ObservationJSON.obj(document["target"]), "ieee_address")
    val endpoint get() = document.getValue("target").jsonObject.getValue("endpoint").jsonPrimitive.int
    val expiresAt: Instant get() = ObservationJSON.time(document["expires_at"])
}
@ConsistentCopyVisibility
data class ObservationCoordinator internal constructor(val document: JsonObject) {
    val id get() = ObservationJSON.text(document, "coordinator_id")
    val ieee get() = ObservationJSON.text(document, "coordinator_ieee")
}
data class ObservationCandidates(val coordinators: List<ObservationCoordinator>, val items: List<ObservationCandidate>)
@ConsistentCopyVisibility
data class ObservationBinding internal constructor(val document: JsonObject) {
    val device get() = ObservationJSON.text(document, "device_id")
    val revision get() = ObservationJSON.text(document, "revision")
    val managed get() = document["binding"] != JsonNull
    val active get() = (document["binding"] as? JsonObject)?.get("active") == JsonPrimitive(true)
    val profile get() = if ((document["binding"] as? JsonObject)?.containsKey("write_paths") == true) ObservationProfile.OnOff else ObservationProfile.Environment
    private val target get() = ObservationJSON.obj(ObservationJSON.obj(ObservationJSON.obj(document["binding"])["manifest"])["target"])
    val coordinatorIEEE get() = ObservationJSON.text(target, "coordinator_ieee")
    val ieee get() = ObservationJSON.text(target, "ieee_address")
    val endpoint get() = target.getValue("endpoint").jsonPrimitive.int
}
data class ObservationRecord(val request: JsonObject, val result: JsonObject?) {
    val key get() = ObservationJSON.text(request, "idempotency_key")
    val device get() = ObservationJSON.text(ObservationJSON.obj(request["change"]), "device_id")
    val pending get() = result == null
    val status get() = result?.let { ObservationJSON.text(it, "status") } ?: "unknown"
    val statusText get() = mapOf("applied" to "已生效", "rejected" to "未受理", "conflict" to "设备资料已变化", "unknown" to "结果待确认")[status] ?: "结果待确认"
}

// 使用共用的有界JSON与JCS，只在本领域核对字段、来源和耐久决定。
object ObservationJSON {
    private const val onOffRevision = "sha256:a5ed590038c2d0c13e183a1cc7aeb166fbb9dc529d92366631978943c47433b0"
    internal fun fail(): Nothing = throw ObservationException("invalid_observation_document")
    internal fun require(value: Boolean) { if (!value) fail() }
    internal fun obj(value: JsonElement?): JsonObject = value as? JsonObject ?: fail()
    internal fun fields(value: JsonElement?, names: String): JsonObject = obj(value).also { require(it.keys == names.split(',').toSet()) }
    internal fun text(value: JsonElement?): String = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: fail()
    internal fun text(value: JsonObject, key: String): String = text(value[key])
    internal fun id(value: JsonElement?) { require(text(value).matches(Regex("[A-Za-z0-9_-]{1,128}"))) }
    private fun hash(value: JsonElement?) { require(text(value).matches(Regex("sha256:[a-f0-9]{64}"))) }
    internal fun integer(value: JsonElement?, range: LongRange) { val p = value as? JsonPrimitive ?: fail(); require(!p.isString && p.longOrNull in range) }
    internal fun ieee(value: JsonElement?) { val s = text(value); require(s.matches(Regex("[a-f0-9]{16}")) && s !in listOf("0000000000000000", "ffffffffffffffff")) }
    internal fun time(value: JsonElement?): Instant = try { Instant.parse(text(value)) } catch (_: Exception) { fail() }
    private fun source(value: JsonElement?) { val s = fields(value, "adapter_id,revision"); id(s["adapter_id"]); hash(s["revision"]) }
    fun parse(text: String, response: Boolean = false): JsonObject = try { IntegerJSON.parse(text, if (response) 2_000_000 else 4096, if (response) 24 else 8, if (response) 65536 else 256) } catch (_: Exception) { fail() }
    fun canonical(value: JsonElement): String = IntegerJSON.canonical(value)
    fun digest(value: JsonElement): String = IntegerJSON.digest(value)
    fun query(coordinator: String, ieee: String, endpoint: Int, profile: ObservationProfile = ObservationProfile.Environment): JsonObject {
        id(JsonPrimitive(coordinator)); ieee(JsonPrimitive(ieee)); integer(JsonPrimitive(endpoint), 1L..240L)
        return buildJsonObject { put("coordinator_id", coordinator); put("ieee_address", ieee); put("endpoint", endpoint); if (profile == ObservationProfile.OnOff) put("profile", "on_off") }
    }
    fun change(value: JsonObject): JsonObject {
        val revoke = value["type"] == JsonPrimitive("sources.revoke")
        fields(value, if (revoke) "type,device_id,expected_binding_revision" else "type,device_id,source,expected_binding_revision,expected_model_revision")
        id(value["device_id"]); hash(value["expected_binding_revision"])
        if (!revoke) { require(value["type"] == JsonPrimitive("sources.bind")); source(value["source"]); hash(value["expected_model_revision"]) }
        return value
    }
    fun candidate(value: JsonObject): ObservationCandidate {
        val writable = "write_paths" in value
        fields(value, "source,model_revision,target,manufacturer_code,signature,observed_at,expires_at,protocol,evidence" + if (writable) ",write_paths" else "")
        if (writable) require(value["write_paths"] == buildJsonArray { add("light.power") } && value["model_revision"] == JsonPrimitive(onOffRevision))
        source(value["source"]); hash(value["model_revision"]); integer(value["manufacturer_code"], 0L..65535L)
        val target = fields(value["target"], "coordinator_ieee,ieee_address,endpoint")
        ieee(target["coordinator_ieee"]); ieee(target["ieee_address"]); require(target["coordinator_ieee"] != target["ieee_address"]); integer(target["endpoint"], 1L..240L)
        val signature = fields(value["signature"], "manufacturer,model,application_version,hardware_version")
        for (key in listOf("manufacturer", "model")) { val s = text(signature[key]); require(s.trim().isNotEmpty() && s.toByteArray(Charsets.UTF_8).size <= 32 && s.none { it.code < 32 || it.code in 127..159 }) }
        integer(signature["application_version"], 0L..255L); integer(signature["hardware_version"], 0L..255L)
        val observed = time(value["observed_at"]); val expires = time(value["expires_at"])
        require(expires.isAfter(observed) && !expires.isAfter(observed.plusSeconds(60)) && value["protocol"] == JsonPrimitive("zigbee-znp") && value["evidence"] == JsonPrimitive("unauthenticated_protocol"))
        val manifest = buildJsonObject { put("mapping", if (writable) "znp-on-off-v1" else "znp-environment-v1"); for (key in listOf("target", "manufacturer_code", "signature", "model_revision")) put(key, value.getValue(key)) }
        require(obj(value["source"])["adapter_id"] == JsonPrimitive("znp-" + digest(target).removePrefix("sha256:")) && obj(value["source"])["revision"] == JsonPrimitive(digest(manifest)))
        return ObservationCandidate(value)
    }
    fun candidates(value: JsonObject): ObservationCandidates {
        fields(value, "coordinators,items,next_cursor")
        val coordinators = value["coordinators"] as? JsonArray ?: fail(); val items = value["items"] as? JsonArray ?: fail()
        require(value["next_cursor"] == JsonNull && coordinators.size <= 4 && items.size <= 64)
        val cs = coordinators.map { value -> val c = fields(value, "coordinator_id,coordinator_ieee,timeout_ms,protocol"); id(c["coordinator_id"]); ieee(c["coordinator_ieee"]); integer(c["timeout_ms"], 100L..30000L); require(c["protocol"] == JsonPrimitive("zigbee-znp")); ObservationCoordinator(c) }
        val checked = items.map { candidate(obj(it)) }
        require(cs.map { it.id }.distinct().size == cs.size && cs.map { it.ieee }.distinct().size == cs.size && checked.map { it.id }.distinct().size == checked.size)
        for (item in checked) require(cs.any { it.ieee == text(obj(item.document["target"]), "coordinator_ieee") })
        return ObservationCandidates(cs, checked)
    }
    fun binding(value: JsonObject, device: String? = null): ObservationBinding {
        fields(value, "device_id,revision,binding"); id(value["device_id"]); hash(value["revision"])
        if (device != null) require(value["device_id"] == JsonPrimitive(device))
        if (value["binding"] != JsonNull) {
            val writable = "write_paths" in obj(value["binding"])
            val b = fields(value["binding"], "policy,manifest,active,generation,changed_at" + if (writable) ",write_paths" else ""); val p = fields(b["policy"], "device_id,model_revision,source")
            if (writable) require(b["write_paths"] == buildJsonArray { add("light.power") } && p["model_revision"] == JsonPrimitive(onOffRevision) && obj(b["manifest"])["mapping"] == JsonPrimitive("znp-on-off-v1") && obj(b["manifest"])["model_revision"] == JsonPrimitive(onOffRevision))
            require(p["device_id"] == value["device_id"]); hash(p["model_revision"]); source(p["source"])
            val active = b["active"] as? JsonPrimitive ?: fail(); require(!active.isString && active.booleanOrNull != null && obj(b["manifest"]).isNotEmpty())
            parse(canonical(b.getValue("manifest"))); require(text(b["generation"]).matches(Regex("observationop-[A-Za-z0-9_-]{1,100}"))); time(b["changed_at"])
            require(digest(b.getValue("manifest")) == text(obj(p["source"]), "revision"))
        }
        require(digest(buildJsonArray { add("observation-binding-v1"); add(value.getValue("device_id")); add(value.getValue("binding")) }) == text(value["revision"]))
        return ObservationBinding(value)
    }
    internal fun request(value: JsonObject) { fields(value, "space_id,idempotency_key,change"); id(value["space_id"]); id(value["idempotency_key"]); change(obj(value["change"])) }
    fun operation(value: JsonObject, expected: JsonObject? = null) {
        fields(value, "operation_id,sequence,request,request_digest,status,reason,result,created_at")
        require(text(value["operation_id"]).matches(Regex("observationop-[A-Za-z0-9_-]{1,100}"))); integer(value["sequence"], 1L..256L); request(obj(value["request"])); time(value["created_at"])
        require(value["request_digest"] == JsonPrimitive(digest(value.getValue("request"))) && (expected == null || value["request"] == expected))
        val c = obj(obj(value["request"])["change"])
        if (value["status"] == JsonPrimitive("applied")) {
            val view = binding(obj(value["result"]), text(c["device_id"])); val b = obj(view.document["binding"]); val p = obj(b["policy"])
            require(value["reason"] == JsonNull && b["generation"] == value["operation_id"] && b["changed_at"] == value["created_at"] && view.revision != text(c["expected_binding_revision"]))
            if (c["type"] == JsonPrimitive("sources.bind")) require(view.active && p["source"] == c["source"] && p["model_revision"] == c["expected_model_revision"]) else require(!view.active)
        } else {
            val status = text(value["status"]); val reason = text(value["reason"])
            require(status in listOf("rejected", "conflict") && value["result"] == JsonNull && reason.matches(Regex("[a-z][a-z0-9_]{0,63}")) && (status == "conflict") == (reason == "revision_conflict"))
        }
    }
    fun bind(device: String, candidate: ObservationCandidate, binding: ObservationBinding): JsonObject {
        require(device == binding.device)
        return change(buildJsonObject { put("type", "sources.bind"); put("device_id", device); put("source", candidate.document.getValue("source")); put("expected_binding_revision", binding.revision); put("expected_model_revision", candidate.document.getValue("model_revision")) })
    }
    fun revoke(binding: ObservationBinding): JsonObject {
        require(binding.managed && binding.active)
        return change(buildJsonObject { put("type", "sources.revoke"); put("device_id", binding.device); put("expected_binding_revision", binding.revision) })
    }
}
