package run.limeai.iot.core

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.util.UUID

class ObservationClient(private val gateway: GatewayClient, private val store: SessionStore) {
    companion object { private val mutations = Mutex() }
    private val storageKey = gateway.origin + "#observation-operations"
    private var previous: String? = null
    private var loaded = false
    private suspend fun load(): List<ObservationRecord> {
        val text = try { store.load(storageKey) } catch (error: CancellationException) { throw error } catch (_: Exception) { throw ObservationException("observation_storage_failed") }
        if (loaded && previous != text) throw ObservationException("observation_record_changed")
        val records = if (text == null) emptyList() else try {
            val state = ObservationJSON.fields(ObservationJSON.parse(text, response = true), "version,origin,records")
            ObservationJSON.require(state["version"] == JsonPrimitive(1) && state["origin"] == JsonPrimitive(gateway.origin))
            val items = state["records"] as? JsonArray ?: ObservationJSON.fail(); ObservationJSON.require(items.size <= 128)
            items.map { item ->
                val r = ObservationJSON.fields(item, "request,result"); val request = ObservationJSON.obj(r["request"]); ObservationJSON.request(request)
                val result = r["result"]?.takeUnless { it == JsonNull }?.let(ObservationJSON::obj)
                if (result != null) ObservationJSON.operation(result, request)
                ObservationRecord(request, result)
            }.also { records -> ObservationJSON.require(records.map { ObservationJSON.text(it.request, "space_id") + ":" + it.key }.distinct().size == records.size) }
        } catch (_: Exception) { throw ObservationException("observation_storage_failed") }
        previous = text; loaded = true; return records
    }
    private suspend fun persist(records: List<ObservationRecord>) {
        val text = ObservationJSON.canonical(buildJsonObject { put("version", 1); put("origin", gateway.origin); put("records", JsonArray(records.map { buildJsonObject { put("request", it.request); put("result", it.result ?: JsonNull) } })) })
        try { ObservationJSON.parse(text, response = true) } catch (_: Exception) { throw ObservationException("observation_capacity") }
        try {
            if (store.load(storageKey) != previous) throw ObservationException("observation_record_changed")
            store.save(storageKey, text)
            if (store.load(storageKey) != text) throw ObservationException("observation_storage_failed")
        } catch (error: CancellationException) { throw error } catch (error: ObservationException) { throw error } catch (_: Exception) { throw ObservationException("observation_storage_failed") }
        previous = text; loaded = true
    }
    suspend fun records(space: String): List<ObservationRecord> = mutations.withLock { ObservationJSON.id(JsonPrimitive(space)); load().filter { ObservationJSON.text(it.request, "space_id") == space } }
    suspend fun candidates(space: String): ObservationCandidates {
        ObservationJSON.id(JsonPrimitive(space)); return ObservationJSON.candidates(gateway.observationCall(space, "/observation-candidates"))
    }
    suspend fun query(space: String, coordinator: String, ieee: String, endpoint: Int, profile: ObservationProfile = ObservationProfile.Environment): ObservationCandidate {
        ObservationJSON.id(JsonPrimitive(space)); val input = ObservationJSON.query(coordinator, ieee, endpoint, profile)
        val selected = candidates(space).coordinators.firstOrNull { it.id == coordinator } ?: ObservationJSON.fail()
        val candidate = ObservationJSON.candidate(gateway.observationCall(space, "/observation-candidates", "POST", ObservationJSON.canonical(input), query = true))
        ObservationJSON.require(candidate.profile == profile && candidate.ieee == ieee && candidate.endpoint == endpoint && ObservationJSON.text(ObservationJSON.obj(candidate.document["target"]), "coordinator_ieee") == selected.ieee)
        return candidate
    }
    suspend fun discover(space: String, coordinator: String): ObservationDiscovery {
        val input = ObservationDiscoveryJSON.query(coordinator)
        val selected = candidates(space).coordinators.firstOrNull { it.id == coordinator } ?: ObservationJSON.fail()
        return ObservationDiscoveryJSON.discovery(gateway.observationCall(space, "/observation-discoveries", "POST", ObservationJSON.canonical(input), query = true), selected)
    }
    suspend fun endpoints(space: String, coordinator: String, ieee: String): ObservationEndpoints {
        val input = ObservationDiscoveryJSON.query(coordinator, ieee)
        val selected = candidates(space).coordinators.firstOrNull { it.id == coordinator } ?: ObservationJSON.fail()
        return ObservationDiscoveryJSON.endpoints(gateway.observationCall(space, "/observation-endpoints", "POST", ObservationJSON.canonical(input), query = true), selected, ieee)
    }
    suspend fun binding(space: String, device: String): ObservationBinding {
        ObservationJSON.id(JsonPrimitive(space)); ObservationJSON.id(JsonPrimitive(device))
        return ObservationJSON.binding(gateway.observationCall(space, "/devices/$device/observation-binding"), device)
    }
    suspend fun submit(space: String, change: JsonObject, key: String = UUID.randomUUID().toString()): ObservationRecord = mutations.withLock {
        val checked = ObservationJSON.change(ObservationJSON.parse(ObservationJSON.canonical(change))); ObservationJSON.id(JsonPrimitive(space)); ObservationJSON.id(JsonPrimitive(key))
        val request = buildJsonObject { put("space_id", space); put("idempotency_key", key); put("change", checked) }; val records = load()
        records.firstOrNull { it.key == key && ObservationJSON.text(it.request, "space_id") == space }?.let { old -> ObservationJSON.require(old.request == request); return@withLock resolveSaved(records, old) }
        if (records.size >= 128) throw ObservationException("observation_capacity")
        val device = ObservationJSON.text(checked, "device_id"); val source = (checked["source"] as? JsonObject)?.get("adapter_id")
        for (record in records.filter { it.pending && ObservationJSON.text(it.request, "space_id") == space }) {
            val oldChange = ObservationJSON.obj(record.request["change"])
            if (record.device == device || source != null && (oldChange["source"] as? JsonObject)?.get("adapter_id") == source) throw ObservationException("observation_pending_operation")
        }
        val record = ObservationRecord(request, null); val next = records + record
        persist(next); currentCoroutineContext().ensureActive()
        val result = gateway.observationCall(space, "/observation-operations", "POST", ObservationJSON.canonical(checked), key)
        ObservationJSON.operation(result, request)
        val resolved = ObservationRecord(request, result); persist(next.map { if (it.request == request) resolved else it }); resolved
    }
    private suspend fun resolveSaved(records: List<ObservationRecord>, record: ObservationRecord): ObservationRecord {
        val result = gateway.observationCall(ObservationJSON.text(record.request, "space_id"), "/observation-operations/by-key/${record.key}")
        ObservationJSON.operation(result, record.request); ObservationJSON.require(record.result == null || record.result == result)
        val resolved = ObservationRecord(record.request, result); persist(records.map { if (it.request == record.request) resolved else it }); return resolved
    }
    suspend fun resolve(space: String, key: String): ObservationRecord = mutations.withLock {
        ObservationJSON.id(JsonPrimitive(space)); ObservationJSON.id(JsonPrimitive(key)); val records = load()
        val record = records.firstOrNull { it.key == key && ObservationJSON.text(it.request, "space_id") == space } ?: throw ObservationException("observation_record_missing")
        resolveSaved(records, record)
    }
}
