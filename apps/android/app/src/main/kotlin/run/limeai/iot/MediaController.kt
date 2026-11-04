package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import run.limeai.iot.core.*

data class MediaState(val busy: Boolean = false, val ready: Boolean = false, val online: Boolean = true, val message: String = "", val page: MediaPage? = null, val targets: List<MediaTarget> = emptyList(), val records: List<MediaRecord> = emptyList(), val fileName: String = "", val selectedMedia: String = "", val selectedTarget: String = "", val retainSeconds: Int = 3600, val grantSeconds: Int = 300, val approved: Boolean = false, val deletion: String? = null) {
    val writable get() = online && ready && !busy && page?.configured == true
    val canGrant get() = writable && approved && page?.items?.any { it.id == selectedMedia && it.available } == true && targets.any { it.deviceId == selectedTarget }
}
class MediaController(private val client: MediaClient, val space: String, private val scope: CoroutineScope, private val authFailure: (Exception) -> Unit) {
    private val mutable = MutableStateFlow(MediaState())
    val state = mutable.asStateFlow()
    private var active = true
    private var generation = 0
    private var work: Job? = null
    private var bytes: ByteArray? = null
    private var recorded = false
    fun selectMedia(id: String) { if (!mutable.value.busy) mutable.update { it.copy(selectedMedia = id, approved = false) } }
    fun selectTarget(id: String) { if (!mutable.value.busy) mutable.update { it.copy(selectedTarget = id, approved = false) } }
    fun setRetention(value: Int) { if (!mutable.value.busy && value in listOf(600, 3600, 86400)) mutable.update { it.copy(retainSeconds = value, approved = false) } }
    fun setGrantDuration(value: Int) { if (!mutable.value.busy && value in listOf(30, 300, 600)) mutable.update { it.copy(grantSeconds = value, approved = false) } }
    fun approve(value: Boolean) { mutable.update { it.copy(approved = active && it.writable && value) } }
    fun selectFile(name: String, data: ByteArray) { selectFile(name, data, false) }
    fun selectRecording(data: ByteArray): Boolean = selectFile("recording.wav", data, true)
    private fun selectFile(name: String, data: ByteArray, recording: Boolean): Boolean {
        if (!active || !mutable.value.online || mutable.value.busy) return false
        try {
            val selected = data.copyOf(); MediaChanges.upload(selected, mutable.value.retainSeconds); bytes?.fill(0); bytes = selected; recorded = recording
            mutable.update { it.copy(fileName = name.filterNot(Char::isISOControl).take(128).ifEmpty { "audio.wav" }, message = "", approved = false) }
            return true
        } catch (error: Exception) { fileFailure(error); return false }
    }
    fun clearRecording() {
        if (!recorded) return
        bytes?.fill(0); bytes = null; recorded = false
        mutable.update { it.copy(fileName = "", approved = false) }
    }
    fun fileFailure(error: Exception) {
        if (!active || !mutable.value.online || mutable.value.busy || error is CancellationException) return
        bytes?.fill(0); bytes = null; recorded = false
        mutable.update { it.copy(fileName = "", approved = false, message = if (error is MediaException) error.displayMessage else "无法读取音频，请选择不超过 4 MiB 的 WAV 文件") }
    }
    private suspend fun current(epoch: Int) { currentCoroutineContext().ensureActive(); if (!active || !mutable.value.online || epoch != generation) throw CancellationException() }
    private suspend fun read(epoch: Int) {
        val records = client.records(space); current(epoch); mutable.update { it.copy(records = records) }
        val page = client.list(space); current(epoch); val targets = client.targets(space); current(epoch)
        mutable.update { old -> old.copy(page = page, targets = targets, ready = true,
            selectedMedia = old.selectedMedia.takeIf { id -> page.items.any { it.id == id && it.available } } ?: page.items.firstOrNull { it.available }?.id.orEmpty(),
            selectedTarget = old.selectedTarget.takeIf { id -> targets.any { it.deviceId == id } } ?: targets.firstOrNull()?.deviceId.orEmpty()) }
    }
    private fun task(action: suspend (Int) -> Unit) {
        if (!active || !mutable.value.online || mutable.value.busy) return
        val epoch = ++generation
        mutable.update { it.copy(busy = true, approved = false, deletion = null) }
        work = scope.launch {
            try { current(epoch); action(epoch) }
            catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch == generation && active) {
                    runCatching { val originals = client.records(space); current(epoch); mutable.update { it.copy(records = originals) } }
                    if (epoch == generation && active) {
                        mutable.update { it.copy(ready = false, approved = false, message = when (error) { is MediaException -> error.displayMessage; is GatewayException -> error.displayMessage; else -> "结果未知，请查询音频原操作" }) }
                        if (error is GatewayException && error.status == 401) authFailure(error)
                    }
                }
            } finally { if (epoch == generation) { mutable.update { it.copy(busy = false) }; work = null } }
        }
    }
    fun refresh() = task { epoch -> mutable.update { it.copy(ready = false) }; read(epoch); mutable.update { it.copy(message = "") } }
    suspend fun useGenerated(id: String) {
        currentCoroutineContext().ensureActive(); if (!active || !mutable.value.online) return
        mutable.update { it.copy(approved = false, deletion = null) }; waitForIdle()
        currentCoroutineContext().ensureActive(); if (!active || !mutable.value.online) return
        task { epoch -> read(epoch); mutable.update { old -> old.copy(selectedMedia = id.takeIf { value -> old.page?.items?.any { it.id == value && it.available } == true }.orEmpty(), approved = false) } }
        waitForIdle()
    }
    private fun submit(change: JsonObject) = task { epoch -> val result = client.submit(space, change); current(epoch); read(epoch); mutable.update { it.copy(message = result.statusText) } }
    fun upload() {
        if (!active || !mutable.value.writable) return
        val input = bytes ?: return
        try { val change = MediaChanges.upload(input, mutable.value.retainSeconds); bytes?.fill(0); bytes = null; recorded = false; mutable.update { it.copy(fileName = "") }; submit(change) }
        catch (error: Exception) { fileFailure(error) }
    }
    fun grant() {
        val state = mutable.value; if (!active || !state.canGrant) return
        val target = state.targets.first { it.deviceId == state.selectedTarget }
        try { submit(MediaChanges.grant(state.selectedMedia, target.deviceId, target.bindingRevision, state.grantSeconds)) }
        catch (error: Exception) { fileFailure(error) }
    }
    fun revoke(id: String) {
        if (!active || !mutable.value.writable || mutable.value.page?.grants?.none { it.id == id } != false) return
        submit(MediaChanges.revoke(id))
    }
    fun requestDelete(id: String) {
        if (!active || !mutable.value.writable || mutable.value.page?.items?.none { it.id == id && it.deletedAt == null } != false) return
        mutable.update { it.copy(deletion = id, approved = false) }
    }
    fun cancelDelete() { mutable.update { it.copy(deletion = null) } }
    fun confirmDelete() { val id = mutable.value.deletion ?: return; if (active && mutable.value.writable) submit(MediaChanges.delete(id)) }
    fun recover(key: String) {
        if (mutable.value.records.none { it.key == key }) return
        task { epoch -> val result = client.resolve(space, key); current(epoch); read(epoch); mutable.update { it.copy(message = result.statusText) } }
    }
    fun pause() {
        generation++; work?.cancel(); bytes?.fill(0); bytes = null; recorded = false
        mutable.update { it.copy(busy = false, ready = false, approved = false, deletion = null, fileName = "") }
    }
    fun setOnline(value: Boolean) { if (!value) pause(); mutable.update { it.copy(online = value) } }
    fun close() { pause(); active = false }
    suspend fun waitForIdle() { work?.join() }
}
