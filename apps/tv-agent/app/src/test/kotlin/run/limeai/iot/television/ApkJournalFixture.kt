package run.limeai.iot.television

import kotlinx.serialization.json.*
import run.limeai.iot.device.*

/** 合法原Envelope/结果夹具；只用于宿主存储测试，不执行应用或网络操作。 */
internal object ApkJournalFixture {
    fun bytes(identity: DeviceIdentity, version: Int = if (identity.profile == DeviceModelProfile.COMPOSED_REMOTE) 3 else 2): ByteArray {
        val revision = if (version == 3) DeviceModelProfile.COMPOSED_REMOTE.revision else DeviceModelProfile.APPLICATIONS.revision
        val entries = buildJsonObject {
            for ((index, status) in listOf("confirmed", "failed", "unknown", "unresolved").withIndex()) {
                val id = "c1-${index + 1}-00000000-0000-4000-8000-000000000001"
                val input = buildJsonObject { put("application_id", "com.example.player") }
                val body = buildJsonObject {
                    put("command_id", id); put("issued_at", "2026-11-02T00:00:00Z"); put("expires_at", "2026-11-02T00:00:20Z")
                    put("operation", buildJsonObject { put("type", "action.invoke"); put("path", "apps.launch"); put("value", input) })
                }
                val command = buildJsonObject {
                    put("v", 1); put("kind", "command"); put("message_id", id); put("device_id", identity.device)
                    put("model_revision", revision); put("session_id", "session-original"); put("body", body)
                }
                val result = if (status == "unresolved") JsonNull else buildJsonObject {
                    put("command_id", id); put("status", status)
                    put("evidence", if (status == "confirmed") buildJsonObject {
                        put("type", "action_result"); put("path", "apps.launch"); put("input_digest", DeviceDocument.digest(input))
                        put("output", JsonObject(emptyMap())); put("completion", "submitted"); put("observed_at", "2026-11-02T00:00:01Z")
                    } else buildJsonObject { put("type", "device_result") })
                    if (status != "confirmed") put("error", if (status == "unknown") "execution_unknown" else "application_not_authorized")
                }
                put(id, buildJsonObject { put("command", command); put("result", result) })
            }
        }
        return buildJsonObject {
            put("version", version); put("space_id", identity.space); put("device_id", identity.device); put("model_revision", revision)
            if (version != 1) put("high_watermark", 9)
            put("entries", entries)
        }.toString().toByteArray()
    }
}
