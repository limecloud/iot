package run.limeai.iot.core

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.*
import java.util.UUID

// 使用同一个本地 GatewayClient 会话；不经过云控制面，也不暴露无耐久记录的 POST。
class OtaClient(private val gateway: GatewayClient, private val store: SessionStore) {
    private val storageKey = gateway.origin + "#ota-operations"
    private var previous: String? = null
    private var loaded = false
    companion object { private val mutations = Mutex() }
    private suspend fun load(): List<OtaRecord> {
        val text = try { store.load(storageKey) } catch (error: Exception) { throw OtaException("ota_storage_failed") }
        if (loaded && text != previous) throw OtaException("ota_record_changed")
        val records = if (text == null) emptyList() else try {
            val state = OtaJSON.parse(text, response = true)
            OtaJSON.fields(state, "version,origin,records")
            OtaJSON.require(state["version"] == JsonPrimitive(1) && state["origin"] == JsonPrimitive(gateway.origin))
            val items = state["records"] as? JsonArray ?: throw OtaException("invalid_ota_document")
            OtaJSON.require(items.size <= 128)
            items.map { value ->
                val record = OtaJSON.obj(value); OtaJSON.fields(record, "request,result")
                val request = OtaJSON.obj(record["request"]); OtaJSON.fields(request, "space_id,idempotency_key,change")
                OtaJSON.id(request["space_id"]); OtaJSON.id(request["idempotency_key"]); OtaJSON.change(OtaJSON.obj(request["change"]))
                val result = record["result"]?.takeUnless { it == JsonNull }?.let(OtaJSON::obj)
                if (result != null) OtaJSON.operation(result, request)
                OtaRecord(request, result)
            }.also { records -> OtaJSON.require(records.map { OtaJSON.text(it.request, "space_id") + ":" + it.key }.distinct().size == records.size) }
        } catch (error: Exception) { throw OtaException("ota_storage_failed") }
        previous = text; loaded = true; return records
    }
    private suspend fun persist(records: List<OtaRecord>) {
        val text = OtaJSON.canonical(buildJsonObject {
            put("version", 1); put("origin", gateway.origin)
            put("records", JsonArray(records.map { buildJsonObject { put("request", it.request); put("result", it.result ?: JsonNull) } }))
        })
        // 不写入下一次无法按相同边界读取的状态；结果过大时保留原未决记录。
        try { OtaJSON.parse(text, response = true) } catch (error: Exception) { throw OtaException("ota_capacity") }
        try {
            if (store.load(storageKey) != previous) throw OtaException("ota_record_changed")
            store.save(storageKey, text)
            if (store.load(storageKey) != text) throw OtaException("ota_storage_failed")
        } catch (error: Exception) { throw OtaException("ota_storage_failed") }
        previous = text; loaded = true
    }
    suspend fun records(space: String): List<OtaRecord> = mutations.withLock { load().filter { it.request["space_id"] == JsonPrimitive(space) } }
    suspend fun trusts(space: String): List<FirmwareTrust> {
        OtaJSON.id(JsonPrimitive(space))
        val page = gateway.otaCall(space, "/firmware-trusts"); OtaJSON.fields(page, "items,next_cursor")
        val items = page["items"] as? JsonArray ?: throw OtaException("invalid_ota_document")
        OtaJSON.require(items.size <= 32 && page["next_cursor"] == JsonNull)
        return items.map { OtaJSON.obj(it).also(OtaJSON::trust) }.map(::FirmwareTrust).also { OtaJSON.require(it.map(FirmwareTrust::id).distinct().size == it.size) }
    }
    suspend fun task(space: String, id: String): OtaTask {
        OtaJSON.id(JsonPrimitive(space)); OtaJSON.id(JsonPrimitive(id), "ota-")
        val value = gateway.otaCall(space, "/ota-tasks/$id"); OtaJSON.task(value); OtaJSON.require(value["task_id"] == JsonPrimitive(id)); return OtaTask(value)
    }
    suspend fun tasks(space: String): List<OtaTask> {
        OtaJSON.id(JsonPrimitive(space)); val result = mutableListOf<OtaTask>(); var cursor: String? = null
        do {
            val page = gateway.otaCall(space, "/ota-tasks" + (cursor?.let { "?after=$it" } ?: "")); OtaJSON.fields(page, "items,next_cursor")
            val items = page["items"] as? JsonArray ?: throw OtaException("invalid_ota_document")
            OtaJSON.require(items.size <= 16)
            result += items.map { OtaJSON.obj(it).also(OtaJSON::task) }.map(::OtaTask)
            OtaJSON.require(result.size <= 128 && result.map(OtaTask::id).distinct().size == result.size)
            val next = page["next_cursor"]?.takeUnless { it == JsonNull }?.let { OtaJSON.id(it, "ota-") }
            if (next != null) OtaJSON.require(items.isNotEmpty() && next == result.last().id && next != cursor && result.size < 128)
            cursor = next
        } while (cursor != null)
        return result
    }
    private suspend fun scope(space: String, change: JsonObject): String = when (OtaJSON.text(change, "type")) {
        "trust.add" -> "trust:" + OtaJSON.digest(change.getValue("trust"))
        "tasks.plan" -> "device:" + OtaJSON.text(change, "device_id")
        else -> "device:" + task(space, OtaJSON.text(change, "task_id")).deviceId
    }
    suspend fun submit(space: String, change: JsonObject, key: String = UUID.randomUUID().toString()): OtaRecord = mutations.withLock {
        val checked = OtaJSON.change(OtaJSON.canonical(change)); OtaJSON.id(JsonPrimitive(space)); OtaJSON.id(JsonPrimitive(key))
        if (checked["type"] == JsonPrimitive("trust.add") && checked["expected_signing_key_id"] != OtaJSON.obj(checked["trust"])["signing_key_id"]) throw OtaException("ota_fingerprint_mismatch")
        val request = buildJsonObject { put("space_id", space); put("idempotency_key", key); put("change", checked) }
        val records = load()
        val old = records.firstOrNull { it.key == key && it.request["space_id"] == JsonPrimitive(space) }
        if (old != null) { OtaJSON.require(old.request == request); return@withLock resolveSaved(records, old) }
        if (records.size >= 128) throw OtaException("ota_capacity")
        if (checked["type"] != JsonPrimitive("trust.revoke")) {
            val pending = records.filter { it.result == null && it.request["space_id"] == JsonPrimitive(space) && OtaJSON.obj(it.request["change"])["type"] != JsonPrimitive("trust.revoke") }
            if (pending.isNotEmpty()) {
                val target = scope(space, checked)
                for (record in pending) if (scope(space, OtaJSON.obj(record.request["change"])) == target) throw OtaException("ota_pending_operation")
            }
        }
        val record = OtaRecord(request, null); val next = records + record
        persist(next) // 保存与回读成功后，才允许发出唯一一次 POST。
        currentCoroutineContext().ensureActive()
        val result = gateway.otaCall(space, "/ota-operations", "POST", OtaJSON.canonical(checked), key)
        OtaJSON.operation(result, request)
        val resolved = record.copy(result = result); persist(next.map { if (it === record) resolved else it }); resolved
    }
    private suspend fun resolveSaved(records: List<OtaRecord>, record: OtaRecord): OtaRecord {
        val result = gateway.otaCall(OtaJSON.text(record.request, "space_id"), "/ota-operations/by-key/${record.key}")
        OtaJSON.operation(result, record.request)
        OtaJSON.require(record.result == null || record.result == result)
        val resolved = record.copy(result = result); persist(records.map { if (it === record) resolved else it }); return resolved
    }
    suspend fun resolve(space: String, key: String): OtaRecord = mutations.withLock {
        val records = load(); val record = records.firstOrNull { it.key == key && it.request["space_id"] == JsonPrimitive(space) } ?: throw OtaException("ota_record_missing")
        resolveSaved(records, record)
    }
}
