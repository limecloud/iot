package run.limeai.iot.core

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.time.Instant

// 调用者拥有前台Job；取消后不接受迟到结果，也不创建后续阶段。
class VoiceTurnClient(private val gateway: GatewayClient, private val store: SessionStore, private val space: String, contextual: Boolean = false, private val textContext: VoiceTextContext? = null, private val deadline: Instant? = null, private val now: () -> Instant = Instant::now) {
    private val contextual = contextual || textContext != null
    private val storageKey = gateway.origin + "#voice-turns:" + space
    private var previous: String? = null
    private var unconfirmedWrite: String? = null
    private var loaded = false
    init { MediaJSON.id(JsonPrimitive(space)) }
    companion object { private val mutations = Mutex() }
    private suspend fun <T> locked(work: suspend () -> T): T = mutations.withLock {
        try { currentCoroutineContext().ensureActive(); work() }
        catch (error: Exception) {
            if (error is MediaException || error is TextGenerationException || error is TranscriptionException || error is SpeechException) throw VoiceTurnException("invalid_voice_turn_response")
            throw error
        }
    }
    private suspend fun load(): VoiceTurnRecord? {
        currentCoroutineContext().ensureActive(); val text = store.load(storageKey); currentCoroutineContext().ensureActive()
        if (loaded && text != previous && (unconfirmedWrite == null || text != unconfirmedWrite)) throw VoiceTurnException("voice_turn_record_unavailable")
        val record = text?.let { VoiceTurnRecord.parse(it, gateway.origin, space, contextual) }
        previous = text; unconfirmedWrite = null; loaded = true; return record
    }
    private suspend fun save(value: JsonObject): VoiceTurnRecord {
        currentCoroutineContext().ensureActive()
        val body = JsonObject(value - "checksum"); val next = JsonObject(body + ("checksum" to JsonPrimitive(IntegerJSON.digest(body)))); val text = IntegerJSON.canonical(next)
        val checked = VoiceTurnRecord.parse(text, gateway.origin, space, contextual)
        try {
            if (store.load(storageKey) != previous) throw VoiceTurnException("voice_turn_record_unavailable")
            currentCoroutineContext().ensureActive(); unconfirmedWrite = text; store.save(storageKey, text); currentCoroutineContext().ensureActive()
            if (store.load(storageKey) != text) throw VoiceTurnException("voice_turn_record_unavailable")
            currentCoroutineContext().ensureActive()
        } catch (error: kotlinx.coroutines.CancellationException) { throw error }
        catch (error: Exception) { throw VoiceTurnException("voice_turn_record_unavailable") }
        previous = text; unconfirmedWrite = null; loaded = true; return checked
    }
    private suspend fun call(suffix: String, input: JsonObject? = null, key: String? = null): JsonObject {
        currentCoroutineContext().ensureActive()
        val value = gateway.mediaCall(space, suffix, if (input == null) "GET" else "POST", input?.let(IntegerJSON::canonical), key)
        currentCoroutineContext().ensureActive(); return value
    }
    suspend fun capabilities(): VoiceTurnCapabilities {
        val value = call("/capabilities")
        return VoiceTurnCapabilities(TranscriptionJSON.capabilities(value["transcription"]), TextGenerationJSON.capabilities(value["text"]), SpeechJSON.capabilities(value["speech"]))
    }
    suspend fun record(): VoiceTurnRecord? = locked { load() }
    private suspend fun source(record: VoiceTurnRecord) {
        val page = MediaJSON.page(call("/media"), space); val source = MediaJSON.obj(record.document["source"])
        val item = page.items.firstOrNull { it.id == MediaJSON.text(source, "media_id") }
        if (item == null || !item.available || item.metadata["content_digest"] != source["content_digest"] || MediaJSON.time(JsonPrimitive(item.expiresAt)).toEpochMilli() != VoiceTurnJSON.time(source["expires_at"]).toEpochMilli() || MediaJSON.time(JsonPrimitive(item.expiresAt)) <= now()) throw VoiceTurnException("voice_turn_source_unavailable")
    }
    private suspend fun accept(record: VoiceTurnRecord, kind: String, task: JsonObject): VoiceTurnRecord {
        val job = MediaJSON.obj(VoiceTurnJSON.job(record.document, kind)); val original = MediaJSON.obj(job["original"])
        when (kind) { "transcription" -> TranscriptionJSON.task(task, original); "text" -> TextGenerationJSON.task(task, original); else -> SpeechJSON.task(task, original) }
        if (task.getValue("deployment").jsonObject["revision"] != record.document.getValue("deployments").jsonObject[kind]) throw VoiceTurnException("invalid_voice_turn_response")
        val next = JsonObject(job + ("observation" to VoiceTurnJSON.observe(task, kind, job["observation"])))
        return save(VoiceTurnJSON.settingJob(record.document, kind, next))
    }
    private suspend fun resolveRecord(record: VoiceTurnRecord): Pair<VoiceTurnRecord, MutableMap<String, JsonObject>> {
        var current = record; val tasks = mutableMapOf<String, JsonObject>()
        for (kind in VoiceTurnJSON.kinds) {
            val job = VoiceTurnJSON.job(current.document, kind) as? JsonObject ?: continue
            if (job["rejected_code"] != JsonNull) continue
            val key = MediaJSON.text(MediaJSON.obj(job["original"]), "idempotency_key"); val task = call("/" + VoiceTurnJSON.family(kind) + "/by-key/" + key)
            current = accept(current, kind, task); tasks[kind] = task
        }
        return current to tasks
    }
    private fun view(record: VoiceTurnRecord, tasks: Map<String, JsonObject> = emptyMap()): VoiceTurnView {
        val expired = now() >= record.expiresAt; val visible = !record.stopped && !expired
        var phase = if (record.stopped) "stopped" else if (expired) "expired" else "ready"
        if (visible) for (kind in VoiceTurnJSON.kinds) {
            val job = VoiceTurnJSON.job(record.document, kind) as? JsonObject
            val observed = job?.get("observation") as? JsonObject
            if (job != null && job["rejected_code"] != JsonNull) { phase = "failed"; break }
            if (job != null && observed?.get("status") != JsonPrimitive("succeeded")) { phase = observed?.let { MediaJSON.text(it, "status") } ?: "unknown"; break }
            if (job == null) { phase = "ready"; break }
            if (kind == "speech") phase = "succeeded"
        }
        fun text(kind: String): String? {
            val output = tasks[kind]?.get("output") as? JsonObject ?: return null
            return if (visible && MediaJSON.time(output["expires_at"]) > now()) output["text"]?.takeUnless { it == JsonNull }?.let(MediaJSON::str) else null
        }
        return VoiceTurnView(record, phase, VoiceTurnJSON.kinds.lastOrNull { VoiceTurnJSON.job(record.document, it) != JsonNull }, text("transcription"), text("text"), if (visible && phase == "succeeded") MediaJSON.text(VoiceTurnJSON.job(record.document, "speech").jsonObject.getValue("observation").jsonObject, "media_id") else null)
    }
    suspend fun start(input: JsonObject): VoiceTurnView = locked {
        val checked = VoiceTurnRequests.checked(input); val previous = load(); val turn = MediaJSON.text(checked, "turn_id")
        if (previous != null) {
            val jobs = previous.document.getValue("jobs").jsonObject
            val unresolved = VoiceTurnJSON.kinds.any { kind ->
                val job = jobs[kind] as? JsonObject
                val observed = job?.get("observation") as? JsonObject
                job != null && job["rejected_code"] == JsonNull && (VoiceTurnJSON.pending(observed) || job["discard_attempted"] == JsonPrimitive(true) && kind == "text" && observed?.get("status") == JsonPrimitive("succeeded") && (observed["output"] as? JsonObject)?.get("cleared_at") == JsonNull)
            }
            val failed = jobs.values.any { value -> (value as? JsonObject)?.let { it["rejected_code"] != JsonNull || (it["observation"] as? JsonObject)?.get("status")?.let(MediaJSON::str) in listOf("failed", "discarded") } == true }
            val completed = ((jobs["speech"] as? JsonObject)?.get("observation") as? JsonObject)?.get("status") == JsonPrimitive("succeeded")
            if (unresolved || previous.id == turn || !previous.stopped && !completed && !failed) throw VoiceTurnException("voice_turn_pending")
        }
        val capability = capabilities(); val voice = MediaJSON.text(checked, "voice")
        if (!capability.configured || voice !in capability.speech.voices) throw VoiceTurnException("voice_turn_not_configured")
        val page = MediaJSON.page(call("/media"), space); val mediaId = MediaJSON.text(checked, "media_id"); val source = page.items.firstOrNull { it.id == mediaId }
        if (source == null || !source.available || MediaJSON.time(JsonPrimitive(source.expiresAt)) < now().plusSeconds(1)) throw VoiceTurnException("voice_turn_source_unavailable")
        val created = now(); val expires = minOf(created.plusSeconds(300), MediaJSON.time(JsonPrimitive(source.expiresAt)), deadline ?: Instant.MAX)
        if (expires < created.plusSeconds(1)) throw VoiceTurnException("voice_turn_source_unavailable")
        if (contextual && textContext == null) throw VoiceTurnException("voice_turn_context_unavailable")
        val record = save(buildJsonObject {
            put("version", if (contextual) 2 else 1); put("origin", gateway.origin);
            if (contextual && textContext != null) put("text_context", buildJsonObject { put("digest", IntegerJSON.digest(textContext.document)); put("history_messages", textContext.history.size) })
            put("space_id", space); put("turn_id", turn); put("created_at", SpeechJSON.timestamp(created)); put("expires_at", SpeechJSON.timestamp(expires))
            put("source", buildJsonObject { put("media_id", mediaId); put("content_digest", source.metadata.getValue("content_digest")); put("expires_at", SpeechJSON.timestamp(MediaJSON.time(JsonPrimitive(source.expiresAt)))) })
            put("language", checked.getValue("language")); put("voice", voice); put("retain_seconds", 600)
            put("deployments", JsonObject(VoiceTurnJSON.kinds.associateWith(capability::revision))); put("jobs", JsonObject(VoiceTurnJSON.kinds.associateWith { JsonNull })); put("stopped", false)
        })
        advance(record)
    }
    suspend fun resolve(): VoiceTurnView = locked { val record = load() ?: throw VoiceTurnException("voice_turn_not_found"); val (next, tasks) = resolveRecord(record); view(next, tasks) }
    suspend fun continueTurn(): VoiceTurnView = locked { advance(load() ?: throw VoiceTurnException("voice_turn_not_found")) }
    private suspend fun advance(record: VoiceTurnRecord): VoiceTurnView {
        val result = resolveRecord(record); var current = result.first; val tasks = result.second
        if (current.stopped || now() >= current.expiresAt) return view(current, tasks)
        if (current.document["version"] == JsonPrimitive(2) && (textContext == null || current.document.getValue("text_context").jsonObject["digest"] != JsonPrimitive(IntegerJSON.digest(textContext.document)))) throw VoiceTurnException("voice_turn_context_unavailable")
        for (kind in VoiceTurnJSON.kinds) {
            val job = VoiceTurnJSON.job(current.document, kind) as? JsonObject
            if (job != null) { if (job["rejected_code"] != JsonNull || (job["observation"] as? JsonObject)?.get("status") != JsonPrimitive("succeeded")) break; continue }
            source(current); val capability = capabilities()
            if (!capability.configured || !VoiceTurnJSON.kinds.all { capability.revision(it) == current.document.getValue("deployments").jsonObject[it] }) throw VoiceTurnException("voice_turn_configuration_changed")
            val deadline = SpeechJSON.timestamp(minOf(now().plusSeconds(85), current.expiresAt))
            fun text(stage: String): String {
                val output = tasks[stage]?.get("output") as? JsonObject ?: throw VoiceTurnException("voice_turn_text_unavailable")
                val value = output["text"]?.takeUnless { it == JsonNull }?.let(MediaJSON::str)
                if (value == null || value.isBlank() || MediaJSON.time(output["expires_at"]) <= now()) throw VoiceTurnException("voice_turn_text_unavailable")
                return value
            }
            val input: JsonObject; val original: JsonObject; val key = current.id + "-" + kind
            when (kind) {
                "transcription" -> {
                    val source = current.document.getValue("source").jsonObject
                    input = buildJsonObject { put("media_id", source.getValue("media_id")); put("media_digest", source.getValue("content_digest")); put("language", current.document.getValue("language")); put("expires_at", deadline) }
                    original = TranscriptionJSON.original(gateway.origin, space, key, input)
                }
                "text" -> {
                    val context = textContext.takeIf { current.document["version"] == JsonPrimitive(2) }
                    input = TextGenerationRequests.input(context?.history.orEmpty() + TextGenerationMessage("user", text("transcription")), context?.instructions ?: VoiceTurnJSON.instructions, 600, deadline)
                    original = TextGenerationJSON.original(gateway.origin, space, key, TextGenerationJSON.summarize(input))
                }
                else -> {
                    val answer = text("text")
                    input = try { SpeechRequests.parse(IntegerJSON.canonical(buildJsonObject { put("text", answer); put("voice", current.document.getValue("voice")); put("retain_seconds", 600); put("expires_at", deadline) })) }
                    catch (error: Exception) { throw VoiceTurnException("voice_turn_answer_not_speakable") }
                    original = SpeechJSON.original(gateway.origin, space, key, input)
                }
            }
            currentCoroutineContext().ensureActive(); if (now() >= current.expiresAt) return view(current, tasks)
            current = save(VoiceTurnJSON.settingJob(current.document, kind, buildJsonObject { put("original", original); put("observation", JsonNull); put("rejected_code", JsonNull); put("discard_attempted", false) }))
            if (now() >= current.expiresAt) return view(current, tasks)
            val task = try { call("/" + VoiceTurnJSON.family(kind), input, key) }
            catch (error: GatewayException) {
                if (error.definitiveRejection) {
                    val rejected = JsonObject(VoiceTurnJSON.job(current.document, kind).jsonObject + ("rejected_code" to JsonPrimitive(error.code)))
                    save(VoiceTurnJSON.settingJob(current.document, kind, rejected))
                }
                throw error
            }
            current = accept(current, kind, task); tasks[kind] = task
            if (task["status"] != JsonPrimitive("succeeded")) break
        }
        return view(current, tasks)
    }
    suspend fun stopTurn(): VoiceTurnView = locked {
        var record = load() ?: throw VoiceTurnException("voice_turn_not_found")
        if (!record.stopped) record = save(JsonObject(record.document + ("stopped" to JsonPrimitive(true))))
        for (kind in VoiceTurnJSON.kinds) {
            val job = VoiceTurnJSON.job(record.document, kind) as? JsonObject ?: continue
            val observed = job["observation"] as? JsonObject
            if (job["rejected_code"] != JsonNull || kind == "text" && (observed?.get("output") as? JsonObject)?.get("cleared_at")?.let { it != JsonNull } == true || !VoiceTurnJSON.pending(observed) && !(kind == "text" && observed?.get("status") == JsonPrimitive("succeeded"))) continue
            val key = MediaJSON.text(job.getValue("original").jsonObject, "idempotency_key"); val suffix = "/" + VoiceTurnJSON.family(kind) + "/by-key/" + key
            val task = if (job["discard_attempted"] != JsonPrimitive(true)) {
                record = save(VoiceTurnJSON.settingJob(record.document, kind, JsonObject(job + ("discard_attempted" to JsonPrimitive(true)))))
                call(suffix + "/discard", buildJsonObject { })
            } else call(suffix)
            record = accept(record, kind, task)
        }
        view(record)
    }
}
