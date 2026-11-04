package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import run.limeai.iot.core.*
import java.time.Instant
import java.util.UUID

data class CompositionState(
    val busy: Boolean = false, val ready: Boolean = false, val online: Boolean = true, val blocked: Boolean = false, val message: String = "",
    val source: String = runCatching { CompositionPackage.readingCompanionJSON() }.getOrDefault(""), val custom: Boolean = false,
    val manifest: CompositionPackage? = runCatching { CompositionPackage.parse(source) }.getOrNull(), val bindings: Map<String, String> = emptyMap(),
    val devices: List<Device> = emptyList(), val record: CompositionRecord? = null, val preview: CompositionPreview? = null
) {
    val writable get() = online && ready && !busy && !blocked
    val canEdit get() = writable && record == null
}
class CompositionController(private val client: CompositionClient, private val scope: CoroutineScope, private val authFailure: (Exception) -> Unit, private val now: () -> Instant = Instant::now) {
    private val mutable = MutableStateFlow(CompositionState()); val state = mutable.asStateFlow()
    private var instanceId = "composition-${UUID.randomUUID()}"
    private var generation = 0; private var active = true; private var job: Job? = null; private var settling: Job? = null
    private fun compiled(): CompositionCompiled? {
        val s = state.value; val manifest = s.manifest ?: return null
        if (!manifest.roles.all { role -> s.devices.any { it.deviceId == s.bindings[role] && it.ready && it.modelRevision == manifest.modelRevision(role) } }) return null
        return runCatching { manifest.compile(s.bindings, instanceId) }.getOrNull()
    }
    fun canPlan() = active && state.value.canEdit && compiled() != null
    fun canDeploy() = active && state.value.canEdit && state.value.preview?.let { now() >= it.createdAt && now() < it.expiresAt } == true
    private fun invalidatePreview() { client.invalidate(); mutable.update { it.copy(preview = null) } }
    fun setCustom(value: Boolean) {
        if (!active || !state.value.canEdit || value == state.value.custom) return
        val source = if (value) "" else runCatching { CompositionPackage.readingCompanionJSON() }.getOrDefault("")
        mutable.update { it.copy(custom = value, source = source, manifest = runCatching { CompositionPackage.parse(source) }.getOrNull(), bindings = emptyMap(), message = "") }; invalidatePreview()
    }
    fun setSource(text: String) {
        if (!active || !state.value.canEdit || !state.value.custom || state.value.source == text) return
        if (text.toByteArray(Charsets.UTF_8).size > 32768) { mutable.update { it.copy(message = "组合包不能超过 32 KiB") }; invalidatePreview(); return }
        mutable.update { it.copy(source = text, manifest = runCatching { CompositionPackage.parse(text) }.getOrNull(), bindings = emptyMap(), message = "") }; invalidatePreview()
    }
    fun bind(role: String, device: String) {
        if (!active || !state.value.canEdit || role !in state.value.manifest?.roles.orEmpty() || state.value.bindings[role] == device) return
        mutable.update { it.copy(bindings = it.bindings + (role to device), message = "") }; invalidatePreview()
    }
    private fun selectedDevices(list: List<Device>) = state.value.bindings.values.sorted().map { id -> list.firstOrNull { it.deviceId == id }?.let { "$id:${it.modelRevision}:${it.ready}" } ?: "$id:missing" }
    fun updateDevices(list: List<Device>) {
        val changed = selectedDevices(state.value.devices) != selectedDevices(list); mutable.update { it.copy(devices = list.toList()) }
        if (changed) pause()
    }
    private sealed interface Result {
        class Loaded(val record: CompositionRecord?) : Result
        class Planned(val preview: CompositionPreview) : Result
        class Deployed(val record: CompositionRecord) : Result
        class Resolved(val status: CompositionStatus) : Result
        data object Prepared : Result
    }
    private fun run(requiresReady: Boolean = true, action: suspend () -> Result) {
        val state = mutable.value
        if (!active || !state.online || state.busy || state.blocked || requiresReady && !state.ready) return
        val epoch = generation; val barrier = settling; mutable.update { it.copy(busy = true, message = "", preview = null) }
        job = scope.launch {
            try {
                barrier?.join(); currentCoroutineContext().ensureActive(); if (!active || epoch != generation || !mutable.value.online) return@launch
                val result = action(); currentCoroutineContext().ensureActive(); if (!active || epoch != generation || !mutable.value.online) return@launch
                mutable.update { previous ->
                    when (result) {
                        is Result.Loaded -> previous.copy(ready = true, record = result.record)
                        is Result.Planned -> previous.copy(ready = true, preview = result.preview, message = "预演通过，设备尚未执行")
                        is Result.Deployed -> previous.copy(ready = true, record = result.record, message = "组合已启用")
                        is Result.Resolved -> previous.copy(ready = true, record = result.status.record, message = result.status.message)
                        Result.Prepared -> {
                            instanceId = "composition-${UUID.randomUUID()}"
                            val source = runCatching { CompositionPackage.readingCompanionJSON() }.getOrDefault("")
                            previous.copy(ready = true, record = null, bindings = emptyMap(), source = source, custom = false, manifest = runCatching { CompositionPackage.parse(source) }.getOrNull())
                        }
                    }
                }
            } catch (error: Exception) {
                if (error is CancellationException || !active || epoch != generation || !mutable.value.online) return@launch
                mutable.update { it.copy(message = (error as? CompositionException)?.userMessage ?: (error as? GatewayException)?.displayMessage ?: "提交结果待核实，请查询当前部署") }
                try {
                    val saved = client.record(); currentCoroutineContext().ensureActive(); if (epoch != generation) return@launch
                    mutable.update { it.copy(record = saved, ready = true) }
                } catch (storage: Exception) {
                    if (storage is CancellationException || epoch != generation) return@launch
                    mutable.update { it.copy(ready = false, blocked = storage is CompositionException && storage.code == "composition_record_unavailable", message = if (storage is CompositionException && storage.code == "composition_record_unavailable") "无法核对本地提交记录，已暂停新提交" else it.message) }
                }
                if (error is GatewayException && error.status == 401) authFailure(error)
            } finally { if (epoch == generation) { mutable.update { it.copy(busy = false) }; job = null } }
        }
    }
    fun refresh() = run(requiresReady = false) { Result.Loaded(client.record()) }
    fun plan() { if (!canPlan()) return; val compiled = compiled() ?: return; run { Result.Planned(client.plan(compiled)) } }
    fun deploy() { if (canDeploy()) run { Result.Deployed(client.deploy()) } }
    fun query() { if (state.value.record != null) run { Result.Resolved(client.resolve()) } }
    fun prepareAnother() { if (state.value.record != null && state.value.record?.state != "attempted") run { client.prepareAnother(); Result.Prepared } }
    fun poll() { state.value.preview?.let { if (now() < it.createdAt || now() >= it.expiresAt) { invalidatePreview(); mutable.update { it.copy(message = "预演已过期，请重新预演") } } } }
    fun pause() {
        generation++; val interrupted = job; val prior = settling; interrupted?.cancel(); job = null; client.invalidate()
        mutable.update { it.copy(busy = false, ready = false, preview = null, message = "") }
        settling = scope.launch { prior?.join(); interrupted?.join() }
    }
    fun setOnline(value: Boolean) { if (!value) pause(); mutable.update { it.copy(online = value) } }
    fun close() { pause(); active = false }
    suspend fun waitForIdle() { job?.join(); settling?.join() }
}
