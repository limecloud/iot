package run.limeai.iot.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.util.UUID

// 正文只参与当次摘要和POST；本机只保存原身份、状态及明确放弃意图。
class SpeechClient(private val gateway: GatewayClient, private val store: SessionStore) {
    private val storageKey = gateway.origin + "#speech-syntheses"
    private var previous: String? = null
    private var unconfirmedWrite: String? = null
    private var loaded = false
    companion object { private val mutations = Mutex() }
    private suspend fun <T> locked(work: suspend () -> T): T = mutations.withLock {
        try { work() } catch (error: MediaException) { throw SpeechException("invalid_speech_response") }
    }
    private suspend fun load(): List<SpeechRecord> = try {
        val text = store.load(storageKey)
        if (loaded && text != previous && (unconfirmedWrite == null || text != unconfirmedWrite)) throw SpeechException("speech_record_changed")
        val records = if (text == null) emptyList() else {
            val v = IntegerJSON.parse(text); MediaJSON.fields(v, "version,origin,records")
            MediaJSON.require(v["version"] == JsonPrimitive(1) && v["origin"] == JsonPrimitive(gateway.origin))
            val items = v["records"] as? JsonArray ?: throw MediaException("invalid_media_document"); MediaJSON.require(items.size <= 128)
            items.map { value ->
                val r = MediaJSON.obj(value); MediaJSON.fields(r, "original,result,rejected_code,discard_intents")
                val original = MediaJSON.obj(r["original"]); SpeechJSON.original(original, gateway.origin)
                val result = r["result"]?.takeUnless { it == JsonNull }?.let(MediaJSON::obj)
                if (result != null) SpeechJSON.task(result, original)
                val rejected = r["rejected_code"]?.takeUnless { it == JsonNull }?.let(MediaJSON::str)
                MediaJSON.require(rejected == null || rejected.matches(Regex("[a-z][a-z0-9_]{0,63}")) && result == null)
                val intents = r["discard_intents"] as? JsonArray ?: throw MediaException("invalid_media_document"); MediaJSON.require(intents.size <= 8)
                val ids = intents.map { MediaJSON.id(it) }; MediaJSON.require(ids.distinct().size == ids.size && (rejected == null || ids.isEmpty()))
                SpeechRecord(original, result, rejected, ids)
            }.also { records -> MediaJSON.require(records.map { it.space + ":" + it.key }.distinct().size == records.size) }
        }
        previous = text; unconfirmedWrite = null; loaded = true; records
    } catch (error: Exception) { if (error is CancellationException) throw error; throw SpeechException("speech_storage_failed") }
    private suspend fun persist(records: List<SpeechRecord>) {
        val value = buildJsonObject {
            put("version", 1); put("origin", gateway.origin)
            put("records", JsonArray(records.map { record -> buildJsonObject { put("original", record.original); put("result", record.result ?: JsonNull); put("rejected_code", record.rejectedCode?.let(::JsonPrimitive) ?: JsonNull); put("discard_intents", JsonArray(record.discardIntents.map(::JsonPrimitive))) } }))
        }
        val text = IntegerJSON.canonical(value)
        try {
            IntegerJSON.parse(text)
            if (store.load(storageKey) != previous) throw SpeechException("speech_record_changed")
            unconfirmedWrite = text
            store.save(storageKey, text)
            if (store.load(storageKey) != text) throw SpeechException("speech_storage_failed")
        } catch (error: Exception) { if (error is CancellationException) throw error; throw SpeechException("speech_storage_failed") }
        previous = text; unconfirmedWrite = null; loaded = true
    }
    suspend fun capabilities(space: String): SpeechCapabilities = try { SpeechJSON.capabilities(gateway.mediaCall(space, "/capabilities")["speech"]) }
    catch (error: MediaException) { throw SpeechException("invalid_speech_response") }
    suspend fun records(space: String): List<SpeechRecord> = locked { MediaJSON.id(JsonPrimitive(space)); load().filter { it.space == space } }
    private suspend fun accept(result: JsonObject, record: SpeechRecord, records: List<SpeechRecord>): SpeechRecord {
        SpeechJSON.task(result, record.original, record.result); MediaJSON.require(record.rejectedCode == null)
        val next = SpeechRecord(record.original, result, null, record.discardIntents)
        persist(records.map { if (it.space == record.space && it.key == record.key) next else it }); return next
    }
    private suspend fun resolveSaved(record: SpeechRecord, records: List<SpeechRecord>): SpeechRecord {
        val value = try { gateway.mediaCall(record.space, "/speech-syntheses/by-key/" + record.key) }
        catch (error: GatewayException) { if (error.status == 404) throw SpeechException("speech_unknown"); throw error }
        return accept(value, record, records)
    }
    suspend fun submit(space: String, input: JsonObject, key: String = UUID.randomUUID().toString()): SpeechRecord = locked {
        val checked = SpeechRequests.parse(IntegerJSON.canonical(input)); val original = SpeechJSON.original(gateway.origin, space, key, checked)
        val records = load(); val old = records.firstOrNull { it.space == space && it.key == key }
        if (old != null) { MediaJSON.require(old.original == original); return@locked resolveSaved(old, records) }
        if (records.size >= 128) throw SpeechException("speech_capacity")
        if (records.any { it.space == space && it.pending }) throw SpeechException("speech_pending")
        val record = SpeechRecord(original, null, null, emptyList()); val next = records + record
        persist(next); currentCoroutineContext().ensureActive()
        val value = try { gateway.mediaCall(space, "/speech-syntheses", "POST", IntegerJSON.canonical(checked), key) }
        catch (error: GatewayException) {
            if (error.definitiveRejection) {
                MediaJSON.require(error.code.matches(Regex("[a-z][a-z0-9_]{0,63}")))
                persist(next.map { if (it.space == space && it.key == key) SpeechRecord(original, null, error.code, emptyList()) else it })
            }
            throw error
        }
        accept(value, record, next)
    }
    suspend fun resolve(space: String, key: String): SpeechRecord = locked {
        MediaJSON.id(JsonPrimitive(space)); MediaJSON.id(JsonPrimitive(key)); val records = load()
        val record = records.firstOrNull { it.space == space && it.key == key } ?: throw SpeechException("speech_record_missing")
        resolveSaved(record, records)
    }
    suspend fun discard(space: String, key: String, intent: String = UUID.randomUUID().toString()): SpeechRecord = locked {
        MediaJSON.id(JsonPrimitive(space)); MediaJSON.id(JsonPrimitive(key)); MediaJSON.id(JsonPrimitive(intent)); val records = load()
        val record = records.firstOrNull { it.space == space && it.key == key } ?: throw SpeechException("speech_record_missing")
        if (intent in record.discardIntents) return@locked resolveSaved(record, records)
        if (record.status !in listOf("running", "unknown")) throw SpeechException("speech_pending")
        if (record.discardIntents.size >= 8) throw SpeechException("speech_capacity")
        val next = record.copy(discardIntents = record.discardIntents + intent); val updated = records.map { if (it.space == space && it.key == key) next else it }
        persist(updated); currentCoroutineContext().ensureActive()
        accept(gateway.mediaCall(space, "/speech-syntheses/by-key/" + key + "/discard", "POST", "{}"), next, updated)
    }
}
