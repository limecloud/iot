package run.limeai.iot.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.util.UUID

// 回答正文只随当次返回值交付；本机仅保存原请求摘要、去正文观测及明确清除意图。
class TextGenerationClient(private val gateway: GatewayClient, private val store: SessionStore) {
    private val storageKey = gateway.origin + "#text-generations"
    private var previous: String? = null
    private var unconfirmedWrite: String? = null
    private var loaded = false
    companion object { private val mutations = Mutex() }
    private suspend fun <T> locked(work: suspend () -> T): T = mutations.withLock {
        try { work() } catch (error: MediaException) { throw TextGenerationException("invalid_text_response") }
    }
    private suspend fun load(): List<TextGenerationRecord> = try {
        val text = store.load(storageKey)
        if (loaded && text != previous && (unconfirmedWrite == null || text != unconfirmedWrite)) throw TextGenerationException("text_record_changed")
        val records = if (text == null) emptyList() else {
            val v = IntegerJSON.parse(text); MediaJSON.fields(v, "version,origin,records")
            MediaJSON.require(v["version"] == JsonPrimitive(1) && v["origin"] == JsonPrimitive(gateway.origin))
            val items = v["records"] as? JsonArray ?: throw MediaException("invalid_media_document"); MediaJSON.require(items.size <= 128)
            items.map { value ->
                val r = MediaJSON.obj(value); MediaJSON.fields(r, "original,observation,rejected_code,discard_intents")
                val original = MediaJSON.obj(r["original"]); TextGenerationJSON.original(original, gateway.origin)
                val result = r["observation"]?.takeUnless { it == JsonNull }?.let(MediaJSON::obj)
                if (result != null) TextGenerationJSON.task(result, original, stored = true)
                val rejected = r["rejected_code"]?.takeUnless { it == JsonNull }?.let(MediaJSON::str)
                MediaJSON.require(rejected == null || rejected.matches(Regex("[a-z][a-z0-9_]{0,63}")) && result == null)
                val intents = r["discard_intents"] as? JsonArray ?: throw MediaException("invalid_media_document"); MediaJSON.require(intents.size <= 8)
                val ids = intents.map { MediaJSON.id(it) }; MediaJSON.require(ids.distinct().size == ids.size && (rejected == null || ids.isEmpty()))
                TextGenerationRecord(original, result, rejected, ids)
            }.also { records -> MediaJSON.require(records.map { it.space + ":" + it.key }.distinct().size == records.size) }
        }
        previous = text; unconfirmedWrite = null; loaded = true; records
    } catch (error: Exception) { if (error is CancellationException) throw error; throw TextGenerationException("text_storage_failed") }
    private suspend fun persist(records: List<TextGenerationRecord>) {
        val value = buildJsonObject {
            put("version", 1); put("origin", gateway.origin)
            put("records", JsonArray(records.map { record -> buildJsonObject { put("original", record.original); put("observation", record.observation ?: JsonNull); put("rejected_code", record.rejectedCode?.let(::JsonPrimitive) ?: JsonNull); put("discard_intents", JsonArray(record.discardIntents.map(::JsonPrimitive))) } }))
        }
        val text = IntegerJSON.canonical(value)
        try {
            IntegerJSON.parse(text)
            if (store.load(storageKey) != previous) throw TextGenerationException("text_record_changed")
            unconfirmedWrite = text
            store.save(storageKey, text)
            if (store.load(storageKey) != text) throw TextGenerationException("text_storage_failed")
        } catch (error: Exception) { if (error is CancellationException) throw error; throw TextGenerationException("text_storage_failed") }
        previous = text; unconfirmedWrite = null; loaded = true
    }
    suspend fun capabilities(space: String): TextGenerationCapabilities = try { TextGenerationJSON.capabilities(gateway.mediaCall(space, "/capabilities")["text"]) }
    catch (error: MediaException) { throw TextGenerationException("invalid_text_response") }
    suspend fun records(space: String): List<TextGenerationRecord> = locked { MediaJSON.id(JsonPrimitive(space)); load().filter { it.space == space } }
    private suspend fun accept(result: JsonObject, record: TextGenerationRecord, records: List<TextGenerationRecord>): TextGenerationRecord {
        TextGenerationJSON.task(result, record.original, record.observation); MediaJSON.require(record.rejectedCode == null)
        val text = result["output"]?.takeUnless { it == JsonNull }?.jsonObject?.get("text")?.takeUnless { it == JsonNull }?.let(MediaJSON::str)
        val next = TextGenerationRecord(record.original, TextGenerationJSON.metadata(result), null, record.discardIntents, text)
        persist(records.map { if (it.space == record.space && it.key == record.key) next else it }); return next
    }
    private suspend fun resolveSaved(record: TextGenerationRecord, records: List<TextGenerationRecord>): TextGenerationRecord {
        val value = try { gateway.mediaCall(record.space, "/text-generations/by-key/" + record.key) }
        catch (error: GatewayException) { if (error.status == 404) throw TextGenerationException("text_unknown"); throw error }
        return accept(value, record, records)
    }
    suspend fun submit(space: String, input: JsonObject, key: String = UUID.randomUUID().toString()): TextGenerationRecord = locked {
        val checked = TextGenerationRequests.checked(input); val original = TextGenerationJSON.original(gateway.origin, space, key, TextGenerationJSON.summarize(checked))
        val records = load(); val old = records.firstOrNull { it.space == space && it.key == key }
        if (old != null) { MediaJSON.require(old.original == original); return@locked resolveSaved(old, records) }
        if (records.size >= 128) throw TextGenerationException("text_capacity")
        if (records.any { it.space == space && it.pending }) throw TextGenerationException("text_pending")
        val record = TextGenerationRecord(original, null, null, emptyList()); val next = records + record
        persist(next); currentCoroutineContext().ensureActive()
        val value = try { gateway.mediaCall(space, "/text-generations", "POST", IntegerJSON.canonical(checked), key) }
        catch (error: GatewayException) {
            if (error.definitiveRejection) {
                MediaJSON.require(error.code.matches(Regex("[a-z][a-z0-9_]{0,63}")))
                persist(next.map { if (it.space == space && it.key == key) TextGenerationRecord(original, null, error.code, emptyList()) else it })
            }
            throw error
        }
        accept(value, record, next)
    }
    suspend fun resolve(space: String, key: String): TextGenerationRecord = locked {
        MediaJSON.id(JsonPrimitive(space)); MediaJSON.id(JsonPrimitive(key)); val records = load()
        val record = records.firstOrNull { it.space == space && it.key == key } ?: throw TextGenerationException("text_record_missing")
        resolveSaved(record, records)
    }
    suspend fun discard(space: String, key: String, intent: String = UUID.randomUUID().toString()): TextGenerationRecord = locked {
        MediaJSON.id(JsonPrimitive(space)); MediaJSON.id(JsonPrimitive(key)); MediaJSON.id(JsonPrimitive(intent)); val records = load()
        val record = records.firstOrNull { it.space == space && it.key == key } ?: throw TextGenerationException("text_record_missing")
        if (intent in record.discardIntents) return@locked resolveSaved(record, records)
        if (!record.canDiscard) throw TextGenerationException("text_pending")
        if (record.discardIntents.size >= 8) throw TextGenerationException("text_capacity")
        val next = record.copy(discardIntents = record.discardIntents + intent); val updated = records.map { if (it.space == space && it.key == key) next else it }
        persist(updated); currentCoroutineContext().ensureActive()
        accept(gateway.mediaCall(space, "/text-generations/by-key/" + key + "/discard", "POST", "{}"), next, updated)
    }
}
