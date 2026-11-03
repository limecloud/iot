package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import run.limeai.iot.core.*
import java.time.Instant

data class VisionState(val busy: Boolean = false, val ready: Boolean = false, val online: Boolean = true, val message: String = "", val capabilities: VisionCapabilities? = null, val fileName: String = "", val hasImage: Boolean = false, val prompt: String = "", val records: List<VisionRecord> = emptyList(), val outputs: Map<String, VisionRecord> = emptyMap(), val confirmation: String? = null) {
    val pending get() = records.any { it.pending }
    val writable get() = online && ready && !busy
    val editable get() = writable && !pending
    val canGenerate get() = editable && capabilities?.configured == true && hasImage && runCatching { VisionRequests.validatePrompt(prompt) }.isSuccess
    val clearingSuccess get() = records.any { it.key == confirmation && it.status == "succeeded" }
    fun text(key: String): String? = outputs[key]?.takeIf { it.outputExpiresAt?.isAfter(Instant.now()) == true }?.text
}
class VisionController(private val client: VisionClient, val space: String, private val scope: CoroutineScope, private val authFailure: (Exception) -> Unit, private val now: () -> Instant = Instant::now) {
    private val mutable = MutableStateFlow(VisionState())
    val state = mutable.asStateFlow()
    private var image: ByteArray? = null
    private var contentType = ""
    private var active = true
    private var generation = 0
    private var work: Job? = null
    fun setPrompt(value: String) { if (active && mutable.value.editable) mutable.update { it.copy(prompt = value) } }
    fun selectFile(name: String, bytes: ByteArray) {
        if (!active || !mutable.value.editable) return
        clearImage()
        try { contentType = VisionRequests.contentType(bytes); image = bytes.copyOf(); mutable.update { it.copy(fileName = name.take(128), hasImage = true, message = "") } }
        catch (error: Exception) { fileFailure(error) }
    }
    fun fileFailure(error: Exception) { if (!active || !mutable.value.online || error is CancellationException) return; clearImage(); mutable.update { it.copy(message = "请选择不超过2 MiB、边长不超过1024像素的PNG或JPEG") } }
    private fun clearImage() { image = null; contentType = ""; mutable.update { it.copy(fileName = "", hasImage = false) } }
    private fun clearInput() { clearImage(); mutable.update { it.copy(prompt = "") } }
    private fun showable(record: VisionRecord) = record.outputExpiresAt?.isAfter(now()) == true
    private fun expireOutputs() { mutable.update { it.copy(outputs = it.outputs.filterValues(::showable)) } }
    private suspend fun current(epoch: Int) { currentCoroutineContext().ensureActive(); if (!active || !mutable.value.online || epoch != generation) throw CancellationException() }
    private suspend fun originals(epoch: Int) { val next = client.records(space); current(epoch); mutable.update { it.copy(records = next) } }
    private suspend fun accept(record: VisionRecord, epoch: Int, showText: Boolean = true) {
        current(epoch); originals(epoch)
        mutable.update { it.copy(outputs = if (showText && record.text != null && showable(record)) it.outputs + (record.key to record) else it.outputs - record.key) }
        expireOutputs()
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
                        clearInput(); mutable.update { it.copy(ready = false, outputs = emptyMap(), confirmation = null, message = when (error) { is VisionException -> error.displayMessage; is GatewayException -> error.displayMessage; else -> "结果未知，请查询原观察任务" }) }
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
            catch (error: VisionException) { if (error.code != "vision_unknown") throw error; current(epoch) }
        }
        expireOutputs(); current(epoch); mutable.update { it.copy(ready = true) }
    }
    fun generate() {
        val state = mutable.value; val bytes = image; if (!active || !state.canGenerate || bytes == null) return
        val question = state.prompt; val type = contentType; clearInput()
        task { epoch ->
            val input = withContext(Dispatchers.Default) { VisionRequests.input(bytes, type, question) }; current(epoch)
            val record = client.submit(space, input); accept(record, epoch); mutable.update { it.copy(message = record.statusText) }
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
        task { epoch -> val record = client.discard(space, key); accept(record, epoch); mutable.update { it.copy(message = record.statusText) } }
    }
    fun pause() { generation++; work?.cancel(); clearInput(); mutable.update { it.copy(busy = false, ready = false, outputs = emptyMap(), confirmation = null) } }
    fun setOnline(value: Boolean) { if (!value) pause(); mutable.update { it.copy(online = value) } }
    fun close() { pause(); active = false }
    suspend fun waitForIdle() { work?.join() }
}
