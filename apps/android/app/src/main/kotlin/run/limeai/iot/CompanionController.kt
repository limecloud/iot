package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.time.Instant
import java.util.UUID

private const val companionInstructions = "你是积木小狗豆豆，喜欢和用户讨论积木、故事与日常发现。用温和、简短的中文回答，每次不超过300字。不能调用工具或声称控制了设备。遇到不确定的问题说明不确定；涉及危险活动时建议请家长帮助。"
data class CompanionState(val busy: Boolean = false, val ready: Boolean = false, val online: Boolean = true, val message: String = "", val capabilities: VoiceTurnCapabilities? = null, val record: CompanionRecord? = null, val view: CompanionView? = null, val selectedMedia: String = "", val voice: String = "", val instructions: String = companionInstructions, val confirmation: Boolean = false) {
    val writable get() = online && !busy
    val canStart get() = writable && ready && capabilities?.configured == true && voice.isNotEmpty() && (record == null || view?.stopSettled == true)
    val canEdit get() = writable && (record == null || view?.stopSettled == true)
    val statusText get() = when (view?.phase) { "ready" -> if (record?.turnCount == 0) "会话已开始" else "等待继续"; "running" -> "正在生成"; "succeeded" -> "回答已生成，剩余 ${view.turnsRemaining} 轮"; "stopped" -> if (view.stopSettled) "会话已停止" else "正在核实停止结果"; "expired" -> "会话已到期"; "unknown" -> "结果未知"; "prepared" -> "原回合准备未完成，请停止会话"; "failed" -> "生成失败"; else -> if (record == null) "暂无陪伴会话" else "请查询原会话" }
}
class CompanionController(private val client: CompanionClient, val space: String, private val scope: CoroutineScope, private val authFailure: (Exception) -> Unit, private val now: () -> Instant = Instant::now) {
    private val mutable = MutableStateFlow(CompanionState()); val state = mutable.asStateFlow()
    private var active = true; private var advancing = false; private var generation = 0; private var job: Job? = null; private var forgetting: Job? = null
    private fun live() = state.value.record?.let { !it.stopped && it.expiresAt > now() } == true
    fun canReply() = active && state.value.writable && state.value.ready && live() && state.value.view?.canReply == true && state.value.selectedMedia.isNotEmpty()
    fun canContinue() = active && state.value.writable && state.value.ready && live() && state.value.view?.historyAvailable == true && state.value.view?.phase in listOf("ready", "running", "paused")
    fun visible(): VoiceTurnView? = state.value.view?.turn?.takeIf { live() }
    fun selectMedia(id: String) { if (active && state.value.writable) mutable.update { it.copy(selectedMedia = id) } }
    fun selectVoice(id: String) { if (active && state.value.canEdit && id in state.value.capabilities?.speech?.voices.orEmpty()) mutable.update { it.copy(voice = id) } }
    fun setInstructions(value: String) { if (active && state.value.canEdit) mutable.update { it.copy(instructions = value) } }
    private fun current(epoch: Int) { if (!active || !state.value.online || epoch != generation) throw CancellationException() }
    private suspend fun accept(next: CompanionView, epoch: Int, show: Boolean = true) {
        currentCoroutineContext().ensureActive(); current(epoch)
        mutable.update { it.copy(record = next.record, ready = true, view = if (show) next else next.copy(turn = next.turn?.copy(transcript = null, answer = null, mediaId = null))) }
        if (next.phase !in listOf("ready", "running")) advancing = false
    }
    private fun run(action: suspend (Int) -> Unit) {
        if (!active || !state.value.writable) return
        val epoch = generation; val barrier = forgetting; mutable.update { it.copy(busy = true, message = "", confirmation = false) }
        job = scope.launch {
            try { barrier?.join(); currentCoroutineContext().ensureActive(); current(epoch); action(epoch) }
            catch (error: Exception) {
                if (error is CancellationException || epoch != generation || !active) return@launch
                advancing = false; mutable.update { it.copy(view = null, ready = false) }
                val saved = runCatching { client.record() }.getOrNull(); currentCoroutineContext().ensureActive(); current(epoch)
                mutable.update { it.copy(record = saved ?: it.record, message = (error as? CompanionException)?.displayMessage ?: (error as? VoiceTurnException)?.displayMessage ?: (error as? GatewayException)?.displayMessage ?: "结果未知，请查询原会话") }
                if (error is GatewayException && error.status == 401) authFailure(error)
            } finally { if (epoch == generation) mutable.update { it.copy(busy = false) } }
        }
    }
    fun refresh() {
        if (!active || !state.value.writable) return
        advancing = false; mutable.update { it.copy(view = null) }
        run { epoch ->
            val capability = client.capabilities(); current(epoch); val saved = client.record(); current(epoch)
            mutable.update { it.copy(ready = false, capabilities = capability, record = saved, voice = it.voice.takeIf { voice -> voice in capability.speech.voices } ?: capability.speech.voices.firstOrNull().orEmpty()) }
            if (saved != null) accept(client.resolve(), epoch, false)
            current(epoch); mutable.update { it.copy(ready = true) }
        }
    }
    fun start() {
        val s = state.value; if (!active || !s.canStart) return
        run { epoch ->
            val policy = CompanionPolicy.parse(buildJsonObject { put("schema_version", 1); put("policy_id", "native-companion"); put("version", "1.0.0"); put("name", "陪伴角色"); put("instructions", s.instructions); put("language", "zh"); put("voice", s.voice); put("max_turns", 4); put("max_seconds", 600) }.toString())
            accept(client.start(UUID.randomUUID().toString(), policy), epoch)
        }
    }
    fun reply() { if (!canReply()) return; advancing = true; val media = state.value.selectedMedia; run { epoch -> accept(client.reply(media), epoch) } }
    fun recover() { advancing = false; run { epoch -> accept(client.resolve(), epoch) } }
    fun continueSession() { if (!canContinue()) return; advancing = true; run { epoch -> accept(client.continueSession(), epoch) } }
    fun poll() {
        val s = state.value; if (!s.ready || s.confirmation || s.view?.phase != "running") return
        if (advancing) run { epoch -> accept(client.continueSession(), epoch) } else run { epoch -> accept(client.resolve(), epoch, false) }
    }
    fun requestStop() { if (active && state.value.writable && state.value.record != null) mutable.update { it.copy(confirmation = true) } }
    fun cancelStop() { mutable.update { it.copy(confirmation = false) } }
    fun confirmStop() {
        if (!state.value.writable || !state.value.confirmation) return; advancing = false; mutable.update { it.copy(view = null) }
        run { epoch -> accept(client.stop(), epoch) }
    }
    fun pause() {
        generation++; val interrupted = job; val previous = forgetting; interrupted?.cancel(); job = null; advancing = false; client.forgetContext()
        mutable.update { it.copy(busy = false, ready = false, view = null, selectedMedia = "", instructions = companionInstructions, confirmation = false) }
        forgetting = scope.launch { previous?.join(); interrupted?.join(); client.forgetContext() }
    }
    fun setOnline(value: Boolean) { if (!value) pause(); mutable.update { it.copy(online = value) } }
    fun close() { pause(); active = false }
    suspend fun waitForIdle() { job?.join(); forgetting?.join() }
}
