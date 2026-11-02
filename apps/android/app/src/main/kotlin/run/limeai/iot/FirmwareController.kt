package run.limeai.iot

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import run.limeai.iot.core.*

data class FirmwareState(val busy: Boolean = false, val ready: Boolean = false, val message: String = "", val trusts: List<FirmwareTrust> = emptyList(), val tasks: List<OtaTask> = emptyList(), val records: List<OtaRecord> = emptyList(), val reviewed: OtaTask? = null)
class FirmwareController(private val client: OtaClient, private val space: String, private val scope: CoroutineScope, private val authFailure: (Exception) -> Unit) {
    private val mutable = MutableStateFlow(FirmwareState())
    val state = mutable.asStateFlow()
    private var active = true
    fun close() { active = false; mutable.update { it.copy(ready = false, reviewed = null) } }
    private suspend fun read() {
        val records = client.records(space); if (!active) throw CancellationException()
        mutable.update { it.copy(records = records) }
        val trusts = client.trusts(space); val tasks = client.tasks(space)
        if (!active) throw CancellationException()
        mutable.update { old -> old.copy(trusts = trusts, tasks = tasks, ready = true, reviewed = old.reviewed?.takeIf { review -> tasks.any { it.id == review.id && it.revision == review.revision } }) }
    }
    private fun failure(error: Exception) {
        if (error is CancellationException) throw error
        if (!active) return
        mutable.update { it.copy(ready = false, reviewed = null, message = when (error) { is OtaException -> error.displayMessage; is GatewayException -> error.displayMessage; else -> "结果未知，请查询升级原操作" }) }
        if (error is GatewayException && error.status == 401) authFailure(error)
    }
    private fun task(action: suspend () -> Unit) {
        if (!active || mutable.value.busy) return
        mutable.update { it.copy(busy = true) }
        scope.launch {
            try { action() } catch (error: Exception) { failure(error) }
            finally { mutable.update { it.copy(busy = false) } }
        }
    }
    fun refresh() = task { read(); mutable.update { it.copy(message = "") } }
    fun review(id: String) {
        if (!mutable.value.ready) return
        task { mutable.update { it.copy(reviewed = null) }; val current = client.task(space, id); if (active) mutable.update { it.copy(reviewed = current, message = "") } }
    }
    fun submit(change: () -> JsonObject) {
        if (!mutable.value.ready) return
        task {
            mutable.update { it.copy(reviewed = null) }
            try { val result = client.submit(space, change()); read(); mutable.update { it.copy(message = result.statusText) } }
            catch (error: Exception) { runCatching { val records = client.records(space); if (active) mutable.update { it.copy(records = records) } }; throw error }
        }
    }
    fun transition(type: String) { val reviewed = mutable.value.reviewed ?: return; submit { OtaChanges.transition(reviewed, type) } }
    fun recover(key: String) = task { mutable.update { it.copy(reviewed = null) }; val result = client.resolve(space, key); read(); mutable.update { it.copy(message = result.statusText) } }
}
