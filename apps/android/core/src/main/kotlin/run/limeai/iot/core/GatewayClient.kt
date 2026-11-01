package run.limeai.iot.core

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URI
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class GatewayException(val code: String, val status: Int = 0) : Exception(code) {
    val definitiveRejection: Boolean get() = status in 400..499 && status != 408 && code !in listOf("idempotency_conflict", "request_failed")
    val displayMessage: String get() = mapOf(
        "invalid_endpoint" to "请输入家庭网关的 HTTPS 地址", "unauthenticated" to "凭据无效或会话已过期", "forbidden" to "请求未获授权", "device_offline" to "设备已离线",
        "rate_limited" to "尝试次数过多，请一分钟后重试", "revision_conflict" to "规则已更新，请刷新后重试",
        "inference_not_configured" to "网关尚未配置本地模型", "inference_busy" to "已有草案正在生成，请稍后再试",
        "inference_unavailable" to "无法连接本地模型", "inference_rejected" to "本地模型拒绝了请求",
        "inference_unknown" to "生成结果未知，请查询原草案", "inference_timeout" to "模型响应超时，请查询原草案",
        "invalid_model_output" to "模型返回的草案未通过校验", "inference_output_incomplete" to "模型返回的草案不完整",
        "inference_output_limit" to "模型输出超出限制", "inference_response_too_large" to "模型响应超出限制",
        "inference_context_changed" to "设备能力已变化，请重新生成草案", "unsupported_intent" to "当前设备暂不支持这项联动",
        "unsupported_capability" to "草案引用了不支持的设备能力", "draft_expired" to "生成请求已过期", "draft_not_found" to "未找到原草案，请确认网关地址"
    )[code] ?: "请求未完成（$code）"
}
data class GatewayRequest(val url: String, val method: String, val headers: Map<String, String>, val body: String?)
data class GatewayResponse(val status: Int, val body: String, val cookie: String? = null)
fun interface GatewayTransport { suspend fun send(request: GatewayRequest): GatewayResponse }
interface SessionStore { suspend fun load(origin: String): String?; suspend fun save(origin: String, value: String?) }

// OkHttp 只存在于传输适配器，不将其类型暴露给界面或领域合同。
class OkHttpTransport : GatewayTransport {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).callTimeout(12, TimeUnit.SECONDS).cache(null).build()
    override suspend fun send(request: GatewayRequest): GatewayResponse = suspendCancellableCoroutine { continuation ->
        val builder = Request.Builder().url(request.url)
        request.headers.forEach { (name, value) -> builder.header(name, value) }
        builder.method(request.method, request.body?.toRequestBody("application/json".toMediaType()))
        val call = client.newCall(builder.build())
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { if (!continuation.isCancelled) continuation.resumeWithException(e) }
            override fun onResponse(call: Call, response: Response) { response.use {
                if (!continuation.isCancelled) continuation.resume(GatewayResponse(it.code, it.body?.string().orEmpty(), it.header("Set-Cookie")))
            } }
        })
    }
}
@Serializable private data class SavedSession(val session: Session, val cookie: String)
@Serializable private data class Failure(val error: Detail) { @Serializable data class Detail(val code: String) }
@Serializable private data class Login(val token: String)
@Serializable private data class Revision(val revision: String)
@Serializable private data class Validation(val valid: Boolean, val revision: String)
@Serializable private data class SimulatedEvent(@kotlinx.serialization.SerialName("device_id") val deviceId: String, val path: String, val historical: Boolean = false, val data: JsonElement)
@Serializable private data class SimulationInput(val rule: Rule, val event: SimulatedEvent)

class GatewayClient(val origin: String, private val transport: GatewayTransport = OkHttpTransport(), private val store: SessionStore? = null, allowLoopbackHTTP: Boolean = false) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val mutex = Mutex()
    private var saved: SavedSession? = null
    init {
        val url = runCatching { URI(origin) }.getOrNull()
        if (url == null || url.host.isNullOrEmpty() || url.rawUserInfo != null || !url.rawPath.isNullOrEmpty() || url.rawQuery != null || url.rawFragment != null || !(url.scheme == "https" || (allowLoopbackHTTP && url.scheme == "http" && url.host in listOf("127.0.0.1", "localhost", "[::1]")))) throw GatewayException("invalid_endpoint")
    }
    private fun segment(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    private fun base(space: String) = "/api/v1/spaces/${segment(space)}"
    private suspend inline fun <reified T> call(path: String, method: String = "GET", body: String? = null, key: String? = null, authenticated: Boolean = true): T = mutex.withLock {
        if (authenticated && saved == null) throw GatewayException("unauthenticated", 401)
        val headers = mutableMapOf("Origin" to origin, "Cache-Control" to "no-store")
        saved?.let { headers["Cookie"] = it.cookie; headers["X-CSRF-Token"] = it.session.csrfToken }
        key?.let { headers["Idempotency-Key"] = it }
        if (body != null) headers["Content-Type"] = "application/json"
        val response = transport.send(GatewayRequest(origin + path, method, headers, body))
        if (response.status !in 200..299) {
            val code = runCatching { json.decodeFromString<Failure>(response.body).error.code }.getOrDefault("request_failed")
            if (response.status == 401 && authenticated) { saved = null; store?.save(origin, null) }
            throw GatewayException(code, response.status)
        }
        if (path == "/api/v1/auth/session" && method == "POST") {
            val cookie = response.cookie?.substringBefore(';') ?: throw GatewayException("invalid_response")
            if (!cookie.startsWith(if (origin.startsWith("https:")) "__Host-limeiot_session=" else "limeiot_session=")) throw GatewayException("invalid_response")
            saved = SavedSession(json.decodeFromString(response.body), cookie)
            store?.save(origin, json.encodeToString(saved))
        }
        json.decodeFromString(response.body.ifEmpty { "{}" })
    }
    suspend fun login(token: String) { mutex.withLock { saved = null }; call<Session>("/api/v1/auth/session", "POST", json.encodeToString(Login(token)), authenticated = false) }
    suspend fun restore() {
        val data = store?.load(origin) ?: throw GatewayException("unauthenticated", 401)
        mutex.withLock { saved = json.decodeFromString(data) }
        call<Session>("/api/v1/auth/session")
    }
    suspend fun logout() { call<JsonObject>("/api/v1/auth/logout", "POST", "{}"); mutex.withLock { saved = null; store?.save(origin, null) } }
    suspend fun snapshot(): Snapshot {
        val space = call<Page<Space>>("/api/v1/spaces").items.firstOrNull()?.spaceId ?: throw GatewayException("space_missing")
        val path = base(space)
        val capabilities = call<Capabilities>("$path/capabilities")
        return Snapshot(space, call<Page<Device>>("$path/devices").items, capabilities.models, call("$path/commands"), call<Page<Deployment>>("$path/rule-deployments").items, call<Page<Run>>("$path/runs").items, capabilities.inference)
    }
    suspend fun create(space: String, intent: CommandIntent): Command = call(base(space) + "/commands", "POST", json.encodeToString(intent.input), intent.key)
    suspend fun resolve(space: String, key: String): Command = call(base(space) + "/commands/by-key/" + segment(key))
    suspend fun command(space: String, id: String): Command = call(base(space) + "/commands/" + segment(id))
    suspend fun createDraft(reference: DraftReference, input: DraftInput): RuleDraft = call(base(reference.space) + "/rule-drafts", "POST", json.encodeToString(input), reference.key)
    suspend fun resolveDraft(reference: DraftReference): RuleDraft = call(base(reference.space) + "/rule-drafts/by-key/" + segment(reference.key))
    suspend fun simulate(space: String, rule: Rule, eventData: JsonElement): Simulation {
        call<Validation>(base(space) + "/rules:validate", "POST", json.encodeToString(rule))
        return call(base(space) + "/rules:simulate", "POST", json.encodeToString(SimulationInput(rule, SimulatedEvent(rule.trigger.device, rule.trigger.event, data = eventData))))
    }
    suspend fun deploy(space: String, rule: Rule): Deployment = call(base(space) + "/rule-deployments", "POST", json.encodeToString(rule))
    suspend fun stop(space: String, deployment: Deployment) { call<JsonObject>(base(space) + "/rule-deployments/" + segment(deployment.rule.id) + "/stop", "POST", json.encodeToString(Revision(deployment.revision))) }
}
