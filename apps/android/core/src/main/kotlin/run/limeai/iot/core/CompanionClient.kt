package run.limeai.iot.core

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.time.Instant

// 外层保存会话预算和摘要；每个原回合仍由VoiceTurnClient负责，正文只驻留内存。
class CompanionClient(private val gateway: GatewayClient, private val store: SessionStore, private val space: String, policy: CompanionPolicy? = null, history: List<TextGenerationMessage>? = null, private val now: () -> Instant = Instant::now) {
    private var policy = policy
    private var history = history?.toList()
    private val storageKey = gateway.origin + "#companion:" + space
    private var previous: String? = null
    private var unconfirmedWrite: String? = null
    private var loaded = false
    init { CompanionJSON.match(JsonPrimitive(space), "[A-Za-z0-9_-]{1,128}") }
    companion object { private val mutations = Mutex() }
    fun forgetContext() { policy = null; history = null }
    private suspend fun <T> locked(work: suspend () -> T): T = mutations.withLock { currentCoroutineContext().ensureActive(); work() }
    private suspend fun load(): CompanionRecord? {
        currentCoroutineContext().ensureActive(); val text = store.load(storageKey); currentCoroutineContext().ensureActive()
        if (loaded && text != previous && (unconfirmedWrite == null || text != unconfirmedWrite)) throw CompanionException("companion_record_unavailable")
        val record = text?.let { CompanionRecord.parse(it, gateway.origin, space) }
        previous = text; unconfirmedWrite = null; loaded = true; return record
    }
    private suspend fun requireRecord() = load() ?: throw CompanionException("companion_not_found")
    private suspend fun save(value: JsonObject): CompanionRecord {
        currentCoroutineContext().ensureActive()
        val body = JsonObject(value - "checksum"); val next = JsonObject(body + ("checksum" to JsonPrimitive(IntegerJSON.digest(body)))); val text = IntegerJSON.canonical(next)
        val checked = CompanionRecord.parse(text, gateway.origin, space)
        try {
            if (store.load(storageKey) != previous) throw CompanionException("companion_record_unavailable")
            currentCoroutineContext().ensureActive(); unconfirmedWrite = text; store.save(storageKey, text); currentCoroutineContext().ensureActive()
            if (store.load(storageKey) != text) throw CompanionException("companion_record_unavailable")
            currentCoroutineContext().ensureActive()
        } catch (error: kotlinx.coroutines.CancellationException) { throw error }
        catch (error: Exception) { throw CompanionException("companion_record_unavailable") }
        previous = text; unconfirmedWrite = null; loaded = true; return checked
    }
    suspend fun record(): CompanionRecord? = locked { load() }
    suspend fun capabilities() = VoiceTurnClient(gateway, store, space, now = now).capabilities()
    private fun historyAvailable(record: CompanionRecord): Boolean {
        val history = history ?: return false; val summary = record.document.getValue("history").jsonObject
        return summary["message_count"] == JsonPrimitive(history.size) && summary["digest"] == JsonPrimitive(IntegerJSON.digest(CompanionJSON.messages(history)))
    }
    private suspend fun deployments(): JsonObject {
        val capabilities = capabilities(); val policy = policy
        if (policy == null || !capabilities.configured || policy.voice !in capabilities.speech.voices) throw CompanionException("companion_not_configured")
        return JsonObject(VoiceTurnJSON.kinds.associateWith(capabilities::revision))
    }
    private suspend fun requireLive(record: CompanionRecord): VoiceTextContext {
        if (record.stopped) throw CompanionException("companion_stopped")
        if (now() >= record.expiresAt) throw CompanionException("companion_expired")
        val p = policy; val body = record.document
        if (p == null || body["policy_digest"] != JsonPrimitive(IntegerJSON.digest(p.document)) || body["max_turns"] != JsonPrimitive(p.maxTurns) || record.expiresAt.toEpochMilli() - VoiceTurnJSON.time(body["created_at"]).toEpochMilli() != p.maxSeconds * 1000L) throw CompanionException("companion_policy_changed")
        if (!historyAvailable(record)) throw CompanionException("companion_history_unavailable")
        val history = history ?: throw CompanionException("companion_history_unavailable")
        if (deployments() != body["deployments"]) throw CompanionException("companion_configuration_changed")
        return VoiceTextContext(p.instructions, history)
    }
    private fun voice(record: CompanionRecord, index: Int, context: VoiceTextContext? = null): VoiceTurnClient {
        val sessionId = record.id; val turnId = MediaJSON.text(CompanionJSON.turns(record.document)[index], "turn_id")
        val nested = object : SessionStore {
            private suspend fun session(): CompanionRecord {
                val current = requireRecord(); val turns = CompanionJSON.turns(current.document)
                if (current.id != sessionId || turns.getOrNull(index)?.get("turn_id") != JsonPrimitive(turnId)) throw CompanionException("companion_record_unavailable")
                return current
            }
            override suspend fun load(origin: String): String? = CompanionJSON.turns(session().document)[index]["record"]?.takeUnless { it == JsonNull }?.let(IntegerJSON::canonical)
            override suspend fun save(origin: String, value: String?) {
                val current = session(); val turn = value?.let { VoiceTurnRecord.parse(it, gateway.origin, space, true) } ?: throw CompanionException("companion_record_unavailable")
                if (current.stopped && !turn.stopped) throw CompanionException("companion_record_unavailable")
                val turns = CompanionJSON.turns(current.document).toMutableList(); turns[index] = JsonObject(turns[index] + ("record" to turn.document))
                save(JsonObject(current.document + ("turns" to JsonArray(turns))))
            }
        }
        return VoiceTurnClient(gateway, nested, space, contextual = true, textContext = context, deadline = record.expiresAt, now = now)
    }
    private fun view(record: CompanionRecord, turn: VoiceTurnView? = null): CompanionView {
        val available = historyAvailable(record); val turns = CompanionJSON.turns(record.document); val last = turns.lastOrNull(); val expired = now() >= record.expiresAt
        val phase = if (record.stopped) "stopped" else if (expired) "expired" else turn?.phase ?: if (last == null) "ready" else if (last["record"] == JsonNull) "prepared" else if (last["completed"] == JsonPrimitive(true)) "succeeded" else "paused"
        val max = MediaJSON.integer(record.document["max_turns"], 1, 8).toInt()
        return CompanionView(record, phase, available, max - turns.size,
            !record.stopped && !expired && available && policy?.let { JsonPrimitive(IntegerJSON.digest(it.document)) == record.document["policy_digest"] } == true && (last == null || last["completed"] == JsonPrimitive(true)) && turns.size < max,
            record.stopped && CompanionJSON.settled(record), turn.takeUnless { phase in listOf("stopped", "expired") })
    }
    private suspend fun finish(turn: VoiceTurnView): CompanionView {
        var record = requireRecord(); val turns = CompanionJSON.turns(record.document).toMutableList(); val slot = turns.lastOrNull()
        if (slot == null || JsonPrimitive(turn.record.id) != slot["turn_id"] || turn.record.document != slot["record"]) throw CompanionException("companion_record_unavailable")
        val history = history
        if (!record.stopped && now() < record.expiresAt && turn.phase == "succeeded" && slot["completed"] != JsonPrimitive(true) && turn.transcript != null && turn.answer != null && historyAvailable(record) && history != null) {
            val nextHistory = history + listOf(TextGenerationMessage("user", turn.transcript), TextGenerationMessage("assistant", turn.answer))
            turns[turns.lastIndex] = JsonObject(slot + ("completed" to JsonPrimitive(true)))
            record = save(JsonObject(record.document + mapOf("turns" to JsonArray(turns), "history" to buildJsonObject { put("digest", IntegerJSON.digest(CompanionJSON.messages(nextHistory))); put("message_count", nextHistory.size) })))
            this.history = nextHistory
        }
        return view(record, turn)
    }
    suspend fun start(sessionId: String, policy: CompanionPolicy? = null): CompanionView = locked {
        if (policy != null) this.policy = policy
        try { CompanionJSON.match(JsonPrimitive(sessionId), "[A-Za-z0-9_-]{1,64}") } catch (error: Exception) { throw CompanionException("invalid_companion_request") }
        val p = this.policy ?: throw CompanionException("invalid_companion_request"); val previous = load()
        if (previous != null && (!previous.stopped || !CompanionJSON.settled(previous))) throw CompanionException("companion_session_pending")
        val ids = previous?.let { it.document.getValue("previous_ids").jsonArray + JsonPrimitive(it.id) } ?: emptyList()
        if (JsonPrimitive(sessionId) in ids || ids.size > 256) throw CompanionException("companion_session_id_unavailable")
        val deployments = deployments(); val created = now()
        val record = save(buildJsonObject {
            put("version", 1); put("origin", gateway.origin); put("space_id", space); put("session_id", sessionId); put("previous_ids", JsonArray(ids)); put("policy_digest", IntegerJSON.digest(p.document)); put("deployments", deployments)
            put("created_at", SpeechJSON.timestamp(created)); put("expires_at", SpeechJSON.timestamp(created.plusSeconds(p.maxSeconds.toLong()))); put("max_turns", p.maxTurns); put("stopped", false)
            put("history", buildJsonObject { put("digest", IntegerJSON.digest(JsonArray(emptyList()))); put("message_count", 0) }); put("turns", JsonArray(emptyList()))
        })
        history = emptyList(); view(record)
    }
    suspend fun reply(mediaId: String): CompanionView = locked {
        var record = requireRecord(); val context = requireLive(record); val turns = CompanionJSON.turns(record.document).toMutableList()
        val p = policy ?: throw CompanionException("companion_policy_changed")
        if (turns.lastOrNull()?.get("completed")?.let { it != JsonPrimitive(true) } == true) throw CompanionException("companion_turn_pending")
        if (turns.size >= p.maxTurns) throw CompanionException("companion_turn_budget_exceeded")
        try { CompanionJSON.match(JsonPrimitive(mediaId), "media-[A-Za-z0-9_-]{1,122}") } catch (error: Exception) { throw CompanionException("invalid_companion_request") }
        val index = turns.size; val turnId = record.id + "_t${index + 1}"
        turns.add(buildJsonObject { put("turn_id", turnId); put("media_id", mediaId); put("context_digest", IntegerJSON.digest(context.document)); put("completed", false); put("record", JsonNull) })
        record = save(JsonObject(record.document + ("turns" to JsonArray(turns))))
        finish(voice(record, index, context).start(VoiceTurnRequests.input(turnId, mediaId, p.language, p.voice)))
    }
    suspend fun resolve(): CompanionView = locked {
        val record = requireRecord(); val turns = CompanionJSON.turns(record.document)
        if (turns.isEmpty() || turns.last()["record"] == JsonNull) view(record) else finish(voice(record, turns.lastIndex).resolve())
    }
    suspend fun continueSession(): CompanionView = locked {
        val record = requireRecord(); val context = requireLive(record); val turns = CompanionJSON.turns(record.document)
        if (turns.isEmpty() || turns.last()["record"] == JsonNull) throw CompanionException("companion_preparation_incomplete")
        val client = voice(record, turns.lastIndex, context)
        finish(if (turns.last()["completed"] == JsonPrimitive(true)) client.resolve() else client.continueTurn())
    }
    suspend fun stop(): CompanionView = locked {
        history = null; policy = null; var record = requireRecord()
        if (!record.stopped) record = save(JsonObject(record.document + ("stopped" to JsonPrimitive(true))))
        CompanionJSON.turns(record.document).forEachIndexed { index, slot -> if (slot["record"] != JsonNull) voice(record, index).stopTurn() }
        view(requireRecord())
    }
}
