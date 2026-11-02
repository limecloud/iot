package run.limeai.iot.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

class ControlException(val code: String, val status: Int = 0) : Exception(code) {
    val displayMessage: String get() = mapOf(
        "invalid_endpoint" to "请输入控制面的精确 HTTPS 地址", "invalid_response" to "服务返回了无法识别的数据",
        "unauthenticated" to "会话已失效，请重新登录", "authorization_required" to "请先发起手机登录",
        "already_authenticated" to "请先退出当前账号", "native_authorization_expired" to "登录请求已过期，请取消后重新发起",
        "identity_unavailable" to "账号服务暂时不可用，请稍后重试", "rate_limited" to "请求过于频繁，请稍后重试",
        "gateway_offline" to "网关未连接，暂时无法远程操作", "identity_rejected" to "凭据无效或会话已失效",
        "not_found" to "未找到当前账号可访问的记录", "forbidden" to "当前账号没有此权限",
        "local_operation_capacity" to "本机操作记录已满，请清理已结束的记录",
        "operation_not_found" to "未找到本机保存的原操作", "operation_not_terminal" to "操作结果仍未确定，请先查询原操作"
    )[code] ?: "请求未完成（$code）"
}
@Serializable enum class NativeAuthorizationStatus {
    @SerialName("pending") PENDING, @SerialName("approved") APPROVED,
    @SerialName("denied") DENIED, @SerialName("cancelled") CANCELLED
}
@Serializable data class NativeLogin(
    @SerialName("authorization_id") val authorizationId: String,
    @SerialName("user_code") val userCode: String,
    @SerialName("verification_uri") val verificationUri: String,
    @SerialName("expires_at") val expiresAt: String,
    @SerialName("interval_seconds") val intervalSeconds: Int,
    val status: NativeAuthorizationStatus
) { override fun toString() = "NativeLogin(status=$status, secrets=redacted)" }
@Serializable data class ControlPrincipal(@SerialName("principal_id") val principalId: String, val name: String)
@Serializable data class ControlSession(val audience: String, val principal: ControlPrincipal, @SerialName("csrf_token") val csrfToken: String, @SerialName("expires_at") val expiresAt: String)
data class NativeLoginResult(val status: NativeAuthorizationStatus, val session: ControlSession? = null)
@Serializable data class ControlSpace(@SerialName("space_id") val spaceId: String, val name: String)
@Serializable data class ControlGateway(
    @SerialName("gateway_id") val gatewayId: String, @SerialName("space_id") val spaceId: String,
    @SerialName("local_space_id") val localSpaceId: String, @SerialName("principal_id") val principalId: String,
    val scopes: List<String>, val revision: String, val active: Boolean
)
@Serializable data class ControlDevicePage(val items: List<Device>, val next: String?, @SerialName("binding_revision") val bindingRevision: String)
@Serializable enum class ControlCommandStatus {
    @SerialName("unknown") UNKNOWN, @SerialName("accepted") ACCEPTED, @SerialName("dispatched") DISPATCHED,
    @SerialName("confirmed") CONFIRMED, @SerialName("failed") FAILED, @SerialName("expired") EXPIRED, @SerialName("rejected") REJECTED;
    val terminal: Boolean get() = this in listOf(CONFIRMED, FAILED, EXPIRED, REJECTED)
}
@Serializable data class ControlRemoteInput(
    @SerialName("request_key") val requestKey: String, @SerialName("gateway_id") val gatewayId: String,
    @SerialName("binding_revision") val bindingRevision: String, @SerialName("device_id") val deviceId: String,
    @SerialName("model_revision") val modelRevision: String, @SerialName("expires_at") val expiresAt: String, val operation: Operation
)
@Serializable data class ControlCommandReference(val origin: String, @SerialName("principal_id") val principalId: String, @SerialName("space_id") val spaceId: String, @SerialName("local_space_id") val localSpaceId: String, val request: ControlRemoteInput)
@Serializable data class ControlRemoteCommand(
    @SerialName("remote_id") val remoteId: String, @SerialName("space_id") val spaceId: String,
    @SerialName("principal_id") val principalId: String, @SerialName("local_space_id") val localSpaceId: String,
    @SerialName("request_digest") val requestDigest: String, val request: ControlRemoteInput,
    val status: ControlCommandStatus, @SerialName("local_result") val localResult: kotlinx.serialization.json.JsonElement? = null
)
@Serializable data class ControlCommandRecord(val reference: ControlCommandReference, val attempted: Boolean = false, val result: ControlRemoteCommand? = null, val rejection: String? = null) { val id: String get() = reference.request.requestKey }
