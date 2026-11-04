package run.limeai.iot.core

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.time.Instant
import java.util.UUID

class ZigbeeException(val code: String) : Exception(code) {
    val displayMessage get() = mapOf(
        "invalid_zigbee_response" to "入网资料未通过核对，请重新读取",
        "invalid_zigbee_change" to "请填写1–120秒的开放时长",
        "zigbee_storage_failed" to "无法保存或读取入网记录，请查询原操作",
        "zigbee_record_changed" to "本机入网记录已变化，请保留原记录后重新连接",
        "zigbee_operation_unresolved" to "此前入网结果未确认，请查询原操作或明确关闭",
        "zigbee_operation_capacity" to "本机入网记录已满",
        "zigbee_review_changed" to "协调器配置已变化，请重新核对",
        "zigbee_review_expired" to "入网确认已过期，请重新核对",
        "zigbee_record_missing" to "未找到本机原请求"
    )[code] ?: "入网结果待确认，请查询原操作"
}
@ConsistentCopyVisibility
data class ZigbeeCoordinator internal constructor(val document: JsonObject) {
    val id get() = ObservationJSON.text(document, "coordinator_id")
    val ieee get() = ObservationJSON.text(document, "coordinator_ieee")
    val revision get() = ObservationJSON.text(document, "revision")
}
@ConsistentCopyVisibility
data class ZigbeePreparation internal constructor(val coordinator: ZigbeeCoordinator, val change: JsonObject) {
    val seconds get() = change.getValue("duration_seconds").jsonPrimitive.int
}
data class ZigbeeRecord(val request: JsonObject, val result: JsonObject?) {
    val key get() = ObservationJSON.text(request, "idempotency_key")
    val coordinator get() = ObservationJSON.text(ObservationJSON.obj(request["change"]), "coordinator_id")
    val seconds get() = request.getValue("change").jsonObject.getValue("duration_seconds").jsonPrimitive.int
    val accepted get() = result?.get("status") == JsonPrimitive("protocol_accepted")
    val statusText get() = if (accepted) "协议已受理" else "结果未知"
}

object ZigbeeJSON {
    private inline fun <T> checked(work: () -> T): T = try { work() } catch (_: Exception) { throw ZigbeeException("invalid_zigbee_response") }
    fun parse(text: String): JsonObject = checked { IntegerJSON.parse(text, 2_000_000, 12, 65536) }
    fun change(value: JsonObject) = checked {
        val c = ObservationJSON.fields(value, "coordinator_id,expected_revision,duration_seconds")
        ObservationJSON.id(c["coordinator_id"]); hash(c["expected_revision"]); ObservationJSON.integer(c["duration_seconds"], 0L..120L)
    }
    private fun hash(value: JsonElement?) { ObservationJSON.require(ObservationJSON.text(value).matches(Regex("sha256:[a-f0-9]{64}"))) }
    private fun coordinator(value: JsonElement): ZigbeeCoordinator {
        val c = ObservationJSON.fields(value, "coordinator_id,coordinator_ieee,revision,timeout_ms")
        ObservationJSON.id(c["coordinator_id"]); ObservationJSON.ieee(c["coordinator_ieee"]); hash(c["revision"]); ObservationJSON.integer(c["timeout_ms"], 100L..30000L)
        return ZigbeeCoordinator(c)
    }
    fun coordinators(value: JsonObject): List<ZigbeeCoordinator> = checked {
        val p = ObservationJSON.fields(value, "items,next_cursor"); val items = p["items"] as? JsonArray ?: ObservationJSON.fail()
        ObservationJSON.require(p["next_cursor"] == JsonNull && items.size <= 4)
        items.map(::coordinator).also { records -> ObservationJSON.require(records.map { it.id }.distinct().size == records.size && records.map { it.ieee }.distinct().size == records.size) }
    }
    internal fun request(value: JsonObject) {
        val r = ObservationJSON.fields(value, "space_id,idempotency_key,change"); ObservationJSON.id(r["space_id"]); ObservationJSON.id(r["idempotency_key"]); change(ObservationJSON.obj(r["change"]))
    }
    private fun time(value: JsonElement?): Instant {
        val text = ObservationJSON.text(value)
        ObservationJSON.require(text.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z")))
        return ObservationJSON.time(value)
    }
    fun operation(value: JsonObject, expected: JsonObject? = null, previous: JsonObject? = null): ZigbeeRecord = checked {
        val o = ObservationJSON.fields(value, "operation_id,sequence,request,request_digest,coordinator,status,reason,result,created_at,blocked_until,completed_at")
        ObservationJSON.id(o["operation_id"]); ObservationJSON.integer(o["sequence"], 1L..256L)
        val request = ObservationJSON.obj(o["request"]); request(request)
        val change = ObservationJSON.obj(request["change"]); val owner = coordinator(o.getValue("coordinator"))
        ObservationJSON.require((expected == null || request == expected) && o["request_digest"] == JsonPrimitive(IntegerJSON.digest(request)) && change["coordinator_id"] == JsonPrimitive(owner.id) && change["expected_revision"] == JsonPrimitive(owner.revision))
        val created = time(o["created_at"]); val blocked = time(o["blocked_until"])
        val duration = owner.document.getValue("timeout_ms").jsonPrimitive.long + change.getValue("duration_seconds").jsonPrimitive.long * 1000
        ObservationJSON.require(blocked == created.plusMillis(duration))
        if (o["completed_at"] != JsonNull) ObservationJSON.require(!time(o["completed_at"]).isBefore(created))
        if (o["status"] == JsonPrimitive("protocol_accepted")) {
            val result = ObservationJSON.fields(o["result"], "coordinator_ieee,duration_seconds,observed_at"); time(o["completed_at"])
            ObservationJSON.require(o["reason"] == JsonNull && result["coordinator_ieee"] == JsonPrimitive(owner.ieee) && result["duration_seconds"] == change["duration_seconds"] && result["observed_at"] == o["completed_at"])
        } else {
            val reason = ObservationJSON.text(o["reason"])
            ObservationJSON.require(o["status"] == JsonPrimitive("unknown") && o["result"] == JsonNull && reason.matches(Regex("[a-z0-9_]{1,64}")) && (o["completed_at"] != JsonNull || reason == "not_confirmed"))
        }
        if (previous != null) {
            for (key in listOf("operation_id", "sequence", "request", "request_digest", "coordinator", "created_at", "blocked_until")) ObservationJSON.require(previous[key] == o[key])
            if (previous["completed_at"] != JsonNull) ObservationJSON.require(previous == value)
        }
        ZigbeeRecord(request, value)
    }
    fun history(value: JsonObject, space: String): List<ZigbeeRecord> = checked {
        val p = ObservationJSON.fields(value, "items,next_cursor"); val items = p["items"] as? JsonArray ?: ObservationJSON.fail()
        ObservationJSON.require(p["next_cursor"] == JsonNull && items.size <= 256)
        items.mapIndexed { index, item ->
            val doc = ObservationJSON.obj(item); val record = operation(doc)
            ObservationJSON.require(doc["sequence"] == JsonPrimitive(index + 1) && record.request["space_id"] == JsonPrimitive(space)); record
        }.also { records -> ObservationJSON.require(records.map { it.key }.distinct().size == records.size && records.map { it.result?.get("operation_id") }.distinct().size == records.size) }
    }
    internal fun canOpen(preparation: ZigbeePreparation, records: List<ZigbeeRecord>, history: List<ZigbeeRecord>, now: Instant) {
        for (record in records) history.firstOrNull { it.key == record.key }?.result?.let { operation(it, record.request, record.result) }
        if (preparation.seconds == 0) return
        for (record in records.filter { it.coordinator == preparation.coordinator.id }) if (history.none { it.key == record.key }) throw ZigbeeException("zigbee_operation_unresolved")
        for (record in history.filter { it.coordinator == preparation.coordinator.id && !it.accepted }) if (time(record.result?.get("blocked_until")).isAfter(now)) throw ZigbeeException("zigbee_operation_unresolved")
    }
}

class ZigbeeClient(private val gateway: GatewayClient, private val store: SessionStore, private val now: () -> Instant = Instant::now) {
    companion object { private val mutations = Mutex() }
    private val storageKey = gateway.origin + "#zigbee-operations"
    private var previous: String? = null; private var loaded = false
    private suspend fun load(): List<ZigbeeRecord> = try {
        val text = store.load(storageKey)
        if (loaded && text != previous) throw ZigbeeException("zigbee_record_changed")
        val records = if (text == null) emptyList() else {
            val v = ObservationJSON.fields(ZigbeeJSON.parse(text), "version,origin,records"); val items = v["records"] as? JsonArray ?: ObservationJSON.fail()
            ObservationJSON.require(v["version"] == JsonPrimitive(1) && v["origin"] == JsonPrimitive(gateway.origin) && items.size <= 256)
            items.map { item ->
                val r = ObservationJSON.fields(item, "request,result"); val request = ObservationJSON.obj(r["request"]); ZigbeeJSON.request(request)
                if (r["result"] == JsonNull) ZigbeeRecord(request, null) else ZigbeeJSON.operation(ObservationJSON.obj(r["result"]), request)
            }.also { records -> ObservationJSON.require(records.map { ObservationJSON.text(it.request, "space_id") + ":" + it.key }.distinct().size == records.size) }
        }
        previous = text; loaded = true; records
    } catch (error: CancellationException) { throw error } catch (error: ZigbeeException) { throw error } catch (_: Exception) { throw ZigbeeException("zigbee_storage_failed") }
    private suspend fun persist(records: List<ZigbeeRecord>) {
        val text = IntegerJSON.canonical(buildJsonObject { put("version", 1); put("origin", gateway.origin); put("records", JsonArray(records.map { buildJsonObject { put("request", it.request); put("result", it.result ?: JsonNull) } })) })
        ZigbeeJSON.parse(text)
        try {
            if (store.load(storageKey) != previous) throw ZigbeeException("zigbee_record_changed")
            store.save(storageKey, text)
            if (store.load(storageKey) != text) throw ZigbeeException("zigbee_storage_failed")
            previous = text; loaded = true
        } catch (error: CancellationException) { throw error } catch (error: ZigbeeException) { throw error } catch (_: Exception) { throw ZigbeeException("zigbee_storage_failed") }
    }
    suspend fun records(space: String): List<ZigbeeRecord> = mutations.withLock { ObservationJSON.id(JsonPrimitive(space)); load().filter { ObservationJSON.text(it.request, "space_id") == space } }
    suspend fun coordinators(space: String): List<ZigbeeCoordinator> { ObservationJSON.id(JsonPrimitive(space)); return ZigbeeJSON.coordinators(gateway.observationCall(space, "/zigbee-coordinators")) }
    suspend fun history(space: String): List<ZigbeeRecord> { ObservationJSON.id(JsonPrimitive(space)); return ZigbeeJSON.history(gateway.observationCall(space, "/zigbee-operations"), space) }
    suspend fun prepare(space: String, coordinator: String, seconds: Int): ZigbeePreparation = mutations.withLock {
        if (seconds !in 0..120) throw ZigbeeException("invalid_zigbee_change")
        val records = load().filter { ObservationJSON.text(it.request, "space_id") == space }
        val selected = coordinators(space).firstOrNull { it.id == coordinator } ?: throw ZigbeeException("zigbee_review_changed")
        val preparation = ZigbeePreparation(selected, buildJsonObject { put("coordinator_id", coordinator); put("expected_revision", selected.revision); put("duration_seconds", seconds) })
        ZigbeeJSON.canOpen(preparation, records, history(space), now()); preparation
    }
    suspend fun submit(space: String, preparation: ZigbeePreparation, expiresAt: Instant, key: String = UUID.randomUUID().toString()): ZigbeeRecord = mutations.withLock {
        ObservationJSON.id(JsonPrimitive(space)); ObservationJSON.id(JsonPrimitive(key)); ZigbeeJSON.change(preparation.change)
        val request = buildJsonObject { put("space_id", space); put("idempotency_key", key); put("change", preparation.change) }; val records = load()
        records.firstOrNull { it.key == key && ObservationJSON.text(it.request, "space_id") == space }?.let { old ->
            if (old.request != request) throw ZigbeeException("zigbee_record_changed"); return@withLock resolveSaved(records, old)
        }
        if (records.size >= 256) throw ZigbeeException("zigbee_operation_capacity")
        if (preparation.coordinator !in coordinators(space)) throw ZigbeeException("zigbee_review_changed")
        ZigbeeJSON.canOpen(preparation, records.filter { ObservationJSON.text(it.request, "space_id") == space }, history(space), now())
        currentCoroutineContext().ensureActive(); if (!expiresAt.isAfter(now())) throw ZigbeeException("zigbee_review_expired")
        val record = ZigbeeRecord(request, null); val next = records + record
        persist(next); currentCoroutineContext().ensureActive(); if (!expiresAt.isAfter(now())) throw ZigbeeException("zigbee_review_expired")
        val value = gateway.observationCall(space, "/zigbee-operations", "POST", IntegerJSON.canonical(preparation.change), key, query = true)
        val result = ZigbeeJSON.operation(value, request); persist(next.map { if (it.request == request) result else it }); result
    }
    private suspend fun resolveSaved(records: List<ZigbeeRecord>, old: ZigbeeRecord): ZigbeeRecord {
        val value = gateway.observationCall(ObservationJSON.text(old.request, "space_id"), "/zigbee-operations/by-key/${old.key}")
        val result = ZigbeeJSON.operation(value, old.request, old.result); persist(records.map { if (it.request == old.request) result else it }); return result
    }
    suspend fun resolve(space: String, key: String): ZigbeeRecord = mutations.withLock {
        ObservationJSON.id(JsonPrimitive(space)); ObservationJSON.id(JsonPrimitive(key)); val records = load()
        val record = records.firstOrNull { it.key == key && ObservationJSON.text(it.request, "space_id") == space }
        if (record != null) return@withLock resolveSaved(records, record)
        val historical = history(space).firstOrNull { it.key == key } ?: throw ZigbeeException("zigbee_record_missing")
        val result = gateway.observationCall(space, "/zigbee-operations/by-key/$key")
        ZigbeeJSON.operation(result, historical.request, historical.result)
    }
}
