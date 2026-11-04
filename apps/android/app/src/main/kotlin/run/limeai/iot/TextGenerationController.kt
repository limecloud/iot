package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import run.limeai.iot.core.*
import java.time.Instant
import java.util.UUID

data class TextGenerationState(val busy: Boolean = false, val ready: Boolean = false, val online: Boolean = true, val message: String = "", val prompt: String = "", val capabilities: TextGenerationCapabilities? = null, val records: List<TextGenerationRecord> = emptyList(), val outputs: Map<String, TextGenerationRecord> = emptyMap(), val messages: List<TextGenerationMessage> = emptyList(), val confirmation: String? = null) {
    val pending get() = records.any { it.pending }
    val writable get() = online && ready && !busy
    val editable get() = writable && !pending
    val canGenerate get() = editable && capabilities?.configured == true && runCatching { TextGenerationRequests.input(messages + TextGenerationMessage("user", prompt)) }.isSuccess
    val clearingSuccess get() = records.any { it.key == confirmation && it.status == "succeeded" }
    fun text(key: String): String? = outputs[key]?.takeIf { it.outputExpiresAt?.isAfter(Instant.now()) == true }?.text
}
class TextGenerationController(private val client: TextGenerationClient, val space: String, private val scope: CoroutineScope, private val authFailure: (Exception) -> Unit, private val now: () -> Instant = Instant::now) {
    private val mutable = MutableStateFlow(TextGenerationState())
    val state = mutable.asStateFlow()
    private data class Turn(val key: String, val messages: List<TextGenerationMessage>, val expires: Instant?)
    private var contextExpiresAt: Instant? = null
    private var turn: Turn? = null
    private var active = true
    private var generation = 0
    private var work: Job? = null
    fun setPrompt(value: String) { if (active && mutable.value.editable) mutable.update { it.copy(prompt = value) } }
    fun prepareQuestion(value: String): Boolean {
        if (!active || !mutable.value.editable || mutable.value.capabilities?.configured != true) return false
        if (runCatching { TextGenerationRequests.input(listOf(TextGenerationMessage("user", value))) }.isFailure) {
            mutable.update { it.copy(message = "识别文字不适合提问，请核对内容") }; return false
        }
        startNew(); setPrompt(value); return true
    }
    private fun clearConversation() { contextExpiresAt = null; turn = null; mutable.update { it.copy(prompt = "", messages = emptyList()) } }
    fun startNew() { if (!active || !mutable.value.editable) return; clearConversation(); mutable.update { it.copy(outputs = emptyMap(), message = "") } }
    private fun showable(record: TextGenerationRecord) = record.outputExpiresAt?.isAfter(now()) == true
    private fun expireOutputs() {
        mutable.update { it.copy(outputs = it.outputs.filterValues(::showable)) }
        if (contextExpiresAt?.let { it <= now() } == true) { clearConversation(); mutable.update { it.copy(outputs = emptyMap()) } }
    }
    private suspend fun current(epoch: Int) { currentCoroutineContext().ensureActive(); if (!active || !mutable.value.online || epoch != generation) throw CancellationException() }
    private suspend fun originals(epoch: Int) { val next = client.records(space); current(epoch); mutable.update { it.copy(records = next) } }
    private suspend fun accept(record: TextGenerationRecord, epoch: Int, showText: Boolean = true) {
        current(epoch); originals(epoch)
        val text = record.text
        mutable.update { it.copy(outputs = if (showText && text != null && showable(record)) it.outputs + (record.key to record) else it.outputs - record.key) }
        val original = turn
        if (showText && text != null && showable(record) && original?.key == record.key) {
            val expires = record.outputExpiresAt!!; val end = minOf(original.expires ?: expires, expires)
            if (end > now()) { contextExpiresAt = end; mutable.update { it.copy(messages = original.messages + TextGenerationMessage("assistant", text)) } }
            turn = null
        }
        expireOutputs()
    }
    private fun task(action: suspend (Int) -> Unit) {
        if (!active || !mutable.value.online || mutable.value.busy) return
        val epoch = generation; mutable.update { it.copy(busy = true, message = "", confirmation = null) }
        work = scope.launch {
            try { current(epoch); action(epoch) }
            catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch == generation && active) {
                    runCatching { val next = client.records(space); current(epoch); mutable.update { it.copy(records = next) } }
                    if (epoch == generation && active) {
                        clearConversation(); mutable.update { it.copy(ready = false, outputs = emptyMap(), confirmation = null, message = when (error) { is TextGenerationException -> error.displayMessage; is GatewayException -> error.displayMessage; else -> "结果未知，请查询原文字任务" }) }
                        if (error is GatewayException && error.status == 401) authFailure(error)
                    }
                }
            } finally { if (epoch == generation) { mutable.update { it.copy(busy = false) }; work = null } }
        }
    }
    fun refresh() = task { epoch ->
        mutable.update { it.copy(ready = false) }; originals(epoch)
        val capability = client.capabilities(space); current(epoch); mutable.update { it.copy(capabilities = capability) }
        for (record in mutable.value.records.filter { it.pending }) {
            try { accept(client.resolve(space, record.key), epoch, showText = false) }
            catch (error: TextGenerationException) { if (error.code != "text_unknown") throw error; current(epoch) }
        }
        expireOutputs(); current(epoch); mutable.update { it.copy(ready = true) }
    }
    fun generate() {
        expireOutputs(); val state = mutable.value; if (!active || !state.canGenerate) return
        val context = state.messages + TextGenerationMessage("user", state.prompt); val key = UUID.randomUUID().toString()
        turn = Turn(key, context, contextExpiresAt); mutable.update { it.copy(prompt = "") }
        task { epoch ->
            val input = TextGenerationRequests.input(context); current(epoch)
            val record = client.submit(space, input, key); accept(record, epoch); mutable.update { it.copy(message = record.statusText) }
        }
    }
    fun recover(key: String) {
        if (mutable.value.records.none { it.key == key && it.rejectedCode == null }) return
        task { epoch -> val record = client.resolve(space, key); accept(record, epoch); mutable.update { it.copy(ready = true, message = record.statusText) } }
    }
    fun poll() { expireOutputs(); if (mutable.value.ready && mutable.value.confirmation == null) mutable.value.records.firstOrNull { it.status == "running" }?.let { recover(it.key) } }
    fun requestDiscard(key: String) { if (active && mutable.value.writable && mutable.value.records.any { it.key == key && it.canDiscard }) mutable.update { it.copy(confirmation = key) } }
    fun cancelDiscard() { mutable.update { it.copy(confirmation = null) } }
    fun confirmDiscard() {
        val key = mutable.value.confirmation ?: return; if (!active || !mutable.value.writable) return
        clearConversation(); mutable.update { it.copy(outputs = emptyMap()) }
        task { epoch -> val record = client.discard(space, key); accept(record, epoch); mutable.update { it.copy(message = record.statusText) } }
    }
    fun pause() { generation++; work?.cancel(); clearConversation(); mutable.update { it.copy(busy = false, ready = false, outputs = emptyMap(), confirmation = null) } }
    fun setOnline(value: Boolean) { if (!value) pause(); mutable.update { it.copy(online = value) } }
    fun close() { pause(); active = false }
    suspend fun waitForIdle() { work?.join() }
}
