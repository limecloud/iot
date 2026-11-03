package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.time.Instant

data class TranscriptionState(val busy: Boolean = false, val ready: Boolean = false, val online: Boolean = true, val message: String = "", val capabilities: TranscriptionCapabilities? = null, val sources: List<MediaItem> = emptyList(), val selectedMedia: String = "", val language: String = "auto", val records: List<TranscriptionRecord> = emptyList(), val outputs: Map<String, TranscriptionRecord> = emptyMap(), val confirmation: String? = null) {
    val pending get() = records.any { it.pending }
    val writable get() = online && ready && !busy
    val canGenerate get() = writable && !pending && capabilities?.configured == true && sources.any { it.id == selectedMedia && available(it) }
    fun text(key: String): String? = outputs[key]?.takeIf { showable(it, sources) }?.text
}
private fun available(item: MediaItem) = item.available && runCatching { Instant.parse(item.expiresAt).isAfter(Instant.now()) }.getOrDefault(false)
private fun showable(record: TranscriptionRecord, sources: List<MediaItem>) = record.outputExpiresAt?.isAfter(Instant.now()) == true && sources.any { it.id == record.original.getValue("input").jsonObject["media_id"]?.jsonPrimitive?.content && available(it) }
class TranscriptionController(private val client: TranscriptionClient, private val media: MediaClient, val space: String, private val scope: CoroutineScope, private val authFailure: (Exception) -> Unit) {
    private val mutable = MutableStateFlow(TranscriptionState())
    val state = mutable.asStateFlow()
    private var active = true
    private var generation = 0
    private var work: Job? = null
    fun selectMedia(id: String) { if (active && mutable.value.writable && !mutable.value.pending) mutable.update { it.copy(selectedMedia = id.takeIf { id -> it.sources.any { source -> source.id == id && available(source) } }.orEmpty()) } }
    fun selectLanguage(value: String) { if (active && mutable.value.writable && !mutable.value.pending && value in listOf("auto", "zh", "en")) mutable.update { it.copy(language = value) } }
    private fun expireOutputs() { mutable.update { it.copy(outputs = it.outputs.filterValues { record -> showable(record, it.sources) }) } }
    private suspend fun current(epoch: Int) { currentCoroutineContext().ensureActive(); if (!active || !mutable.value.online || epoch != generation) throw CancellationException() }
    private suspend fun originals(epoch: Int) { val next = client.records(space); current(epoch); mutable.update { it.copy(records = next) } }
    private suspend fun accept(record: TranscriptionRecord, epoch: Int) {
        current(epoch); originals(epoch)
        mutable.update { it.copy(outputs = if (record.text != null && showable(record, it.sources)) it.outputs + (record.key to record) else it.outputs - record.key) }
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
                        mutable.update { it.copy(ready = false, outputs = emptyMap(), confirmation = null, message = when (error) { is TranscriptionException -> error.displayMessage; is GatewayException -> error.displayMessage; else -> "结果未知，请查询原识别任务" }) }
                        if (error is GatewayException && error.status == 401) authFailure(error)
                    }
                }
            } finally { if (epoch == generation) { mutable.update { it.copy(busy = false) }; work = null } }
        }
    }
    fun refresh() = task { epoch ->
        mutable.update { it.copy(ready = false) }; originals(epoch)
        val capability = client.capabilities(space); current(epoch)
        val page = media.list(space); current(epoch)
        val sources = page.items.filter(::available)
        mutable.update { state -> state.copy(capabilities = capability, sources = sources, selectedMedia = state.selectedMedia.takeIf { id -> sources.any { it.id == id } }.orEmpty(), outputs = state.outputs.filterValues { record -> sources.any { it.id == record.original.getValue("input").jsonObject["media_id"]?.jsonPrimitive?.content } }) }
        for (record in mutable.value.records.filter { it.pending }) {
            try { accept(client.resolve(space, record.key), epoch) }
            catch (error: TranscriptionException) { if (error.code != "transcription_unknown") throw error; current(epoch) }
        }
        expireOutputs(); current(epoch); mutable.update { it.copy(ready = true) }
    }
    fun generate() {
        val state = mutable.value; if (!active || !state.canGenerate) return
        val source = state.sources.firstOrNull { it.id == state.selectedMedia } ?: return
        try {
            val input = TranscriptionRequests.input(source.id, source.metadata.getValue("content_digest").jsonPrimitive.content, state.language)
            task { epoch -> val record = client.submit(space, input); accept(record, epoch); mutable.update { it.copy(message = record.statusText) } }
        } catch (error: TranscriptionException) { mutable.update { it.copy(message = error.displayMessage) } }
    }
    fun recover(key: String) {
        if (mutable.value.records.none { it.key == key && it.rejectedCode == null }) return
        task { epoch -> val record = client.resolve(space, key); accept(record, epoch); mutable.update { it.copy(ready = true, message = record.statusText) } }
    }
    fun poll() { expireOutputs(); if (mutable.value.ready) mutable.value.records.firstOrNull { it.status == "running" }?.let { recover(it.key) } }
    fun requestDiscard(key: String) { if (active && mutable.value.writable && mutable.value.records.any { it.key == key && it.status in listOf("running", "unknown") }) mutable.update { it.copy(confirmation = key) } }
    fun cancelDiscard() { mutable.update { it.copy(confirmation = null) } }
    fun confirmDiscard() {
        val key = mutable.value.confirmation ?: return; if (!active || !mutable.value.writable) return
        task { epoch -> val record = client.discard(space, key); accept(record, epoch); mutable.update { it.copy(message = record.statusText) } }
    }
    fun pause() { generation++; work?.cancel(); mutable.update { it.copy(busy = false, ready = false, outputs = emptyMap(), sources = emptyList(), selectedMedia = "", confirmation = null) } }
    fun setOnline(value: Boolean) { if (!value) pause(); mutable.update { it.copy(online = value) } }
    fun close() { pause(); active = false }
    suspend fun waitForIdle() { work?.join() }
}
