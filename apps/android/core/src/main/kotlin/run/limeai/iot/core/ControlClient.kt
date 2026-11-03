package run.limeai.iot.core

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import java.net.URI
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.Base64

// 原生证明和会话材料只在客户端库与安全存储间流转。
@Serializable private data class NativeProof(@SerialName("request_key") val requestKey: String, @SerialName("code_verifier") val codeVerifier: String)
@Serializable private data class NativePending(val proof: NativeProof, val platform: String, val login: NativeLogin? = null)
@Serializable private data class ControlMaterial(val version: Int, val origin: String, val audience: String, val session: String, @SerialName("principal_id") val principalId: String, @SerialName("expires_at") val expiresAt: String)
@Serializable private data class ControlState(val version: Int = 1, val origin: String, val pending: NativePending? = null, val material: ControlMaterial? = null, val operations: List<ControlCommandRecord> = emptyList())
@Serializable private data class NativeStart(@SerialName("request_key") val requestKey: String, @SerialName("code_challenge") val codeChallenge: String, val platform: String)
@Serializable private data class NativePoll(val status: NativeAuthorizationStatus, @SerialName("expires_at") val expiresAt: String, val material: ControlMaterial? = null)
@Serializable private data class NativeCancelled(val status: NativeAuthorizationStatus)
@Serializable private data class ControlFailure(val error: Detail) { @Serializable data class Detail(val code: String) }
@Serializable private data class ControlLogout(@SerialName("logged_out") val loggedOut: Boolean)
@Serializable private data class ControlSpaces(val spaces: List<ControlSpace>)
@Serializable private data class ControlGateways(val gateways: List<ControlGateway>)
@Serializable private data class ControlRelease(val revision: String, val model: Model)

class ControlClient(val origin: String, private val store: SessionStore, private val transport: GatewayTransport = OkHttpTransport(), allowLoopbackHTTP: Boolean = false) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val mutex = Mutex()
    private val storageKey = "limeiot.control:v1:$origin"
    private var state: ControlState? = null
    init {
        val url = runCatching { URI(origin) }.getOrNull()
        if (url == null || url.host.isNullOrEmpty() || url.rawUserInfo != null || !url.rawPath.isNullOrEmpty() || url.rawQuery != null || url.rawFragment != null || !(url.scheme == "https" || (allowLoopbackHTTP && url.scheme == "http" && url.host in listOf("127.0.0.1", "[::1]")))) throw ControlException("invalid_endpoint")
    }
    private fun matches(value: String, pattern: String) = value.matches(Regex(pattern))
    private fun hash(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    private fun random() = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    private fun challenge(verifier: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.UTF_8)))
    private fun date(value: String): Instant? = runCatching { Instant.parse(value) }.getOrNull()
    private fun validate(login: NativeLogin) {
        if (!matches(login.authorizationId, "na-[a-f0-9]{64}") || !matches(login.userCode, "[A-F0-9]{8}") || login.verificationUri != "$origin/console/?native=${login.authorizationId}" || login.intervalSeconds != 3 || date(login.expiresAt) == null) throw ControlException("invalid_response")
    }
    private fun validate(material: ControlMaterial, requireFuture: Boolean = true) {
        val expires = date(material.expiresAt)
        if (material.version != 1 || material.origin != origin || material.audience != "console" || !matches(material.session, "[a-f0-9]{64}") || !matches(material.principalId, "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}") || expires == null || (requireFuture && (expires <= Instant.now() || expires > Instant.now().plusSeconds(3630)))) throw ControlException("invalid_response")
    }
    private suspend fun load(): ControlState {
        state?.let { return it }
        val raw = store.load(storageKey) ?: return ControlState(origin = origin)
        val loaded = json.decodeFromString<ControlState>(raw)
        if (loaded.version != 1 || loaded.origin != origin) throw ControlException("invalid_response")
        loaded.pending?.let {
            if (!matches(it.proof.requestKey, "[a-f0-9]{64}") || !matches(it.proof.codeVerifier, "[A-Za-z0-9._~-]{43,128}") || it.platform !in listOf("ios", "android")) throw ControlException("invalid_response")
            it.login?.let(::validate)
        }
        loaded.material?.let { validate(it, false) }
        if (loaded.operations.size > 128 || loaded.operations.map { it.id }.distinct().size != loaded.operations.size || loaded.operations.any { it.reference.origin != origin || !matches(it.id, "[a-f0-9]{64}") }) throw ControlException("invalid_response")
        state = loaded; return loaded
    }
    private suspend fun persist(next: ControlState) {
        currentCoroutineContext().ensureActive()
        store.save(storageKey, json.encodeToString(next)); state = next
    }
    private suspend inline fun <reified T> http(path: String, input: String? = null, material: ControlMaterial? = null): T {
        val headers = mutableMapOf("Cache-Control" to "no-store")
        if (input != null) headers["Content-Type"] = "application/json"
        material?.let {
            headers["Origin"] = origin
            headers["Cookie"] = (if (origin.startsWith("https:")) "__Host-limeiot_console=" else "limeiot_console=") + it.session
            headers["X-CSRF-Token"] = hash("limeiot-csrf:console:" + it.session)
        }
        currentCoroutineContext().ensureActive()
        val response = transport.send(GatewayRequest(origin + path, if (input == null) "GET" else "POST", headers, input))
        currentCoroutineContext().ensureActive()
        if (response.body.toByteArray(Charsets.UTF_8).size > 262144) throw ControlException("invalid_response")
        if (response.status != 200) {
            val code = runCatching { json.decodeFromString<ControlFailure>(response.body).error.code }.getOrDefault("invalid_response")
            if (response.status == 401 && material != null) { persist(load().copy(material = null)); throw ControlException("unauthenticated", 401) }
            throw ControlException(code, response.status)
        }
        return try { json.decodeFromString(response.body) } catch (_: kotlinx.serialization.SerializationException) { throw ControlException("invalid_response") }
    }
    private suspend fun current(material: ControlMaterial): ControlSession {
        validate(material, false)
        val session = http<ControlSession>("/api/console/v1/auth/session", material = material)
        val expires = date(session.expiresAt)
        val original = date(material.expiresAt)
        if (session.audience != "console" || session.principal.principalId != material.principalId || session.csrfToken != hash("limeiot-csrf:console:" + material.session) || expires == null || expires <= Instant.now() || original == null || kotlin.math.abs(java.time.Duration.between(original, expires).toMillis()) > 1000) throw ControlException("invalid_response")
        return session
    }
    suspend fun beginAuthorization(platform: String = "android"): NativeLogin = mutex.withLock {
        var next = load()
        if (next.material != null) throw ControlException("already_authenticated")
        if (platform !in listOf("ios", "android")) throw ControlException("invalid_response")
        if (next.pending == null) { next = next.copy(pending = NativePending(NativeProof(random(), random()), platform)); persist(next) }
        val pending = requireNotNull(next.pending)
        if (pending.platform != platform) throw ControlException("invalid_response")
        val login = http<NativeLogin>("/api/native/v1/authorizations", json.encodeToString(NativeStart(pending.proof.requestKey, challenge(pending.proof.codeVerifier), platform)))
        validate(login)
        pending.login?.let { if (it.authorizationId != login.authorizationId || it.userCode != login.userCode || it.expiresAt != login.expiresAt) throw ControlException("invalid_response") }
        persist(next.copy(pending = pending.copy(login = login))); login
    }
    suspend fun pollAuthorization(): NativeLoginResult = mutex.withLock {
        val next = load(); val pending = next.pending ?: throw ControlException("authorization_required")
        val value = http<NativePoll>("/api/native/v1/authorizations/poll", json.encodeToString(pending.proof))
        val expiry = date(value.expiresAt)
        if (expiry == null || expiry <= Instant.now() || (pending.login != null && pending.login.expiresAt != value.expiresAt)) throw ControlException("invalid_response")
        if (value.status != NativeAuthorizationStatus.APPROVED) {
            if (value.material != null) throw ControlException("invalid_response")
            return@withLock NativeLoginResult(value.status)
        }
        val material = value.material ?: throw ControlException("invalid_response"); validate(material)
        val session = current(material); persist(next.copy(material = material))
        NativeLoginResult(NativeAuthorizationStatus.APPROVED, session)
    }
    suspend fun cancelAuthorization() = mutex.withLock {
        val next = load(); val pending = next.pending ?: throw ControlException("authorization_required")
        val result = http<NativeCancelled>("/api/native/v1/authorizations/cancel", json.encodeToString(pending.proof))
        if (result.status != NativeAuthorizationStatus.CANCELLED) throw ControlException("invalid_response")
        persist(next.copy(pending = null, material = null))
    }
    suspend fun hasPendingAuthorization(): Boolean = mutex.withLock { load().pending != null }
    suspend fun restoreSession(): ControlSession = mutex.withLock { current(load().material ?: throw ControlException("unauthenticated", 401)) }
    suspend fun logout() = mutex.withLock {
        val next = load(); val material = next.material ?: throw ControlException("unauthenticated", 401)
        val result = http<ControlLogout>("/api/console/v1/auth/logout", "{}", material)
        if (!result.loggedOut) throw ControlException("invalid_response")
        persist(next.copy(pending = null, material = null))
    }
    private suspend inline fun <reified T> authenticated(path: String): T {
        val material = load().material ?: throw ControlException("unauthenticated", 401)
        current(material); return http(path, material = material)
    }
    private fun segment(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    suspend fun spaces(): List<ControlSpace> = mutex.withLock { authenticated<ControlSpaces>("/api/console/v1/spaces").spaces }
    suspend fun gateways(space: String): List<ControlGateway> = mutex.withLock { authenticated<ControlGateways>("/api/console/v1/spaces/${segment(space)}/gateways").gateways }
    suspend fun devices(space: String, after: String? = null): ControlDevicePage = mutex.withLock { authenticated("/api/console/v1/spaces/${segment(space)}/devices" + (after?.let { "?after=${segment(it)}" } ?: "")) }
    suspend fun model(space: String, revision: String): Model = mutex.withLock {
        val release = authenticated<ControlRelease>("/api/console/v1/spaces/${segment(space)}/model-releases/${segment(revision)}")
        if (release.revision != revision) throw ControlException("invalid_response"); release.model
    }
    suspend fun prepareCommand(space: String, gateway: ControlGateway, device: Device, path: String, value: JsonElement, type: String = "property.set"): ControlCommandRecord = mutex.withLock {
        val next = load(); val material = next.material ?: throw ControlException("unauthenticated", 401)
        val session = current(material)
        if (gateway.spaceId != space || gateway.principalId != session.principal.principalId || !gateway.active || "commands.write" !in gateway.scopes) throw ControlException("forbidden", 403)
        if (!device.ready) throw ControlException("device_offline", 409)
        if (type !in listOf("property.set", "action.invoke") || !matches(path, "[a-z][a-z0-9_-]{0,63}\\.[a-z][a-z0-9_-]{0,63}")) throw ControlException("invalid_response")
        if (next.operations.size >= 128) throw ControlException("local_operation_capacity", 429)
        val input = ControlRemoteInput(random(), gateway.gatewayId, gateway.revision, device.deviceId, device.modelRevision,
            Instant.now().plusSeconds(20).truncatedTo(java.time.temporal.ChronoUnit.SECONDS).toString(), Operation(type = type, path = path, value = value))
        val record = ControlCommandRecord(ControlCommandReference(origin, session.principal.principalId, space, gateway.localSpaceId, input))
        persist(next.copy(operations = next.operations + record)); record
    }
    private suspend fun commandContext(key: String): Pair<ControlMaterial, ControlCommandRecord> {
        val next = load(); val material = next.material ?: throw ControlException("unauthenticated", 401)
        val session = current(material)
        val record = next.operations.firstOrNull { it.id == key && it.reference.principalId == session.principal.principalId && it.reference.origin == origin } ?: throw ControlException("operation_not_found", 404)
        return material to record
    }
    private suspend fun saveRecord(record: ControlCommandRecord) {
        val next = load()
        if (next.operations.none { it.id == record.id && it.reference == record.reference }) throw ControlException("operation_not_found", 404)
        persist(next.copy(operations = next.operations.map { if (it.id == record.id) record else it }))
    }
    private fun validate(result: ControlRemoteCommand, original: ControlCommandRecord) {
        val ref = original.reference; val input = ref.request
        if (result.spaceId != ref.spaceId || result.principalId != ref.principalId || result.localSpaceId != ref.localSpaceId || result.request != input || !matches(result.remoteId, "remote-[a-f0-9]{64}") || !matches(result.requestDigest, "[a-f0-9]{64}")) throw ControlException("invalid_response")
        original.result?.let { if (it.remoteId != result.remoteId || it.requestDigest != result.requestDigest || (it.status.terminal && result.status != it.status)) throw ControlException("invalid_response") }
        if (result.status == ControlCommandStatus.CONFIRMED) {
            val receipt = result.localResult as? JsonObject ?: throw ControlException("invalid_response")
            val request = receipt["request"] as? JsonObject ?: throw ControlException("invalid_response")
            val evidence = receipt["evidence"] as? JsonObject ?: throw ControlException("invalid_response")
            val commandId = (receipt["command_id"] as? JsonPrimitive)?.contentOrNull
            val digest = (receipt["request_digest"] as? JsonPrimitive)?.contentOrNull
            if (commandId == null || !matches(commandId, "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}") || digest == null || !matches(digest, "sha256:[a-f0-9]{64}")) throw ControlException("invalid_response")
            if (receipt["status"] != JsonPrimitive("confirmed") || request["space_id"] != JsonPrimitive(ref.localSpaceId) || request["idempotency_key"] != JsonPrimitive(result.remoteId) || request["device_id"] != JsonPrimitive(input.deviceId) || request["model_revision"] != JsonPrimitive(input.modelRevision) || request["expires_at"] != JsonPrimitive(input.expiresAt) || request["operation"] != json.encodeToJsonElement(input.operation) || receipt["error"] != JsonNull) throw ControlException("invalid_response")
            when (input.operation.type) {
                "property.set" -> if (evidence["type"] != JsonPrimitive("device_result") || (evidence["reported"] as? JsonObject)?.get(input.operation.path) != input.operation.value) throw ControlException("invalid_response")
                "action.invoke" -> {
                    // 规范化摘要由Go/Rust验证；手机绑定原完整输入并核对证据外壳。
                    val inputDigest = (evidence["input_digest"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                    val observed = (evidence["observed_at"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { runCatching { Instant.parse(it) }.getOrNull() }
                    val expires = runCatching { Instant.parse(input.expiresAt) }.getOrNull()
                    if (evidence.keys != setOf("type", "path", "input_digest", "output", "completion", "observed_at") || evidence["type"] != JsonPrimitive("action_result") || evidence["path"] != JsonPrimitive(input.operation.path) || inputDigest == null || !matches(inputDigest, "sha256:[a-f0-9]{64}") || evidence["output"] == null || evidence["output"] == JsonNull || evidence["completion"] !in listOf(JsonPrimitive("submitted"), JsonPrimitive("observed")) || observed == null || expires == null || observed < expires.minusSeconds(32) || observed > Instant.now().plusSeconds(2)) throw ControlException("invalid_response")
                }
                else -> throw ControlException("invalid_response")
            }
        }
    }
    private suspend fun readCommand(record: ControlCommandRecord, material: ControlMaterial, reconcile: Boolean = false): ControlCommandRecord {
        val base = "/api/console/v1/spaces/${segment(record.reference.spaceId)}/remote-commands"
        var result = http<ControlRemoteCommand>("$base/by-key/${record.id}", material = material)
        validate(result, record)
        if (reconcile && !result.status.terminal) {
            val frozen = record.copy(result = result)
            result = http("$base/${segment(result.remoteId)}/reconcile", "{}", material); validate(result, frozen)
        }
        val updated = record.copy(attempted = true, result = result); saveRecord(updated); return updated
    }
    suspend fun submitCommand(key: String): ControlCommandRecord = mutex.withLock {
        val (material, original) = commandContext(key)
        if (original.rejection != null) return@withLock original
        // 发出过的原键只查询；即使404，也不补发create。
        if (original.attempted) return@withLock readCommand(original, material)
        var record = original.copy(attempted = true); saveRecord(record)
        try {
            val result = http<ControlRemoteCommand>("/api/console/v1/spaces/${segment(record.reference.spaceId)}/remote-commands", json.encodeToString(record.reference.request), material)
            validate(result, record); record = record.copy(result = result); saveRecord(record); record
        } catch (error: ControlException) {
            val rejection = when {
                error.code == "unauthenticated" -> "authentication_required"
                error.status in 400..499 && error.status !in listOf(408, 409) -> error.code
                else -> null
            }
            if (rejection != null) saveRecord(record.copy(rejection = rejection))
            throw error
        }
    }
    suspend fun resolveCommand(key: String, reconcile: Boolean = false): ControlCommandRecord = mutex.withLock {
        val (material, record) = commandContext(key)
        if (record.rejection != null) record else readCommand(record, material, reconcile)
    }
    suspend fun commandRecords(space: String): List<ControlCommandRecord> = mutex.withLock {
        val material = load().material ?: throw ControlException("unauthenticated", 401)
        val session = current(material)
        load().operations.filter { it.reference.principalId == session.principal.principalId && it.reference.spaceId == space }
    }
    suspend fun forgetCommand(key: String) = mutex.withLock {
        val (_, record) = commandContext(key)
        if (!record.canForget) throw ControlException("operation_not_terminal", 409)
        val next = load(); persist(next.copy(operations = next.operations.filterNot { it.id == key }))
    }
}
