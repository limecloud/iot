package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import run.limeai.iot.core.*
import java.time.Instant

data class ZigbeeReview(val preparation: ZigbeePreparation, val expiresAt: Instant)
data class ZigbeeState(val busy: Boolean = false, val ready: Boolean = false, val online: Boolean = true, val coordinator: String = "", val seconds: String = "60", val message: String = "", val coordinators: List<ZigbeeCoordinator> = emptyList(), val records: List<ZigbeeRecord> = emptyList(), val history: List<ZigbeeRecord> = emptyList(), val review: ZigbeeReview? = null) {
    val writable get() = online && ready && !busy
    val entries get() = history + records.filter { old -> history.none { it.key == old.key } }
}
class ZigbeeController(private val client: ZigbeeClient, val space: String, private val scope: CoroutineScope, private val authFailure: (Exception) -> Unit, private val now: () -> Instant = Instant::now) {
    private val mutable = MutableStateFlow(ZigbeeState()); val state = mutable.asStateFlow()
    private var active = true; private var generation = 0; private var work: Job? = null
    fun setCoordinator(value: String) { if (active && !mutable.value.busy) mutable.update { it.copy(coordinator = value, review = null) } }
    fun setSeconds(value: String) { if (active && !mutable.value.busy) mutable.update { it.copy(seconds = value, review = null) } }
    fun cancelReview() { mutable.update { it.copy(review = null) } }
    private suspend fun current(epoch: Int) { currentCoroutineContext().ensureActive(); if (!active || !mutable.value.online || epoch != generation) throw CancellationException() }
    private suspend fun originals(epoch: Int) { val saved = client.records(space); current(epoch); mutable.update { it.copy(records = saved) } }
    private suspend fun read(epoch: Int) {
        originals(epoch); val catalog = client.coordinators(space); val history = client.history(space); current(epoch)
        for (old in mutable.value.records) history.firstOrNull { it.key == old.key }?.result?.let { ZigbeeJSON.operation(it, old.request, old.result) }
        mutable.update { it.copy(coordinators = catalog, history = history, coordinator = it.coordinator.takeIf { selected -> catalog.any { it.id == selected } } ?: catalog.firstOrNull()?.id.orEmpty()) }
    }
    private fun task(action: suspend (Int) -> Unit) {
        if (!active || !mutable.value.online || mutable.value.busy) return
        val epoch = generation; mutable.update { it.copy(busy = true, message = "") }
        work = scope.launch {
            try { current(epoch); action(epoch) }
            catch (error: Exception) {
                if (error is CancellationException) throw error
                if (epoch == generation && active) {
                    runCatching { originals(epoch) }
                    if (epoch == generation && active) {
                        mutable.update { it.copy(ready = false, review = null, message = when (error) { is ZigbeeException -> error.displayMessage; is GatewayException -> error.displayMessage; else -> "入网结果待确认，请查询原操作" }) }
                        if (error is GatewayException && error.status == 401) authFailure(error)
                    }
                }
            } finally { if (epoch == generation) { mutable.update { it.copy(busy = false) }; work = null } }
        }
    }
    fun refresh() { cancelReview(); task { epoch -> mutable.update { it.copy(ready = false) }; read(epoch); mutable.update { it.copy(ready = true) } } }
    fun prepare(close: Boolean = false) {
        val s = mutable.value; if (!active || !s.writable) return
        val seconds = if (close) 0 else s.seconds.toIntOrNull() ?: -1
        if (!close && seconds !in 1..120) { mutable.update { it.copy(review = null, message = ZigbeeException("invalid_zigbee_change").displayMessage) }; return }
        cancelReview()
        task { epoch -> val result = client.prepare(space, s.coordinator, seconds); current(epoch); mutable.update { it.copy(review = ZigbeeReview(result, now().plusSeconds(60))) } }
    }
    fun confirm() {
        val s = mutable.value; val checked = s.review ?: return
        if (!active || !s.writable || !checked.expiresAt.isAfter(now())) return; cancelReview()
        task { epoch ->
            val result = client.submit(space, checked.preparation, checked.expiresAt); current(epoch); read(epoch)
            mutable.update { it.copy(message = if (result.accepted) { if (result.seconds == 0) "关闭入网协议已受理" else "开放入网协议已受理，请继续发现设备" } else "入网结果未知，请查询原操作") }
        }
    }
    fun recover(key: String) {
        val s = mutable.value; if (s.records.none { it.key == key } && s.history.none { it.key == key }) return; cancelReview()
        task { epoch ->
            client.resolve(space, key)
            read(epoch); mutable.update { it.copy(message = if (it.entries.firstOrNull { r -> r.key == key }?.accepted == true) "已查询原操作，协议已受理" else "结果仍未知，请保留原操作记录") }
        }
    }
    fun poll() { if (mutable.value.review?.expiresAt?.isAfter(now()) == false) mutable.update { it.copy(review = null, message = ZigbeeException("zigbee_review_expired").displayMessage) } }
    fun pause() { generation++; work?.cancel(); mutable.update { it.copy(busy = false, ready = false, review = null) } }
    fun setOnline(value: Boolean) { if (!value) pause(); mutable.update { it.copy(online = value) } }
    fun close() { pause(); active = false }
    suspend fun waitForIdle() { work?.join() }
}
