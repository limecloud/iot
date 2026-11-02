package run.limeai.iot.device

import kotlinx.serialization.json.*

/** 报文与原结果的校验由在线消费和日志恢复共用，不重写历史Envelope。 */
internal object AgentCommandFormat {
    fun envelope(message: JsonObject, kind: String, identity: DeviceIdentity, revision: String = identity.profile.revision) {
        message.fields("v", "kind", "message_id", "device_id", "model_revision", "session_id", "body")
        checkDevice(message.integer("v") == 1L && message.text("kind") == kind && identifier.matches(message.text("message_id")))
        checkDevice(message.text("device_id") == identity.device && message.text("model_revision") == revision, "model_mismatch")
        checkDevice(identifier.matches(message.text("session_id")), "session_mismatch")
    }

    fun commandBody(body: JsonObject) {
        body.fields("command_id", "issued_at", "expires_at", "operation")
        checkDevice(identifier.matches(body.text("command_id")))
        DeviceTime.parse(body.text("issued_at")); DeviceTime.parse(body.text("expires_at"))
        val op = body.getValue("operation").obj(); op.fields("type", "path", "value")
        checkDevice(op.text("type") == "action.invoke" && op.text("path") == "apps.launch", "unsupported_capability")
        val input = op.getValue("value").obj(); input.fields("application_id")
        val app = input.text("application_id")
        checkDevice(app.length <= 255 && applicationId.matches(app), "invalid_application")
    }

    fun validateResult(value: JsonObject, command: JsonObject) {
        checkDevice(value.text("command_id") == command.text("command_id"))
        val status = value.text("status")
        val evidence = value.getValue("evidence").obj()
        if (status == "confirmed") {
            value.fields("command_id", "status", "evidence")
            evidence.fields("type", "path", "input_digest", "output", "completion", "observed_at")
            checkDevice(evidence.text("type") == "action_result" && evidence.text("path") == "apps.launch" && evidence.text("completion") == "submitted" && evidence["output"] == JsonObject(emptyMap()))
            checkDevice(evidence.text("input_digest") == DeviceDocument.digest(command.getValue("operation").obj().getValue("value")))
            val time = DeviceTime.parse(evidence.text("observed_at"))
            checkDevice(time >= DeviceTime.parse(command.text("issued_at")) - 2000)
        } else {
            value.fields("command_id", "status", "evidence", "error"); evidence.fields("type")
            checkDevice(evidence.text("type") == "device_result")
            checkDevice((status == "unknown" && value.text("error") == "execution_unknown") || (status == "failed" && value.text("error") in setOf("command_expired", "application_not_authorized", "authorization_changed")))
        }
    }

}

internal data class DeviceJournal(
    val entries: LinkedHashMap<String, JsonObject>,
    val highWatermark: Long,
    val migrationPending: Boolean,
) {
    companion object {
        fun read(identity: DeviceIdentity, bytes: ByteArray?): DeviceJournal {
            try {
                if (bytes == null) return DeviceJournal(linkedMapOf(), 0L, identity.profile == DeviceModelProfile.COMPOSED_REMOTE)
                val doc = DeviceDocument.parse(bytes, 1048576, 32768)
                val version = doc.integer("version")
                checkDevice(version in 1L..3L)
                if (version == 1L) doc.fields("version", "space_id", "device_id", "model_revision", "entries")
                else doc.fields("version", "space_id", "device_id", "model_revision", "entries", "high_watermark")
                checkDevice(doc.text("space_id") == identity.space && doc.text("device_id") == identity.device)
                val storedProfile = if (version == 3L) DeviceModelProfile.COMPOSED_REMOTE else DeviceModelProfile.APPLICATIONS
                checkDevice(doc.text("model_revision") == storedProfile.revision)
                checkDevice(storedProfile == identity.profile || storedProfile == DeviceModelProfile.APPLICATIONS && identity.profile == DeviceModelProfile.COMPOSED_REMOTE)
                var head = if (version == 1L) 0L else doc.integer("high_watermark").also { checkDevice(it in 0L..9007199254740991L) }
                val stored = doc.getValue("entries").obj(); checkDevice(stored.size <= 128)
                val entries = linkedMapOf<String, JsonObject>(); val messages = mutableSetOf<String>()
                for ((id, raw) in stored) {
                    val entry = raw.obj(); entry.fields("command", "result")
                    val command = entry.getValue("command").obj()
                    val revision = command.text("model_revision")
                    checkDevice(revision == storedProfile.revision || storedProfile == DeviceModelProfile.COMPOSED_REMOTE && revision == DeviceModelProfile.APPLICATIONS.revision)
                    AgentCommandFormat.envelope(command, "command", identity, revision)
                    val body = command.getValue("body").obj(); AgentCommandFormat.commandBody(body)
                    checkDevice(id == body.text("command_id") && messages.add(command.text("message_id")))
                    commandSequence(id)?.let { seq ->
                        checkDevice(command.text("message_id") == id)
                        if (version == 1L) head = maxOf(head, seq) else checkDevice(seq <= head)
                    }
                    if (entry["result"] != JsonNull) AgentCommandFormat.validateResult(entry.getValue("result").obj(), body)
                    entries[id] = entry
                }
                return DeviceJournal(entries, head, storedProfile != identity.profile)
            } catch (_: Exception) { throw DeviceFault("storage_corrupt") }
        }

        fun encode(identity: DeviceIdentity, entries: Map<String, JsonObject>, head: Long): JsonObject = obj(
            "version" to JsonPrimitive(if (identity.profile == DeviceModelProfile.COMPOSED_REMOTE) 3 else 2),
            "space_id" to text(identity.space), "device_id" to text(identity.device),
            "model_revision" to text(identity.profile.revision), "high_watermark" to JsonPrimitive(head), "entries" to JsonObject(entries),
        )
    }
}

/** 本机确认模型变更时，供平台在同一事务中保存材料与完整迁移日志。 */
object DeviceJournalMigration {
    fun prepare(identity: DeviceIdentity, bytes: ByteArray?): ByteArray {
        val journal = DeviceJournal.read(identity, bytes)
        val encoded = DeviceDocument.canonical(DeviceJournal.encode(identity, journal.entries, journal.highWatermark)).toByteArray(Charsets.UTF_8)
        checkDevice(encoded.size <= 1048576, "capacity_exceeded")
        return encoded
    }
}

internal fun commandSequence(id: String): Long? {
    val match = Regex("c1-([1-9][0-9]{0,15})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})").matchEntire(id) ?: return null
    return match.groupValues[1].toLongOrNull()?.takeIf { it <= 9007199254740991L }
}
