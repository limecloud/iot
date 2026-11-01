package run.limeai.iot.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.time.Instant
import java.util.UUID

@Serializable data class Page<T>(val items: List<T>, @SerialName("next_cursor") val nextCursor: String? = null)
@Serializable data class Session(val authenticated: Boolean, @SerialName("csrf_token") val csrfToken: String, @SerialName("expires_at") val expiresAt: String)
@Serializable data class Space(@SerialName("space_id") val spaceId: String)
@Serializable data class Observation(val value: JsonElement, @SerialName("observed_at") val observedAt: String, val quality: String, val source: String)
@Serializable data class Device(@SerialName("device_id") val deviceId: String, @SerialName("model_revision") val modelRevision: String, val ready: Boolean, @SerialName("last_seen") val lastSeen: String? = null, val reported: Map<String, Observation> = emptyMap())
@Serializable data class ValueSchema(val type: String, val minimum: Double? = null, val maximum: Double? = null, val properties: Map<String, ValueSchema> = emptyMap(), val required: List<String> = emptyList()) {
    fun sample(): JsonElement = when (type) {
        "boolean" -> JsonPrimitive(true)
        "integer" -> JsonPrimitive((minimum ?: 0.0).toLong())
        "number" -> JsonPrimitive(minimum ?: 0.0)
        "object" -> JsonObject(required.associateWith { properties[it]?.sample() ?: JsonNull })
        else -> JsonPrimitive("")
    }
}
@Serializable data class Property(val id: String, val schema: ValueSchema, val access: List<String>)
@Serializable data class ModelEvent(val id: String, val schema: ValueSchema)
@Serializable data class Service(val id: String, val properties: List<Property>, val events: List<ModelEvent>)
@Serializable data class Model(@SerialName("model_id") val modelId: String, val services: List<Service>)
@Serializable data class Inference(val configured: Boolean, val model: String? = null)
@Serializable data class Capabilities(val models: Map<String, Model>, val inference: Inference? = null)
@Serializable data class DraftReference(val space: String, val key: String = UUID.randomUUID().toString())
@Serializable data class DraftInput(val prompt: String, @SerialName("expires_at") val expiresAt: String = Instant.now().plusSeconds(120).toString())
@Serializable data class RuleDraft(@SerialName("draft_id") val draftId: String, val request: DraftInput, val status: String, val rule: Rule? = null, @SerialName("rule_revision") val ruleRevision: String? = null, val error: String? = null) {
    val statusText: String get() = mapOf("running" to "正在生成草案", "completed" to "草案已生成", "rejected" to "草案未通过", "unknown" to "生成结果未知", "expired" to "生成请求已过期")[status] ?: status
}
@Serializable data class Operation(val type: String = "property.set", val path: String, val value: JsonElement)
@Serializable data class CommandInput(@SerialName("device_id") val deviceId: String, @SerialName("model_revision") val modelRevision: String, @SerialName("expires_at") val expiresAt: String, val operation: Operation)
@Serializable data class CommandIntent(val key: String, val input: CommandInput) {
    companion object {
        fun create(device: Device, path: String, value: JsonElement, now: Instant = Instant.now()) = CommandIntent(UUID.randomUUID().toString(), CommandInput(device.deviceId, device.modelRevision, now.plusSeconds(5).toString(), Operation(path = path, value = value)))
    }
}
@Serializable data class Command(@SerialName("command_id") val commandId: String, val status: String, val request: CommandInput, @SerialName("run_id") val runId: String? = null, val evidence: JsonElement? = null, val error: String? = null) {
    val statusText: String get() = mapOf("accepted" to "已受理", "dispatched" to "已发送", "confirmed" to "已确认", "unknown" to "结果未知", "failed" to "执行失败", "expired" to "已过期", "rejected" to "已拒绝")[status] ?: status
}
@Serializable data class Trigger(val device: String, val event: String)
@Serializable data class SetValue(val path: String, val value: JsonElement)
@Serializable data class Action(val device: String, val set: SetValue)
@Serializable data class Rule(val version: Int = 1, val id: String, val trigger: Trigger, val conditions: List<JsonElement> = emptyList(), val actions: List<Action>, @SerialName("cooldown_ms") val cooldownMs: Int)
@Serializable data class Deployment(val revision: String, val rule: Rule, @SerialName("last_run") val lastRun: String? = null)
@Serializable data class Run(@SerialName("run_id") val runId: String, @SerialName("command_ids") val commandIds: List<String>, @SerialName("event_id") val eventId: String, val error: String? = null)
@Serializable data class Simulation(val revision: String, val matched: Boolean, val executed: Boolean, val simulation: Boolean)
data class Snapshot(val space: String, val devices: List<Device>, val models: Map<String, Model>, val commands: Page<Command>, val deployments: List<Deployment>, val runs: List<Run>, val inference: Inference? = null) {
    fun eventSample(rule: Rule): JsonElement? {
        val device = devices.firstOrNull { it.deviceId == rule.trigger.device } ?: return null
        return models[device.modelRevision]?.services?.firstNotNullOfOrNull { service -> service.events.firstOrNull { "${service.id}.${it.id}" == rule.trigger.event }?.schema?.sample() }
    }
    fun name(device: Device): String = when {
        models[device.modelRevision]?.services?.any { it.id == "light" } == true -> "环境灯"
        models[device.modelRevision]?.services?.any { it.id == "button" } == true -> "无线按钮"
        else -> device.deviceId
    }
}
