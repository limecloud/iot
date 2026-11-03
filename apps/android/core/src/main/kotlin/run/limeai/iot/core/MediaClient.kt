package run.limeai.iot.core

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.util.UUID

// 上传正文只活在本次请求内；耐久原记录不含正文、下载URL或授权令牌。
class MediaClient(private val gateway: GatewayClient, private val store: SessionStore) {
    private val storageKey = gateway.origin + "#media-operations"
    private var previous: String? = null
    private var loaded = false
    companion object { private val mutations = Mutex() }
    private suspend fun load(): List<MediaRecord> {
        val text = try { store.load(storageKey) } catch (error: Exception) { throw MediaException("media_storage_failed") }
        if (loaded && text != previous) throw MediaException("media_record_changed")
        val records = if (text == null) emptyList() else try {
            val state = IntegerJSON.parse(text); MediaJSON.fields(state, "version,origin,records")
            MediaJSON.require(state["version"] == JsonPrimitive(1) && state["origin"] == JsonPrimitive(gateway.origin))
            val items = state["records"] as? JsonArray ?: throw MediaException("media_storage_failed"); MediaJSON.require(items.size <= 128)
            items.map { value ->
                val item = MediaJSON.obj(value); MediaJSON.fields(item, "original,result")
                val original = MediaJSON.obj(item["original"]); MediaJSON.original(original, gateway.origin)
                val result = item["result"]?.takeUnless { it == JsonNull }?.let(MediaJSON::obj)
                if (result != null) MediaJSON.operation(result, original)
                MediaRecord(original, result)
            }.also { records -> MediaJSON.require(records.map { it.space + ":" + it.key }.distinct().size == records.size) }
        } catch (error: Exception) { throw MediaException("media_storage_failed") }
        previous = text; loaded = true; return records
    }
    private suspend fun persist(records: List<MediaRecord>) {
        val state = buildJsonObject {
            put("version", 1); put("origin", gateway.origin)
            put("records", JsonArray(records.map { buildJsonObject { put("original", it.original); put("result", it.result ?: JsonNull) } }))
        }
        val text = IntegerJSON.canonical(state)
        try { IntegerJSON.parse(text) } catch (error: Exception) { throw MediaException("media_capacity") }
        try {
            if (store.load(storageKey) != previous) throw MediaException("media_record_changed")
            store.save(storageKey, text)
            if (store.load(storageKey) != text) throw MediaException("media_storage_failed")
        } catch (error: Exception) { throw MediaException("media_storage_failed") }
        previous = text; loaded = true
    }
    suspend fun records(space: String): List<MediaRecord> = mutations.withLock {
        MediaJSON.id(JsonPrimitive(space)); load().filter { it.space == space }
    }
    suspend fun list(space: String): MediaPage {
        MediaJSON.id(JsonPrimitive(space)); return MediaJSON.page(gateway.mediaCall(space, "/media"), space)
    }
    suspend fun targets(space: String): List<MediaTarget> {
        MediaJSON.id(JsonPrimitive(space))
        val candidates = MediaTargets.candidates(gateway.mediaCall(space, "/execution-adapters"))
        return candidates.mapNotNull { candidate ->
            val device = MediaJSON.text(candidate, "device_id")
            MediaTargets.current(gateway.mediaCall(space, "/devices/" + device + "/execution-binding"), candidate)
        }
    }
    suspend fun submit(space: String, change: JsonObject, key: String = UUID.randomUUID().toString()): MediaRecord = mutations.withLock {
        // JsonObject可能持有调用方的可变Map，先冻结本次输入再跨越存储/网络挂起点。
        val checked = MediaChanges.parse(IntegerJSON.canonical(change))
        val original = MediaJSON.original(gateway.origin, space, key, checked); val records = load()
        val old = records.firstOrNull { it.space == space && it.key == key }
        if (old != null) { MediaJSON.require(old.original == original); return@withLock resolveSaved(records, old) }
        if (records.size >= 128) throw MediaException("media_capacity")
        if (records.any { it.space == space && it.result == null && MediaJSON.scope(it.change) == MediaJSON.scope(checked) }) throw MediaException("media_pending_operation")
        val record = MediaRecord(original, null); val next = records + record
        persist(next)
        currentCoroutineContext().ensureActive()
        val result = gateway.mediaCall(space, "/media-operations", "POST", IntegerJSON.canonical(checked), key)
        MediaJSON.operation(result, original)
        val resolved = MediaRecord(record.original, result); persist(next.map { if (it === record) resolved else it }); resolved
    }
    private suspend fun resolveSaved(records: List<MediaRecord>, record: MediaRecord): MediaRecord {
        val result = try { gateway.mediaCall(record.space, "/media-operations/by-key/" + record.key) }
        catch (error: GatewayException) { if (error.status == 404) throw MediaException("media_unknown"); throw error }
        MediaJSON.operation(result, record.original)
        if (record.result != null) MediaJSON.require(MediaJSON.stable(record.result) == MediaJSON.stable(result))
        val resolved = MediaRecord(record.original, result); persist(records.map { if (it === record) resolved else it }); return resolved
    }
    suspend fun resolve(space: String, key: String): MediaRecord = mutations.withLock {
        MediaJSON.id(JsonPrimitive(space)); MediaJSON.id(JsonPrimitive(key)); val records = load()
        val record = records.firstOrNull { it.space == space && it.key == key } ?: throw MediaException("media_record_missing")
        resolveSaved(records, record)
    }
}
