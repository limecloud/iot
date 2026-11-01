package run.limeai.iot

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import run.limeai.iot.core.*

data class HomeState(val origin: String = "", val connected: Boolean = false, val online: Boolean = false, val busy: Boolean = false, val message: String = "", val snapshot: Snapshot? = null, val pending: Map<String, CommandIntent> = emptyMap(), val draftReference: DraftReference? = null, val draft: RuleDraft? = null, val draftPrompt: String = "", val draftBusy: Boolean = false, val draftProof: String? = null, val draftMessage: String = "")
class HomeViewModel(application: Application) : AndroidViewModel(application) {
    private val preferences = application.getSharedPreferences("home", Application.MODE_PRIVATE)
    private val mutable = MutableStateFlow(HomeState(origin = preferences.getString("origin", "").orEmpty()))
    val state = mutable.asStateFlow()
    private val vault = SecureStore(application)
    private var client: GatewayClient? = null
    private var refreshing = false
    private var generation = 0
    init { if (mutable.value.origin.isNotEmpty()) connect(mutable.value.origin, null, true) }
    fun connect(origin: String, token: String?, restore: Boolean = false) {
        if (mutable.value.busy || mutable.value.draftBusy) return
        mutable.update { it.copy(busy = true, message = "") }
        viewModelScope.launch {
            try {
                val next = GatewayClient(origin.trim(), store = vault)
                if (restore) next.restore() else next.login(token.orEmpty())
                val pending = vault.load(origin.trim() + "#pending")?.let { Json.decodeFromString<Map<String, CommandIntent>>(it) }.orEmpty()
                val reference = vault.load(origin.trim() + "#draft")?.let { Json.decodeFromString<DraftReference>(it) }
                client = next; generation++
                preferences.edit().putString("origin", origin.trim()).apply()
                mutable.update { it.copy(origin = origin.trim(), connected = true, pending = pending, draftReference = reference, draft = null, draftPrompt = "", draftMessage = "", draftProof = null) }; refresh()
            } catch (error: Exception) { if (!(restore && error is GatewayException && error.status == 401)) report(error) }
            finally { mutable.update { it.copy(busy = false) } }
        }
    }
    suspend fun refresh() {
        val current = client ?: return
        if (refreshing || !mutable.value.connected) return
        refreshing = true; val old = generation
        try {
            val next = current.snapshot()
            if (old == generation) {
                mutable.update { it.copy(snapshot = next, online = true, message = "") }
                if (!mutable.value.draftBusy && mutable.value.draftReference != null && (mutable.value.draft == null || mutable.value.draft?.status == "running")) loadDraft()
            }
        }
        catch (error: Exception) { if (old == generation) report(error) }
        finally { refreshing = false }
    }
    fun refreshNow() { viewModelScope.launch { refresh() } }
    private suspend fun savePending(next: Map<String, CommandIntent>) {
        vault.save(mutable.value.origin + "#pending", Json.encodeToString(next))
        mutable.update { it.copy(pending = next) }
    }
    fun control(device: Device, path: String, value: JsonElement) {
        val current = client ?: return
        val snapshot = mutable.value.snapshot ?: return
        if (!mutable.value.online || mutable.value.busy || mutable.value.pending.containsKey(device.deviceId)) return
        mutable.update { it.copy(busy = true, message = "") }
        viewModelScope.launch {
            val intent = CommandIntent.create(device, path, value)
            var submitted = false
            try {
                savePending(mutable.value.pending + (device.deviceId to intent)); submitted = true
                current.create(snapshot.space, intent)
                savePending(mutable.value.pending - device.deviceId); refresh()
            } catch (error: GatewayException) {
                if (error.definitiveRejection) {
                    runCatching { savePending(mutable.value.pending - device.deviceId) }; report(error)
                } else mutable.update { it.copy(message = "操作结果尚未确认，请查询原操作") }
            } catch (error: Exception) { if (error is CancellationException) throw error; mutable.update { if (submitted) it.copy(online = false, message = "操作结果尚未确认，请查询原操作") else it.copy(message = "无法保存本地操作记录，请稍后重试") } }
            finally { mutable.update { it.copy(busy = false) } }
        }
    }
    fun recover(device: Device) = task {
        val current = client ?: return@task; val snapshot = mutable.value.snapshot ?: return@task; val intent = mutable.value.pending[device.deviceId] ?: return@task
        current.resolve(snapshot.space, intent.key); savePending(mutable.value.pending - device.deviceId); refresh()
    }
    suspend fun simulate(rule: Rule, event: JsonElement): Simulation {
        val current = client ?: throw GatewayException("unauthenticated", 401)
        val snapshot = mutable.value.snapshot ?: throw GatewayException("unauthenticated", 401)
        return current.simulate(snapshot.space, rule, event)
    }
    fun editDraftPrompt(value: String) { mutable.update { it.copy(draftPrompt = value, draftProof = null) } }
    fun generateDraft() {
        val current = client ?: return
        val state = mutable.value; val snapshot = state.snapshot ?: return
        if (!state.online || snapshot.inference?.configured != true || (state.draftReference != null && (state.draft == null || state.draft.status == "running"))) return
        val prompt = state.draftPrompt.trim()
        if (prompt.isEmpty() || prompt.codePointCount(0, prompt.length) > 512 || prompt.toByteArray().size > 2048) { mutable.update { it.copy(draftMessage = "请输入不超过 512 字的联动需求") }; return }
        val reference = DraftReference(snapshot.space)
        draftTask { old ->
            try { vault.save(state.origin + "#draft", Json.encodeToString(reference)) }
            catch (error: Exception) { if (error is CancellationException) throw error; mutable.update { it.copy(draftMessage = "无法保存本地生成记录，请稍后重试") }; return@draftTask }
            ensureCurrent(old)
            mutable.update { it.copy(draftReference = reference, draft = null, draftPrompt = prompt, draftProof = null) }
            try {
                val result = current.createDraft(reference, DraftInput(prompt)); ensureCurrent(old)
                mutable.update { it.copy(draft = result) }
            } catch (error: GatewayException) {
                ensureCurrent(old)
                if (error.definitiveRejection) {
                    runCatching { vault.save(state.origin + "#draft", null); ensureCurrent(old); mutable.update { it.copy(draftReference = null) } }
                }
                throw error
            }
        }
    }
    private suspend fun loadDraft() {
        val current = client ?: return; val state = mutable.value; val reference = state.draftReference ?: return
        if (!state.connected || state.draftBusy || reference.space != state.snapshot?.space) return
        val old = generation; mutable.update { it.copy(draftBusy = true) }
        try {
            val result = current.resolveDraft(reference); ensureCurrent(old)
            mutable.update { it.copy(draft = result, draftPrompt = if (it.draft == null) result.request.prompt else it.draftPrompt, draftMessage = "") }
        } catch (error: Exception) { if (old == generation) draftFailure(error) }
        finally { if (old == generation) mutable.update { it.copy(draftBusy = false) } }
    }
    fun recoverDraft() { viewModelScope.launch { loadDraft() } }
    fun newDraft() {
        if (mutable.value.draft?.status == "running") return
        val origin = mutable.value.origin
        draftTask { old -> vault.save(origin + "#draft", null); ensureCurrent(old); mutable.update { it.copy(draftReference = null, draft = null, draftProof = null, draftMessage = "") } }
    }
    fun simulateDraft() {
        val state = mutable.value; val draft = state.draft ?: return; val rule = draft.rule ?: return
        if (!state.online || draft.status != "completed" || state.draftPrompt != draft.request.prompt) return
        val event = state.snapshot?.eventSample(rule) ?: return
        draftTask { old ->
            mutable.update { it.copy(draftProof = null) }
            val result = simulate(rule, event); ensureCurrent(old)
            if (mutable.value.draft?.draftId != draft.draftId || mutable.value.draftPrompt != draft.request.prompt) return@draftTask
            if (result.matched && result.simulation && !result.executed && result.revision == draft.ruleRevision) mutable.update { it.copy(draftProof = result.revision, draftMessage = "预演通过，设备尚未执行") }
            else mutable.update { it.copy(draftMessage = "预演未通过，请重新生成草案") }
        }
    }
    fun deployDraft() {
        val current = client ?: return; val state = mutable.value; val snapshot = state.snapshot ?: return
        val draft = state.draft ?: return; val rule = draft.rule ?: return
        if (!state.online || state.draftPrompt != draft.request.prompt || state.draftProof == null || state.draftProof != draft.ruleRevision) return
        draftTask { old -> mutable.update { it.copy(draftProof = null) }; current.deploy(snapshot.space, rule); ensureCurrent(old); refresh(); mutable.update { it.copy(draftMessage = "自动化已启用") } }
    }
    private fun ensureCurrent(old: Int) { if (old != generation) throw CancellationException("session_changed") }
    private fun draftTask(action: suspend (Int) -> Unit) {
        if (!mutable.value.connected || mutable.value.busy || mutable.value.draftBusy) return
        val old = generation; mutable.update { it.copy(draftBusy = true, draftMessage = "") }
        viewModelScope.launch {
            try { action(old) }
            catch (error: Exception) { if (old == generation) draftFailure(error) }
            finally { if (old == generation) mutable.update { it.copy(draftBusy = false) } }
        }
    }
    private fun draftFailure(error: Exception) {
        if (error is CancellationException) throw error
        if (error is GatewayException && error.status == 401) report(error)
        else mutable.update { it.copy(draftMessage = if (error is GatewayException) error.displayMessage else "生成结果尚未确认，请查询生成结果") }
    }
    fun deploy(rule: Rule) = task { val current = client ?: return@task; val snapshot = mutable.value.snapshot ?: return@task; current.deploy(snapshot.space, rule); refresh(); mutable.update { it.copy(message = "自动化已启用") } }
    fun stop(deployment: Deployment) = task { val current = client ?: return@task; val snapshot = mutable.value.snapshot ?: return@task; current.stop(snapshot.space, deployment); refresh() }
    fun logout() = task {
        if (mutable.value.draftBusy) return@task
        client?.logout(); generation++; client = null
        mutable.update { HomeState(origin = it.origin) }
    }
    private fun task(action: suspend () -> Unit) {
        if (mutable.value.busy) return
        mutable.update { it.copy(busy = true, message = "") }
        viewModelScope.launch { try { action() } catch (error: Exception) { report(error) } finally { mutable.update { it.copy(busy = false) } } }
    }
    fun report(error: Exception) {
        if (error is CancellationException) throw error
        if (error is GatewayException) {
            if (error.status == 401) { generation++; mutable.update { HomeState(origin = it.origin, message = error.displayMessage) } }
            else mutable.update { it.copy(message = error.displayMessage) }
        } else mutable.update { it.copy(online = false, message = "无法连接家庭网关，请检查本地网络") }
    }
}
