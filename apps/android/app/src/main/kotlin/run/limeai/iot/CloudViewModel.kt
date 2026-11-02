package run.limeai.iot

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import run.limeai.iot.core.*

data class CloudState(
    val origin: String = "", val principal: ControlPrincipal? = null, val login: NativeLogin? = null,
    val pendingAuthorization: Boolean = false, val polling: Boolean = false, val busy: Boolean = false,
    val online: Boolean = false, val foreground: Boolean = false, val message: String = "",
    val spaces: List<ControlSpace> = emptyList(), val space: String = "", val gateway: ControlGateway? = null,
    val devices: List<Device> = emptyList(), val models: Map<String, Model> = emptyMap(),
    val records: List<ControlCommandRecord> = emptyList(), val hasMore: Boolean = false
) {
    fun blocked(device: Device) = records.any { it.reference.request.deviceId == device.deviceId && it.rejection == null && it.result?.status?.terminal != true }
}

class CloudViewModel(
    private val vault: SessionStore, initialOrigin: String = "", private val saveOrigin: (String) -> Unit = {},
    private val transport: GatewayTransport = OkHttpTransport()
) : ViewModel() {
    private val mutable = MutableStateFlow(CloudState(origin = initialOrigin))
    val state = mutable.asStateFlow()
    private var client: ControlClient? = null
    private var restoredOrigin: String? = null
    private var visiblePages = 1
    private fun current(origin: String = mutable.value.origin): ControlClient {
        val exact = origin.trim()
        client?.takeIf { it.origin == exact }?.let { return it }
        if (mutable.value.principal != null || mutable.value.pendingAuthorization) throw ControlException("already_authenticated")
        val next = ControlClient(exact, vault, transport)
        client = next; saveOrigin(exact); mutable.update { it.copy(origin = exact) }; return next
    }
    private fun clearWorkspace() {
        visiblePages = 1
        mutable.update { it.copy(online = false, spaces = emptyList(), space = "", gateway = null, devices = emptyList(), models = emptyMap(), records = emptyList(), hasMore = false) }
    }
    private fun failure(error: Exception) {
        if (error is CancellationException) throw error
        mutable.update { it.copy(online = false, message = (error as? ControlException)?.displayMessage ?: "无法连接云服务，请检查网络后重试") }
        if (error is ControlException && error.status == 401) {
            mutable.update { it.copy(principal = null, login = null, polling = false) }; clearWorkspace()
        }
    }
    private suspend fun execute(action: suspend () -> Unit) {
        if (mutable.value.busy) return
        mutable.update { it.copy(busy = true, message = "") }
        try { action() } catch (error: Exception) { failure(error) }
        finally { mutable.update { it.copy(busy = false) } }
    }
    private fun task(action: suspend () -> Unit) { viewModelScope.launch { execute(action) } }
    fun enterForeground() { mutable.update { it.copy(foreground = true) } }
    fun leaveForeground() { mutable.update { it.copy(foreground = false, online = false) } }
    suspend fun tick() {
        if (!mutable.value.foreground || mutable.value.busy) return
        if (mutable.value.origin.isNotEmpty() && restoredOrigin != mutable.value.origin) { execute { restoreCurrent(current()) }; return }
        if (mutable.value.polling) execute { poll() }
        else if (mutable.value.principal != null) execute { loadWorkspace(current()) }
    }
    fun restore(origin: String) = task { restoreCurrent(current(origin)) }
    private suspend fun restoreCurrent(current: ControlClient) {
        restoredOrigin = current.origin
        val pending = current.hasPendingAuthorization()
        mutable.update { it.copy(pendingAuthorization = pending) }
        try {
            val session = current.restoreSession()
            mutable.update { it.copy(principal = session.principal, login = null, polling = false) }
        } catch (error: ControlException) {
            if (error.status != 401) throw error
            mutable.update { it.copy(principal = null) }; clearWorkspace()
            if (mutable.value.pendingAuthorization) {
                val login = current.beginAuthorization()
                mutable.update { it.copy(login = login, polling = login.status in listOf(NativeAuthorizationStatus.PENDING, NativeAuthorizationStatus.APPROVED)) }
            }
            return
        }
        loadWorkspace(current)
    }
    fun begin(origin: String) = task {
        val current = current(origin); restoredOrigin = current.origin
        try {
            val login = current.beginAuthorization()
            mutable.update { it.copy(login = login, pendingAuthorization = true, polling = login.status in listOf(NativeAuthorizationStatus.PENDING, NativeAuthorizationStatus.APPROVED)) }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            val pending = runCatching { current.hasPendingAuthorization() }.getOrDefault(true)
            mutable.update { it.copy(pendingAuthorization = pending) }; throw error
        }
    }
    fun cancel() = task {
        current().cancelAuthorization()
        mutable.update { it.copy(principal = null, login = null, polling = false, pendingAuthorization = false) }; clearWorkspace()
    }
    fun resumePolling() { if (mutable.value.login != null && mutable.value.principal == null) mutable.update { it.copy(polling = true, message = "") } }
    private suspend fun poll() {
        if (!mutable.value.foreground) return
        try {
            val current = current(); val result = current.pollAuthorization()
            when (result.status) {
                NativeAuthorizationStatus.APPROVED -> {
                    val session = result.session ?: throw ControlException("invalid_response")
                    mutable.update { it.copy(principal = session.principal, login = null, polling = false) }; loadWorkspace(current)
                }
                NativeAuthorizationStatus.DENIED -> mutable.update { it.copy(polling = false, message = "登录未获批准，请结束本次登录后重新发起") }
                NativeAuthorizationStatus.CANCELLED -> mutable.update { it.copy(login = null, polling = false, pendingAuthorization = false) }
                NativeAuthorizationStatus.PENDING -> Unit
            }
        } catch (error: Exception) {
            if (error !is CancellationException) mutable.update { it.copy(polling = false) }; throw error
        }
    }
    fun refresh() = task { if (mutable.value.principal != null) loadWorkspace(current()) }
    fun selectSpace(id: String) = task {
        if (mutable.value.spaces.none { it.spaceId == id }) return@task
        visiblePages = 1
        mutable.update { it.copy(space = id, online = false, gateway = null, devices = emptyList(), models = emptyMap(), records = emptyList(), hasMore = false) }
        loadWorkspace(current())
    }
    fun loadMore() = task { if (mutable.value.hasMore) loadWorkspace(current(), visiblePages + 1) }
    private suspend fun loadWorkspace(current: ControlClient, pageCount: Int = visiblePages) {
        val available = current.spaces()
        currentCoroutineContext().ensureActive()
        if (available.none { it.spaceId == mutable.value.space }) {
            clearWorkspace(); mutable.update { it.copy(space = available.firstOrNull()?.spaceId.orEmpty()) }
        }
        mutable.update { it.copy(spaces = available) }
        val space = mutable.value.space
        if (space.isEmpty()) { mutable.update { it.copy(online = true) }; return }
        val records = current.commandRecords(space); mutable.update { it.copy(records = records) }
        val bindings = current.gateways(space).filter { it.active }
        if (bindings.size > 1) throw ControlException("invalid_response")
        val binding = bindings.singleOrNull()
        if (binding == null) { mutable.update { it.copy(gateway = null, devices = emptyList(), models = emptyMap(), hasMore = false, online = true) }; return }
        if (binding.spaceId != space || binding.principalId != mutable.value.principal?.principalId) throw ControlException("invalid_response")
        val devices = mutableListOf<Device>(); val seen = mutableSetOf<String>(); var after: String? = null; var count = 0
        do {
            val page = current.devices(space, after)
            if (page.bindingRevision != binding.revision) throw ControlException("invalid_response")
            devices += page.items; after = page.next; count++
            if (after != null && !seen.add(after)) throw ControlException("invalid_response")
        } while (after != null && count < pageCount)
        if (devices.map { it.deviceId }.distinct().size != devices.size) throw ControlException("invalid_response")
        val models = mutableMapOf<String, Model>()
        for (revision in devices.map { it.modelRevision }.distinct()) models[revision] = mutable.value.models[revision] ?: current.model(space, revision)
        currentCoroutineContext().ensureActive(); visiblePages = count
        mutable.update { it.copy(gateway = binding, devices = devices.toList(), models = models.toMap(), hasMore = after != null, online = true) }
    }
    fun control(device: Device, path: String, value: JsonElement, type: String = "property.set") = task {
        val state = mutable.value; val binding = state.gateway ?: return@task
        if (!state.foreground || !state.online || state.blocked(device)) return@task
        val current = current(); val record = current.prepareCommand(state.space, binding, device, path, value, type)
        mutable.update { it.copy(records = it.records + record) }
        try { current.submitCommand(record.id) }
        catch (error: Exception) {
            if (error is CancellationException) throw error
            val saved = runCatching { current.commandRecords(state.space) }.getOrNull()
            if (saved != null) mutable.update { it.copy(records = saved) }
            if (error !is ControlException) { mutable.update { it.copy(online = false, message = "操作结果尚未确认，请查询原操作") }; return@task }
            throw error
        }
        val records = current.commandRecords(state.space); mutable.update { it.copy(records = records) }
    }
    fun resolve(record: ControlCommandRecord) = task {
        val updated = current().resolveCommand(record.id, reconcile = true)
        mutable.update { it.copy(records = it.records.map { old -> if (old.id == updated.id) updated else old }) }
    }
    fun forget(record: ControlCommandRecord) = task {
        current().forgetCommand(record.id); mutable.update { it.copy(records = it.records.filter { old -> old.id != record.id }) }
    }
    fun logout() = task {
        current().logout()
        mutable.update { it.copy(principal = null, login = null, polling = false, pendingAuthorization = false) }; clearWorkspace()
    }
    fun browserFailed() { mutable.update { it.copy(message = "无法打开浏览器，请检查系统设置后重试") } }
}
