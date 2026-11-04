package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import run.limeai.iot.core.*
import java.time.Instant
import java.util.UUID

data class VoiceTurnState(val busy: Boolean = false, val ready: Boolean = false, val online: Boolean = true, val message: String = "", val capabilities: VoiceTurnCapabilities? = null, val record: VoiceTurnRecord? = null, val view: VoiceTurnView? = null, val selectedMedia: String = "", val voice: String = "", val confirmation: Boolean = false) {
    val writable get() = online && !busy
    val canStart get() = writable && ready && capabilities?.configured == true && selectedMedia.isNotEmpty() && voice.isNotEmpty() && (record == null || view?.phase in listOf("succeeded", "stopped", "failed"))
    val canContinue get() = writable && ready && record != null && view?.phase in listOf("ready", "running")
    val statusText get() = when (view?.phase) { "ready" -> "等待继续"; "running" -> "正在生成"; "succeeded" -> "语音已生成"; "failed" -> "生成失败"; "stopped" -> "已停止"; "expired" -> "回合已到期"; "unknown" -> "结果未知"; else -> if (record == null) "暂无语音回合" else "请查询原回合" }
}
class VoiceTurnController(private val client: VoiceTurnClient, val space: String, private val scope: CoroutineScope, private val authFailure: (Exception) -> Unit, private val now: () -> Instant = Instant::now) {
    private val mutable = MutableStateFlow(VoiceTurnState()); val state = mutable.asStateFlow()
    private var active = true; private var advancing = false; private var generation = 0; private var job: Job? = null
    fun visible(): VoiceTurnView? = state.value.view?.takeIf { !it.record.stopped && it.record.expiresAt > now() }
    fun selectMedia(id: String) { if (active && state.value.writable) mutable.update { it.copy(selectedMedia = id) } }
    fun selectVoice(id: String) { if (active && state.value.writable && id in state.value.capabilities?.speech?.voices.orEmpty()) mutable.update { it.copy(voice = id) } }
    private fun current(epoch: Int) { if (!active || !state.value.online || epoch != generation) throw CancellationException() }
    private suspend fun accept(next: VoiceTurnView, epoch: Int, show: Boolean = true) {
        currentCoroutineContext().ensureActive(); current(epoch)
        mutable.update { it.copy(record = next.record, view = if (show) next else next.copy(transcript = null, answer = null, mediaId = null)) }
        if (next.phase !in listOf("ready", "running")) advancing = false
    }
    private fun run(action: suspend (Int) -> Unit) {
        if (!active || !state.value.writable) return
        val epoch = generation; mutable.update { it.copy(busy = true, message = "", confirmation = false) }
        job = scope.launch {
            try { current(epoch); action(epoch) }
            catch (error: Exception) {
                if (error is CancellationException || epoch != generation || !active) return@launch
                advancing = false; mutable.update { it.copy(view = null, ready = false) }
                val saved = runCatching { client.record() }.getOrNull(); currentCoroutineContext().ensureActive(); current(epoch)
                mutable.update { it.copy(record = saved ?: it.record, message = (error as? VoiceTurnException)?.displayMessage ?: (error as? GatewayException)?.displayMessage ?: "结果未知，请查询原回合") }
                if (error is GatewayException && error.status == 401) authFailure(error)
            } finally { if (epoch == generation) mutable.update { it.copy(busy = false) } }
        }
    }
    fun refresh() {
        advancing = false; mutable.update { it.copy(view = null) }
        run { epoch ->
            val capability = client.capabilities(); current(epoch)
            val saved = client.record(); current(epoch)
            mutable.update { it.copy(ready = false, capabilities = capability, record = saved, voice = it.voice.takeIf { voice -> voice in capability.speech.voices } ?: capability.speech.voices.firstOrNull().orEmpty()) }
            if (saved != null) accept(client.resolve(), epoch, false)
            current(epoch); mutable.update { it.copy(ready = true) }
        }
    }
    fun start() {
        val s = state.value; if (!active || !s.canStart) return; advancing = true
        run { epoch -> accept(client.start(VoiceTurnRequests.input(UUID.randomUUID().toString(), s.selectedMedia, voice = s.voice)), epoch) }
    }
    fun recover() { advancing = false; run { epoch -> accept(client.resolve(), epoch); mutable.update { it.copy(ready = true) } } }
    fun continueTurn() { if (!state.value.canContinue) return; advancing = true; run { epoch -> accept(client.continueTurn(), epoch) } }
    fun poll() {
        val s = state.value; if (!s.ready || s.confirmation || s.view?.phase != "running") return
        if (advancing) run { epoch -> accept(client.continueTurn(), epoch) }
        else run { epoch -> accept(client.resolve(), epoch, false) }
    }
    fun requestStop() { if (active && state.value.writable && state.value.record != null) mutable.update { it.copy(confirmation = true) } }
    fun cancelStop() { mutable.update { it.copy(confirmation = false) } }
    fun confirmStop() {
        if (!state.value.writable || !state.value.confirmation) return; advancing = false; mutable.update { it.copy(view = null) }
        run { epoch -> accept(client.stopTurn(), epoch); mutable.update { it.copy(ready = true) } }
    }
    fun pause() { generation++; job?.cancel(); job = null; advancing = false; mutable.update { it.copy(busy = false, ready = false, view = null, selectedMedia = "", confirmation = false) } }
    fun setOnline(value: Boolean) { if (!value) pause(); mutable.update { it.copy(online = value) } }
    fun close() { pause(); active = false }
    suspend fun waitForIdle() { job?.join() }
}
