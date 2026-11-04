package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import run.limeai.iot.core.*

data class AiCatalogState(val busy: Boolean = false, val online: Boolean = true, val catalog: AiCatalog? = null, val message: String = "")

// 目录仅在当前前台页面保留；取消代次阻止已离页的响应重新开放入口。
class AiCatalogController(private val load: suspend () -> AiCatalog, private val scope: CoroutineScope, private val authFailure: (Exception) -> Unit) {
    private val mutable = MutableStateFlow(AiCatalogState())
    val state = mutable.asStateFlow()
    private var active = true
    private var generation = 0
    private var work: Job? = null
    fun refresh() {
        if (!active || !mutable.value.online || mutable.value.busy) return
        val epoch = generation
        mutable.update { it.copy(busy = true, catalog = null, message = "") }
        work = scope.launch {
            try {
                val next = load(); currentCoroutineContext().ensureActive()
                if (active && epoch == generation && mutable.value.online) mutable.update { it.copy(catalog = next) }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (active && epoch == generation) {
                    mutable.update { it.copy(catalog = null, message = if (error is AiCatalogException || error is GatewayException && error.code == "invalid_response") "AI 服务目录未通过校验，请刷新重试" else "无法读取 AI 服务，请检查网关连接") }
                    if (error is GatewayException && error.status == 401) authFailure(error)
                }
            } finally { if (epoch == generation) { mutable.update { it.copy(busy = false) }; work = null } }
        }
    }
    fun pause() { generation++; work?.cancel(); work = null; mutable.update { it.copy(busy = false, catalog = null, message = "") } }
    fun setOnline(value: Boolean) { if (!value) pause(); mutable.update { it.copy(online = value) } }
    fun close() { pause(); active = false }
    suspend fun waitForIdle() { work?.join() }
}
