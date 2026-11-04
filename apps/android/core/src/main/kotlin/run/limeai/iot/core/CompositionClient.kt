package run.limeai.iot.core

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*
import java.time.Instant
import java.util.concurrent.atomic.AtomicInteger

class CompositionPreview internal constructor(val compiled: CompositionCompiled, val document: JsonObject, val createdAt: Instant) {
    val expiresAt: Instant get() = createdAt.plusSeconds(60)
    val json get() = CompositionJSON.canonical(document)
}
class CompositionStatus internal constructor(val record: CompositionRecord, val deployment: Deployment?) {
    val message get() = if (deployment != null) {
        if (record.state == "acknowledged") "当前组合已启用" else "当前已启用，原提交结果仍待核实"
    } else if (record.state == "attempted") "暂未看到当前部署，原提交结果仍待核实" else "当前组合未启用"
}

// 组合仅编译到现有规则；证明只驻留内存，部署前保存完整原请求，恢复不补发。
class CompositionClient(private val gateway: GatewayClient, private val store: SessionStore, val space: String, private val now: () -> Instant = Instant::now) {
    private companion object { val persistenceGate = Mutex() }
    private data class Proof(val preview: CompositionPreview, val epoch: Int, val generation: Int)
    private val gate = Mutex()
    private val generation = AtomicInteger()
    @Volatile private var proof: Proof? = null
    private var previous: String? = null
    private var unconfirmedWrite: String? = null
    private var loaded = false
    private var blocked = false
    private var writePending = false
    private val storageKey get() = gateway.origin + "#composition:" + space
    init { MediaJSON.id(JsonPrimitive(space)) }
    fun invalidate() { generation.incrementAndGet(); proof = null }
    private suspend fun <T> locked(work: suspend () -> T): T {
        if (!gate.tryLock()) throw CompositionException("composition_busy")
        try {
            if (!persistenceGate.tryLock()) throw CompositionException("composition_busy")
            try { currentCoroutineContext().ensureActive(); return work() } finally { persistenceGate.unlock() }
        } finally { gate.unlock() }
    }
    private suspend fun load(): CompositionRecord? {
        if (blocked) throw CompositionException("composition_record_unavailable")
        currentCoroutineContext().ensureActive()
        val raw = try { store.load(storageKey) } catch (error: CancellationException) { throw error } catch (_: Exception) { throw CompositionException("composition_record_unavailable") }
        currentCoroutineContext().ensureActive()
        if (loaded && raw != previous && !(writePending && raw == unconfirmedWrite)) { blocked = true; throw CompositionException("composition_record_unavailable") }
        val record = try { raw?.let { CompositionRecord.parse(it, gateway.origin, space) } } catch (_: Exception) { blocked = true; throw CompositionException("composition_record_unavailable") }
        previous = raw; unconfirmedWrite = null; writePending = false; loaded = true; return record
    }
    private suspend fun requireRecord() = load() ?: throw CompositionException("composition_not_found")
    private suspend fun save(body: JsonObject?): CompositionRecord? {
        val record = body?.let { source ->
            val fields = JsonObject(source - "checksum")
            CompositionRecord.parse(CompositionJSON.canonical(JsonObject(fields + ("checksum" to JsonPrimitive(CompositionJSON.digest(fields))))), gateway.origin, space)
        }
        val raw = record?.json
        try {
            currentCoroutineContext().ensureActive()
            if (store.load(storageKey) != previous) throw CompositionException("composition_record_unavailable")
            currentCoroutineContext().ensureActive(); unconfirmedWrite = raw; writePending = true
            store.save(storageKey, raw); currentCoroutineContext().ensureActive()
            if (store.load(storageKey) != raw) throw CompositionException("composition_record_unavailable")
            currentCoroutineContext().ensureActive()
        } catch (error: CancellationException) { throw error } catch (_: Exception) { throw CompositionException("composition_record_unavailable") }
        previous = raw; unconfirmedWrite = null; writePending = false; loaded = true; return record
    }
    private suspend fun current(context: Int, epoch: Int) {
        val session = gateway.compositionSession(); currentCoroutineContext().ensureActive()
        if (generation.get() != context || session != epoch) throw CancellationException()
    }
    private suspend fun models(compiled: CompositionCompiled, epoch: Int, context: Int) {
        for (role in compiled.manifest.roles) {
            val id = compiled.bindings.getValue(role)
            val device = gateway.compositionCall(space, "/devices/$id", epoch)
            current(context, epoch)
            if (device["device_id"] != JsonPrimitive(id) || device["model_revision"] != JsonPrimitive(compiled.manifest.modelRevision(role)) || device["ready"] != JsonPrimitive(true)) throw CompositionException("composition_model_mismatch")
        }
    }
    suspend fun record(): CompositionRecord? = locked { load() }
    suspend fun plan(compiled: CompositionCompiled): CompositionPreview {
        proof = null; val context = generation.get()
        return locked {
            if (load() != null) throw CompositionException("composition_pending")
            val epoch = gateway.compositionSession(); current(context, epoch)
            models(compiled, epoch, context)
            val validation = gateway.compositionCall(space, "/rules:validate", epoch, "POST", compiled.rule); current(context, epoch)
            val simulation = gateway.compositionCall(space, "/rules:simulate", epoch, "POST", compiled.document.getValue("simulation_input").jsonObject); current(context, epoch)
            val rule = compiled.typedRule
            val result = CompositionJSON.json.decodeFromJsonElement<Simulation>(simulation)
            try {
                require(validation["revision"] == JsonPrimitive(compiled.revision))
                RuleProof.verify(result, rule, validation["valid"] == JsonPrimitive(true), compiled.revision)
            } catch (_: Exception) { throw GatewayException("invalid_simulation", 502) }
            models(compiled, epoch, context)
            val created = now()
            val document = JsonObject(compiled.document + buildJsonObject {
                put("gateway_checked", true); put("gateway_origin", gateway.origin); put("space_id", space); put("checked_at", SpeechJSON.timestamp(created)); put("validation", validation); put("simulation", simulation)
            })
            val preview = CompositionPreview(compiled, document, created)
            currentCoroutineContext().ensureActive(); if (context != generation.get()) throw CancellationException()
            proof = Proof(preview, epoch, context); preview
        }
    }
    suspend fun deploy(): CompositionRecord {
        val approved = proof ?: throw CompositionException("composition_preview_required"); proof = null
        return locked {
            val preview = approved.preview; val compiled = preview.compiled; val epoch = approved.epoch; val context = approved.generation
            fun fresh() { val time = now(); if (time < preview.createdAt || time >= preview.expiresAt) throw CompositionException("composition_preview_required") }
            fresh(); current(context, epoch)
            if (load() != null) throw CompositionException("composition_pending")
            models(compiled, epoch, context); fresh(); current(context, epoch)
            val body = buildJsonObject {
                put("version", 1); put("origin", gateway.origin); put("space_id", space); put("package", compiled.manifest.document)
                put("bindings", JsonObject(compiled.bindings.mapValues { JsonPrimitive(it.value) })); put("instance_id", compiled.instanceId); put("rule_revision", compiled.revision); put("state", "attempted")
            }
            val original = save(body)!!; fresh(); current(context, epoch)
            try {
                val deployment = gateway.compositionCall(space, "/rule-deployments", epoch, "POST", compiled.rule, createOnly = true)
                current(context, epoch); checked(deployment, compiled)
                save(JsonObject(original.document + ("state" to JsonPrimitive("acknowledged"))))!!
            } catch (error: GatewayException) {
                if (error.definitiveRejection) { current(context, epoch); save(JsonObject(original.document + ("state" to JsonPrimitive("rejected")))) }
                throw error
            }
        }
    }
    private fun checked(value: JsonObject, compiled: CompositionCompiled, conflict: Boolean = false): Deployment {
        if (value["revision"] != JsonPrimitive(compiled.revision) || value["rule"]?.let { RuleProof.equal(it, compiled.rule) } != true) throw GatewayException(if (conflict) "revision_conflict" else "invalid_response", if (conflict) 409 else 502)
        return CompositionJSON.json.decodeFromJsonElement(value)
    }
    suspend fun resolve(): CompositionStatus = locked {
        val record = requireRecord(); val epoch = gateway.compositionSession(); val context = generation.get()
        val page = gateway.compositionCall(space, "/rule-deployments", epoch); current(context, epoch)
        val items = page["items"] as? JsonArray ?: throw GatewayException("invalid_response")
        if (page["next_cursor"] != JsonNull) throw GatewayException("invalid_response")
        val matches = items.filter { MediaJSON.text(it.jsonObject.getValue("rule").jsonObject, "id") == record.compiled.instanceId }
        if (matches.size > 1) throw GatewayException("invalid_response")
        requireRecord()
        CompositionStatus(record, matches.firstOrNull()?.let { checked(it.jsonObject, record.compiled, conflict = true) })
    }
    suspend fun prepareAnother() {
        proof = null
        locked { val record = requireRecord(); if (record.state == "attempted") throw CompositionException("composition_pending"); save(null) }
    }
}
