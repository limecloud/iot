package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import run.limeai.iot.core.*
import java.time.Instant

data class ObservationReview(val binding: ObservationBinding, val candidate: ObservationCandidate?, val change: JsonObject, val expiresAt: Instant)
data class ObservationState(val busy: Boolean = false, val ready: Boolean = false, val online: Boolean = true, val message: String = "", val coordinator: String = "", val ieee: String = "", val endpoint: String = "1", val profile: ObservationProfile = ObservationProfile.Environment, val device: String = "", val coordinators: List<ObservationCoordinator> = emptyList(), val bindings: List<ObservationBinding> = emptyList(), val records: List<ObservationRecord> = emptyList(), val review: ObservationReview? = null, val staticDevices: List<Device> = emptyList(), val discovery: ObservationDiscovery? = null, val endpoints: ObservationEndpoints? = null) {
    val writable get() = online && ready && !busy
}
class ObservationController(private val client: ObservationClient, val space: String, private val scope: CoroutineScope, private val authFailure: (Exception) -> Unit, private val now: () -> Instant = Instant::now, val commissioning: ZigbeeController? = null) {
    val operationInProgress get() = mutable.value.busy || commissioning?.state?.value?.busy == true
    private val mutable = MutableStateFlow(ObservationState()); val state = mutable.asStateFlow()
    private var devices = emptyList<Device>(); private var context = ""; private var active = true; private var generation = 0; private var work: Job? = null
    private var selectionEpoch = 0
    fun updateDevices(next: List<Device>) {
        val nextContext = next.map { "${it.deviceId}:${it.modelRevision}:${it.observationSource?.adapterId.orEmpty()}:${it.observationSource?.revision.orEmpty()}" }.sorted().joinToString("|")
        devices = next
        if (nextContext != context) { context = nextContext; cancelReview() }
        staticDevices()
    }
    private fun staticDevices() { mutable.update { s -> s.copy(staticDevices = devices.filter { d -> d.observationSource != null && s.bindings.none { it.device == d.deviceId && it.managed } }) } }
    fun cancelReview() { selectionEpoch++; mutable.update { it.copy(review = null, discovery = null, endpoints = null) } }
    private fun selected(selection: Int) { if (selection != selectionEpoch) throw CancellationException() }
    fun setCoordinator(value: String) { if (active && !mutable.value.busy) { cancelReview(); mutable.update { it.copy(coordinator = value) } } }
    fun setIEEE(value: String) { if (active && !mutable.value.busy) { cancelReview(); mutable.update { it.copy(ieee = value, device = if (it.device.isEmpty() || it.device == "zigbee-${it.ieee}") "zigbee-$value" else it.device) } } }
    fun setEndpoint(value: String) { if (active && !mutable.value.busy) { cancelReview(); mutable.update { it.copy(endpoint = value) } } }
    fun setProfile(value: ObservationProfile) { if (active && !mutable.value.busy) { cancelReview(); mutable.update { it.copy(profile = value) } } }
    fun setDevice(value: String) { if (active && !mutable.value.busy) { cancelReview(); mutable.update { it.copy(device = value) } } }
    private suspend fun current(epoch: Int) { currentCoroutineContext().ensureActive(); if (!active || !mutable.value.online || epoch != generation) throw CancellationException() }
    private suspend fun originals(epoch: Int) { val records = client.records(space); current(epoch); mutable.update { it.copy(records = records) } }
    private suspend fun readBindings(epoch: Int) {
        val ids = (devices.filter { it.observationSource != null }.map { it.deviceId } + mutable.value.records.map { it.device }).distinct().sorted()
        val bindings = mutableListOf<ObservationBinding>()
        for (id in ids) { val b = client.binding(space, id); current(epoch); if (b.managed) bindings += b }
        current(epoch); mutable.update { it.copy(bindings = bindings) }; staticDevices()
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
                        cancelReview(); mutable.update { it.copy(ready = false, message = when (error) { is ObservationException -> error.displayMessage; is GatewayException -> error.displayMessage; else -> "接入结果待确认，请查询原操作" }) }
                        if (error is GatewayException && error.status == 401) authFailure(error)
                    }
                }
            } finally { if (epoch == generation) { mutable.update { it.copy(busy = false) }; work = null } }
        }
    }
    fun refresh() {
        cancelReview()
        task { epoch ->
            mutable.update { it.copy(ready = false) }; originals(epoch)
            val page = client.candidates(space); current(epoch)
            mutable.update { it.copy(coordinators = page.coordinators, coordinator = it.coordinator.takeIf { selected -> page.coordinators.any { it.id == selected } } ?: page.coordinators.firstOrNull()?.id.orEmpty()) }
            readBindings(epoch); mutable.update { it.copy(ready = true) }
        }
    }
    fun query() {
        val s = mutable.value; val number = s.endpoint.toIntOrNull() ?: return; if (!active || !s.writable) return
        val captured = context; cancelReview(); val selection = selectionEpoch
        task { epoch ->
            val c = client.query(space, s.coordinator, s.ieee, number, s.profile); current(epoch)
            val b = client.binding(space, s.device); current(epoch)
            selected(selection)
            if (context != captured || !c.expiresAt.isAfter(now())) throw ObservationException("observation_review_expired")
            if (!b.managed && devices.any { it.deviceId == s.device }) throw ObservationException("invalid_observation_document")
            mutable.update { it.copy(review = ObservationReview(b, c, ObservationJSON.bind(s.device, c, b), minOf(c.expiresAt, now().plusSeconds(60)))) }
        }
    }
    fun discover() {
        val s = mutable.value; val coordinator = s.coordinators.firstOrNull { it.id == s.coordinator } ?: return
        if (!active || !s.writable) return; cancelReview(); val selection = selectionEpoch
        task { epoch ->
            val result = client.discover(space, coordinator.id); current(epoch); selected(selection)
            if (result.coordinatorIEEE != coordinator.ieee || result.observedAt.isAfter(now()) || !result.expiresAt.isAfter(now())) throw ObservationException("observation_review_expired")
            mutable.update { it.copy(discovery = result) }
        }
    }
    fun readEndpoints(target: String) {
        val s = mutable.value; val found = s.discovery ?: return
        val coordinator = s.coordinators.firstOrNull { it.id == s.coordinator && it.ieee == found.coordinatorIEEE } ?: return
        if (!active || !s.writable || found.observedAt.isAfter(now()) || !found.expiresAt.isAfter(now()) || found.items.none { it.ieee == target }) return
        selectionEpoch++; val selection = selectionEpoch
        mutable.update { it.copy(review = null, endpoints = null, ieee = target, device = if (it.device.isEmpty() || it.device == "zigbee-${it.ieee}") "zigbee-$target" else it.device) }
        task { epoch ->
            val result = client.endpoints(space, coordinator.id, target); current(epoch); selected(selection)
            if (result.coordinatorIEEE != coordinator.ieee || result.observedAt.isAfter(now()) || !result.expiresAt.isAfter(now()) || !found.expiresAt.isAfter(now())) throw ObservationException("observation_review_expired")
            mutable.update { it.copy(endpoints = result) }
        }
    }
    fun queryEndpoint(number: Int) {
        val s = mutable.value; val result = s.endpoints ?: return
        val selected = result.items.firstOrNull { it.endpoint == number && (it.supportsEnvironment || it.supportsOnOff) } ?: return
        if (!active || !s.writable || result.ieee != s.ieee || result.observedAt.isAfter(now()) || !result.expiresAt.isAfter(now())) return
        mutable.update { it.copy(endpoint = number.toString(), profile = if (selected.supportsEnvironment) ObservationProfile.Environment else ObservationProfile.OnOff) }; query()
    }
    fun rebind(binding: ObservationBinding) {
        val s = mutable.value
        if (!active || !s.writable || !binding.managed || binding.active) return
        val selected = s.coordinators.firstOrNull { it.ieee == binding.coordinatorIEEE } ?: return
        mutable.update { it.copy(coordinator = selected.id, ieee = binding.ieee, endpoint = binding.endpoint.toString(), profile = binding.profile, device = binding.device) }; query()
    }
    fun reviewRevoke(device: String) {
        if (!active || !mutable.value.writable) return; cancelReview(); val captured = context; val selection = selectionEpoch
        task { epoch ->
            val b = client.binding(space, device); current(epoch)
            selected(selection)
            if (context != captured) throw ObservationException("observation_review_expired")
            mutable.update { it.copy(review = ObservationReview(b, null, ObservationJSON.revoke(b), now().plusSeconds(60))) }
        }
    }
    fun confirm() {
        val s = mutable.value; val checked = s.review ?: return
        if (!active || !s.writable || !checked.expiresAt.isAfter(now())) return
        cancelReview(); val captured = context; val selection = selectionEpoch
        task { epoch ->
            val b = client.binding(space, checked.binding.device); current(epoch)
            selected(selection)
            if (b != checked.binding || context != captured || !checked.expiresAt.isAfter(now())) throw ObservationException("observation_review_expired")
            if (checked.candidate != null) {
                val page = client.candidates(space); current(epoch)
                selected(selection)
                if (checked.candidate !in page.items || context != captured || !checked.expiresAt.isAfter(now())) throw ObservationException("observation_review_expired")
            }
            val result = client.submit(space, checked.change); current(epoch); originals(epoch); readBindings(epoch); mutable.update { it.copy(message = result.statusText) }
        }
    }
    fun recover(key: String) {
        if (mutable.value.records.none { it.key == key }) return; cancelReview()
        task { epoch -> val result = client.resolve(space, key); current(epoch); originals(epoch); readBindings(epoch); mutable.update { it.copy(message = result.statusText) } }
    }
    fun poll() {
        val s = mutable.value
        if (listOfNotNull(s.review?.expiresAt, s.discovery?.expiresAt, s.endpoints?.expiresAt).any { !it.isAfter(now()) }) { cancelReview(); mutable.update { it.copy(message = "读取结果已过期，请重新查询设备") } }
    }
    fun pause() { generation++; work?.cancel(); cancelReview(); mutable.update { it.copy(busy = false, ready = false) }; commissioning?.pause() }
    fun setOnline(value: Boolean) { if (!value) pause(); mutable.update { it.copy(online = value) }; commissioning?.setOnline(value) }
    fun close() { pause(); active = false; commissioning?.close() }
    suspend fun waitForIdle() { work?.join() }
}
