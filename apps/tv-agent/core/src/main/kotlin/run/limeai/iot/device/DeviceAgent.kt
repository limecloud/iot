package run.limeai.iot.device

import kotlinx.serialization.json.*
import java.util.UUID

/** 存储返回前必须耐久提交。失败可能已提交，调用方须停止并重新打开，不继续使用旧内存。 */
interface DeviceStorage { fun read(): ByteArray?; fun commit(bytes: ByteArray) }
interface ApplicationPort {
    /** 同时检查当前本机授权、实际安装和可启动入口；执行前再次调用。 */
    fun permitted(application: String): Boolean
    /** 返回仅代表输入已提交；开始调用后的异常一律保留 unknown。 */
    fun submit(application: String)
}
interface DeviceClock { fun elapsedMillis(): Long }
data class DeviceIdentity(val space: String, val device: String, val profile: DeviceModelProfile = DeviceModelProfile.APPLICATIONS) {
    init { checkDevice(identifier.matches(space) && identifier.matches(device), "invalid_identity") }
}
data class DevicePublication(val topic: String, val payload: ByteArray)

/** 单线程设备消费者；不拥有网关命令账本，回执只阻止本机重复副作用。 */
class DeviceAgent(
    private val identity: DeviceIdentity,
    private val storage: DeviceStorage,
    private val applications: ApplicationPort,
    private val clock: DeviceClock,
    private val currentConnection: () -> Boolean,
) {
    private val boot = UUID.randomUUID().toString()
    private var sequence = 0L
    private var snapshot = 0L
    private var challenge: String? = null
    private var session: String? = null
    private var anchorTime = 0L
    private var anchorElapsed = 0L
    private var lastElapsed = 0L
    private var entries = linkedMapOf<String, JsonObject>()
    private var highWatermark = 0L
    private var migrationPending = false
    private val digestPattern = Regex("sha256:[0-9a-f]{64}")
    var blocked: Boolean = false; private set
    val ready: Boolean get() = !blocked && session != null && currentConnection()
    private val base = "limeiot/v1/${identity.space}/${identity.device}"

    init {
        val restored = try { DeviceJournal.read(identity, storage.read()) } catch (_: Exception) { throw DeviceFault("storage_corrupt") }
        entries = restored.entries; highWatermark = restored.highWatermark
        migrationPending = restored.migrationPending
    }

    fun connected(): DevicePublication {
        checkDevice(!blocked, "storage_unavailable")
        if (migrationPending) persist(LinkedHashMap(entries), highWatermark)
        session = null; snapshot = 0
        challenge = UUID.randomUUID().toString()
        return publication("hello", obj("challenge" to text(challenge!!), "firmware" to text("tv-agent-0.3.0"), "hardware" to text("android-application"), "receipt_ledger" to JsonPrimitive(1), "execution_paths" to JsonArray(identity.profile.nativePaths.map(::text))))
    }

    fun disconnected() { session = null; challenge = null }

    fun receive(topic: String, bytes: ByteArray, retained: Boolean = false): List<DevicePublication> {
        checkDevice(!blocked, "storage_unavailable")
        checkDevice(!retained && currentConnection(), "session_mismatch")
        checkDevice(topic == "$base/down/welcome" || topic == "$base/down/command" || topic == "$base/down/receipt", "invalid_topic")
        val message = DeviceDocument.parse(bytes)
        val kind = topic.substringAfterLast('/')
        AgentCommandFormat.envelope(message, kind, identity)
        val body = message.getValue("body").obj()
        if (kind == "welcome") {
            checkDevice(challenge != null && session == null, "session_mismatch")
            body.fields("challenge", "time", "max_packet_bytes", "receipt_ledger", "command_sequence")
            checkDevice(body.text("challenge") == challenge && body.integer("max_packet_bytes") in 1024L..16384L && body.integer("receipt_ledger") == 1L, "invalid_welcome")
            val head = body.integer("command_sequence")
            checkDevice(head in highWatermark..9007199254740991L, "gateway_history_rollback")
            anchorTime = DeviceTime.parse(body.text("time")); anchorElapsed = clock.elapsedMillis(); lastElapsed = anchorElapsed
            checkDevice(anchorElapsed >= 0, "invalid_time")
            // 新会话之前的命令均不可再次执行；旧设备备份也从原网关账本恢复拒绝边界。
            if (head != highWatermark) persist(LinkedHashMap(entries), head)
            session = message.text("session_id"); challenge = null
            return listOf(heartbeat()!!)
        }
        checkDevice(ready && message.text("session_id") == session, "session_mismatch")
        if (kind == "receipt") {
            body.fields("command_id", "command_digest", "result_digest")
            val id = body.text("command_id")
            checkDevice(identifier.matches(id) && digestPattern.matches(body.text("command_digest")) && digestPattern.matches(body.text("result_digest")), "invalid_receipt")
            val entry = entries[id] ?: return emptyList()
            val result = entry["result"]?.takeUnless { it == JsonNull }?.obj()
            checkDevice(result != null && result.text("status") in setOf("confirmed", "failed")
                && DeviceDocument.digest(entry.getValue("command")) == body.text("command_digest")
                && DeviceDocument.digest(result) == body.text("result_digest"), "invalid_receipt")
            val next = LinkedHashMap(entries); next.remove(id)
            persist(next, highWatermark)
            return emptyList()
        }
        AgentCommandFormat.commandBody(body)
        val id = body.text("command_id")
        val existing = entries[id]
        if (existing != null) {
            checkDevice(existing["command"] == message, "duplicate_conflict")
            val result = existing["result"]?.takeUnless { it == JsonNull }?.obj() ?: result(body, "unknown", "execution_unknown")
            return listOf(publication("result", result))
        }
        checkDevice(entries.values.none { it.getValue("command").obj().text("message_id") == message.text("message_id") }, "duplicate_conflict")
        val commandSequence = commandSequence(id)
        checkDevice(commandSequence != null && message.text("message_id") == id, "invalid_command_sequence")
        checkDevice(commandSequence!! > highWatermark, "command_retired")
        checkDevice(entries.size < 128, "capacity_exceeded")
        val operation = body.getValue("operation").obj()
        val application = operation.getValue("value").obj().text("application_id")
        val now = now()
        val issued = DeviceTime.parse(body.text("issued_at")); val expires = DeviceTime.parse(body.text("expires_at"))
        val rejection = when {
            expires <= now || issued > now + 2000 || expires <= issued || expires - issued > 30000 -> "command_expired"
            !applications.permitted(application) -> "application_not_authorized"
            else -> null
        }
        if (rejection != null) {
            val result = result(body, "failed", rejection)
            put(id, message, result)
            return listOf(publication("result", result))
        }
        // 先保存尝试；进程中断或提交结果不明时绝不再次调用外部端口。
        put(id, message, JsonNull)
        val result = when {
            !currentConnection() || !applications.permitted(application) -> result(body, "failed", "authorization_changed")
            now() >= expires -> result(body, "failed", "command_expired")
            else -> try { applications.submit(application); result(body, "confirmed") }
                catch (_: Exception) { result(body, "unknown", "execution_unknown") }
        }
        put(id, message, result)
        return listOf(publication("result", result))
    }

    fun heartbeat(): DevicePublication? {
        if (!ready) return null
        now() // 单调时钟回退时停止本会话。
        checkDevice(snapshot < 9007199254740991L, "capacity_exceeded")
        return publication("state", obj("type" to text("snapshot"), "revision" to JsonPrimitive(++snapshot), "properties" to JsonArray(emptyList())))
    }

    /** 重连只核对原结果；绝不再次调用应用端口。每次最多一条，丢确认时继续有界查询。 */
    fun pendingReceipt(): DevicePublication? {
        if (!ready) return null
        val entry = entries.values.firstOrNull {
            it["result"]?.takeUnless { result -> result == JsonNull }?.obj()?.text("status") in setOf("confirmed", "failed")
        } ?: return null
        return publication("receipt", obj("command" to entry.getValue("command"), "result" to entry.getValue("result")))
    }

    private fun now(): Long {
        val elapsed = clock.elapsedMillis()
        if (elapsed < lastElapsed || elapsed < anchorElapsed) { disconnected(); throw DeviceFault("invalid_time") }
        lastElapsed = elapsed
        return anchorTime + elapsed - anchorElapsed
    }

    private fun result(command: JsonObject, status: String, error: String? = null): JsonObject {
        val evidence = if (status == "confirmed") obj(
            "type" to text("action_result"), "path" to text("apps.launch"),
            "input_digest" to text(DeviceDocument.digest(command.getValue("operation").obj().getValue("value"))),
            "output" to JsonObject(emptyMap()), "completion" to text("submitted"), "observed_at" to text(DeviceTime.format(now())),
        ) else obj("type" to text("device_result"))
        val fields = linkedMapOf("command_id" to text(command.text("command_id")), "status" to text(status), "evidence" to evidence)
        if (error != null) fields["error"] = text(error)
        return JsonObject(fields)
    }

    private fun put(id: String, command: JsonObject, result: JsonElement) {
        val next = LinkedHashMap(entries); next[id] = obj("command" to command, "result" to result)
        persist(next, maxOf(highWatermark, commandSequence(id) ?: 0L))
    }

    private fun persist(next: LinkedHashMap<String, JsonObject>, head: Long) {
        val doc = DeviceJournal.encode(identity, next, head)
        val bytes = DeviceDocument.canonical(doc).toByteArray(Charsets.UTF_8)
        checkDevice(bytes.size <= 1048576, "capacity_exceeded")
        try { storage.commit(bytes) } catch (_: Exception) { blocked = true; disconnected(); throw DeviceFault("storage_unavailable") }
        entries = next; highWatermark = head; migrationPending = false
    }

    private fun publication(kind: String, body: JsonObject): DevicePublication {
        checkDevice(sequence < 9007199254740991L, "capacity_exceeded")
        val fields = linkedMapOf("v" to JsonPrimitive(1), "kind" to text(kind), "message_id" to text(UUID.randomUUID().toString()), "device_id" to text(identity.device), "model_revision" to text(identity.profile.revision), "boot_id" to text(boot), "seq" to JsonPrimitive(++sequence), "body" to body)
        session?.let { fields["session_id"] = text(it) }
        return DevicePublication("$base/up/$kind", DeviceDocument.canonical(JsonObject(fields)).toByteArray(Charsets.UTF_8))
    }
}
