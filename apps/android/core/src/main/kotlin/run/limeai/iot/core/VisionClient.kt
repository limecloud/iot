package run.limeai.iot.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.util.UUID

// 观察正文只随当次返回值交付；本机仅保存原请求摘要、去正文观测及明确清除意图。
class VisionClient(private val gateway: GatewayClient, private val store: SessionStore) {
    private val storageKey = gateway.origin + "#vision-observations"
    private var previous: String? = null
    private var unconfirmedWrite: String? = null
    private var loaded = false
    companion object { private val mutations = Mutex() }
    private suspend fun <T> locked(work: suspend () -> T): T = mutations.withLock {
        try { work() } catch (error: MediaException) { throw VisionException("invalid_vision_response") }
    }
    private suspend fun load(): List<VisionRecord> = try {
        val text = store.load(storageKey)
        if (loaded && text != previous && (unconfirmedWrite == null || text != unconfirmedWrite)) throw VisionException("vision_record_changed")
        val records = if (text == null) emptyList() else {
            val v = IntegerJSON.parse(text); MediaJSON.fields(v, "version,origin,records")
            MediaJSON.require(v["version"] == JsonPrimitive(1) && v["origin"] == JsonPrimitive(gateway.origin))
            val items = v["records"] as? JsonArray ?: throw MediaException("invalid_media_document"); MediaJSON.require(items.size <= 128)
            items.map { value ->
                val r = MediaJSON.obj(value); MediaJSON.fields(r, "original,observation,rejected_code,discard_intents")
                val original = MediaJSON.obj(r["original"]); VisionJSON.original(original, gateway.origin)
                val result = r["observation"]?.takeUnless { it == JsonNull }?.let(MediaJSON::obj)
                if (result != null) VisionJSON.task(result, original, stored = true)
                val rejected = r["rejected_code"]?.takeUnless { it == JsonNull }?.let(MediaJSON::str)
                MediaJSON.require(rejected == null || rejected.matches(Regex("[a-z][a-z0-9_]{0,63}")) && result == null)
                val intents = r["discard_intents"] as? JsonArray ?: throw MediaException("invalid_media_document"); MediaJSON.require(intents.size <= 8)
                val ids = intents.map { MediaJSON.id(it) }; MediaJSON.require(ids.distinct().size == ids.size && (rejected == null || ids.isEmpty()))
                VisionRecord(original, result, rejected, ids)
            }.also { records -> MediaJSON.require(records.map { it.space + ":" + it.key }.distinct().size == records.size) }
        }
        previous = text; unconfirmedWrite = null; loaded = true; records
    } catch (error: Exception) { if (error is CancellationException) throw error; throw VisionException("vision_storage_failed") }
    private suspend fun persist(records: List<VisionRecord>) {
        val value = buildJsonObject {
            put("version", 1); put("origin", gateway.origin)
            put("records", JsonArray(records.map { record -> buildJsonObject { put("original", record.original); put("observation", record.observation ?: JsonNull); put("rejected_code", record.rejectedCode?.let(::JsonPrimitive) ?: JsonNull); put("discard_intents", JsonArray(record.discardIntents.map(::JsonPrimitive))) } }))
        }
        val text = IntegerJSON.canonical(value)
        try {
            IntegerJSON.parse(text)
            if (store.load(storageKey) != previous) throw VisionException("vision_record_changed")
            unconfirmedWrite = text
            store.save(storageKey, text)
            if (store.load(storageKey) != text) throw VisionException("vision_storage_failed")
        } catch (error: Exception) { if (error is CancellationException) throw error; throw VisionException("vision_storage_failed") }
        previous = text; unconfirmedWrite = null; loaded = true
    }
    suspend fun capabilities(space: String): VisionCapabilities = try { VisionJSON.capabilities(gateway.mediaCall(space, "/capabilities")["vision"]) }
    catch (error: MediaException) { throw VisionException("invalid_vision_response") }
    suspend fun records(space: String): List<VisionRecord> = locked { MediaJSON.id(JsonPrimitive(space)); load().filter { it.space == space } }
    private suspend fun accept(result: JsonObject, record: VisionRecord, records: List<VisionRecord>): VisionRecord {
        VisionJSON.task(result, record.original, record.observation); MediaJSON.require(record.rejectedCode == null)
        val text = result["output"]?.takeUnless { it == JsonNull }?.jsonObject?.get("text")?.takeUnless { it == JsonNull }?.let(MediaJSON::str)
        val next = VisionRecord(record.original, VisionJSON.metadata(result), null, record.discardIntents, text)
        persist(records.map { if (it.space == record.space && it.key == record.key) next else it }); return next
    }
    private suspend fun resolveSaved(record: VisionRecord, records: List<VisionRecord>): VisionRecord {
        val value = try { gateway.mediaCall(record.space, "/vision-observations/by-key/" + record.key) }
        catch (error: GatewayException) { if (error.status == 404) throw VisionException("vision_unknown"); throw error }
        return accept(value, record, records)
    }
    suspend fun submit(space: String, input: JsonObject, key: String = UUID.randomUUID().toString()): VisionRecord = locked {
        val checked = VisionRequests.checked(input); val original = VisionJSON.original(gateway.origin, space, key, VisionJSON.summarize(checked))
        val records = load(); val old = records.firstOrNull { it.space == space && it.key == key }
        if (old != null) { MediaJSON.require(old.original == original); return@locked resolveSaved(old, records) }
        if (records.size >= 128) throw VisionException("vision_capacity")
        if (records.any { it.space == space && it.pending }) throw VisionException("vision_pending")
        val record = VisionRecord(original, null, null, emptyList()); val next = records + record
        persist(next); currentCoroutineContext().ensureActive()
        val value = try { gateway.mediaCall(space, "/vision-observations", "POST", IntegerJSON.canonical(checked), key) }
        catch (error: GatewayException) {
            if (error.definitiveRejection) {
                MediaJSON.require(error.code.matches(Regex("[a-z][a-z0-9_]{0,63}")))
                persist(next.map { if (it.space == space && it.key == key) VisionRecord(original, null, error.code, emptyList()) else it })
            }
            throw error
        }
        accept(value, record, next)
    }
    suspend fun resolve(space: String, key: String): VisionRecord = locked {
        MediaJSON.id(JsonPrimitive(space)); MediaJSON.id(JsonPrimitive(key)); val records = load()
        val record = records.firstOrNull { it.space == space && it.key == key } ?: throw VisionException("vision_record_missing")
        resolveSaved(record, records)
    }
    suspend fun discard(space: String, key: String, intent: String = UUID.randomUUID().toString()): VisionRecord = locked {
        MediaJSON.id(JsonPrimitive(space)); MediaJSON.id(JsonPrimitive(key)); MediaJSON.id(JsonPrimitive(intent)); val records = load()
        val record = records.firstOrNull { it.space == space && it.key == key } ?: throw VisionException("vision_record_missing")
        if (intent in record.discardIntents) return@locked resolveSaved(record, records)
        if (!record.canDiscard) throw VisionException("vision_pending")
        if (record.discardIntents.size >= 8) throw VisionException("vision_capacity")
        val next = record.copy(discardIntents = record.discardIntents + intent); val updated = records.map { if (it.space == space && it.key == key) next else it }
        persist(updated); currentCoroutineContext().ensureActive()
        accept(gateway.mediaCall(space, "/vision-observations/by-key/" + key + "/discard", "POST", "{}"), next, updated)
    }
}
