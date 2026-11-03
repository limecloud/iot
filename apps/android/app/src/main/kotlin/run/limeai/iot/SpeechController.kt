package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import run.limeai.iot.core.*

data class SpeechState(val busy: Boolean = false, val ready: Boolean = false, val online: Boolean = true, val message: String = "", val capabilities: SpeechCapabilities? = null, val records: List<SpeechRecord> = emptyList(), val text: String = "", val voice: String = "", val retainSeconds: Int = 600, val confirmation: String? = null) {
    val pending get() = records.any { it.pending }
    val writable get() = online && ready && !busy
    val canGenerate get() = writable && capabilities?.configured == true && !pending && text.isNotBlank() && text.codePointCount(0, text.length) <= 1000 && text.toByteArray(Charsets.UTF_8).size <= 4096 && capabilities.voices.contains(voice)
}
class SpeechController(private val client: SpeechClient, val space: String, private val scope: CoroutineScope, private val authFailure: (Exception) -> Unit, private val onGenerated: suspend (String) -> Unit) {
    private val mutable = MutableStateFlow(SpeechState())
    val state = mutable.asStateFlow()
    private var active = true
    private var generation = 0
    private var work: Job? = null
    fun setText(value: String) {
        if (!active || !mutable.value.writable || mutable.value.pending) return
        if (value.toByteArray(Charsets.UTF_8).size > 8192) { mutable.update { it.copy(message = "请填写 1000 字以内的文本") }; return }
        mutable.update { it.copy(text = value) }
    }
    fun selectVoice(value: String) { if (active && mutable.value.writable && !mutable.value.pending && mutable.value.capabilities?.voices?.contains(value) == true) mutable.update { it.copy(voice = value) } }
    fun setRetention(value: Int) { if (active && mutable.value.writable && !mutable.value.pending && value in listOf(600, 3600, 86400)) mutable.update { it.copy(retainSeconds = value) } }
    private suspend fun current(epoch: Int) { currentCoroutineContext().ensureActive(); if (!active || !mutable.value.online || epoch != generation) throw CancellationException() }
    private suspend fun originals(epoch: Int) { val next = client.records(space); current(epoch); mutable.update { it.copy(records = next) } }
    private suspend fun accept(record: SpeechRecord, epoch: Int, select: Boolean) {
        current(epoch); originals(epoch)
        if (select) record.mediaId?.let { onGenerated(it); current(epoch) }
    }
    private fun task(action: suspend (Int) -> Unit) {
        if (!active || !mutable.value.online || mutable.value.busy) return
        val epoch = generation
        mutable.update { it.copy(busy = true, message = "", confirmation = null) }
        work = scope.launch {
            try { current(epoch); action(epoch) }
            catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch == generation && active) {
                    runCatching { val next = client.records(space); current(epoch); mutable.update { it.copy(records = next) } }
                    if (epoch == generation && active) {
                        mutable.update { it.copy(ready = false, text = "", confirmation = null, message = when (error) { is SpeechException -> error.displayMessage; is GatewayException -> error.displayMessage; else -> "结果未知，请查询原语音任务" }) }
                        if (error is GatewayException && error.status == 401) authFailure(error)
                    }
                }
            } finally { if (epoch == generation) { mutable.update { it.copy(busy = false) }; work = null } }
        }
    }
    fun refresh() = task { epoch ->
        mutable.update { it.copy(ready = false) }; originals(epoch)
        val capability = client.capabilities(space); current(epoch)
        mutable.update { it.copy(capabilities = capability, voice = it.voice.takeIf(capability.voices::contains) ?: capability.voices.firstOrNull().orEmpty()) }
        for (record in mutable.value.records.filter { it.pending }) {
            try { accept(client.resolve(space, record.key), epoch, true) }
            catch (error: SpeechException) { if (error.code != "speech_unknown") throw error; current(epoch) }
        }
        current(epoch); mutable.update { it.copy(ready = true) }
    }
    fun generate() {
        val state = mutable.value; if (!active || !state.canGenerate) return
        try {
            val input = SpeechRequests.input(state.text, state.voice, state.retainSeconds)
            mutable.update { it.copy(text = "") }
            task { epoch -> val record = client.submit(space, input); accept(record, epoch, true); mutable.update { it.copy(message = record.statusText) } }
        } catch (error: SpeechException) { mutable.update { it.copy(message = error.displayMessage) } }
    }
    fun recover(key: String) {
        if (mutable.value.records.none { it.key == key && it.rejectedCode == null }) return
        task { epoch -> val record = client.resolve(space, key); accept(record, epoch, true); mutable.update { it.copy(ready = true, message = record.statusText) } }
    }
    fun poll() { if (mutable.value.ready) mutable.value.records.firstOrNull { it.status == "running" }?.let { recover(it.key) } }
    fun requestDiscard(key: String) { if (active && mutable.value.writable && mutable.value.records.any { it.key == key && it.status in listOf("running", "unknown") }) mutable.update { it.copy(confirmation = key) } }
    fun cancelDiscard() { mutable.update { it.copy(confirmation = null) } }
    fun confirmDiscard() {
        val key = mutable.value.confirmation ?: return; if (!active || !mutable.value.writable) return
        task { epoch -> val record = client.discard(space, key); accept(record, epoch, false); mutable.update { it.copy(message = record.statusText) } }
    }
    fun pause() { generation++; work?.cancel(); mutable.update { it.copy(busy = false, ready = false, text = "", confirmation = null) } }
    fun setOnline(value: Boolean) { if (!value) pause(); mutable.update { it.copy(online = value) } }
    fun close() { pause(); active = false }
    suspend fun waitForIdle() { work?.join() }
}
