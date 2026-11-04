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
@Serializable data class Device(@SerialName("device_id") val deviceId: String, @SerialName("model_revision") val modelRevision: String, val ready: Boolean, @SerialName("last_seen") val lastSeen: String? = null, val reported: Map<String, Observation> = emptyMap(), @SerialName("observation_source") val observationSource: ObservationSource? = null)
@Serializable data class ObservationSource(@SerialName("adapter_id") val adapterId: String, val revision: String, val ready: Boolean)
@Serializable data class ValueSchema(val type: String, val minimum: Double? = null, val maximum: Double? = null, val properties: Map<String, ValueSchema> = emptyMap(), val required: List<String> = emptyList(), @SerialName("enum") val enumValues: List<JsonElement> = emptyList(), val minLength: Int? = null, val maxLength: Int? = null) {
    fun sample(): JsonElement = enumValues.firstOrNull() ?: when (type) {
        "boolean" -> JsonPrimitive(true)
        "integer" -> JsonPrimitive((minimum ?: 0.0).toLong())
        "number" -> JsonPrimitive(minimum ?: 0.0)
        "object" -> JsonObject(required.associateWith { properties[it]?.sample() ?: JsonNull })
        else -> JsonPrimitive("")
    }
}
@Serializable data class Property(val id: String, val schema: ValueSchema, val access: List<String>, @SerialName("semantic_id") val semanticId: String? = null, val unit: String? = null) {
    val displayName: String get() = when (semanticId) {
        "urn:limeiot:property:temperature:1" -> "温度"
        "urn:limeiot:property:relative-humidity:1" -> "相对湿度"
        else -> when (id) { "power" -> "电源"; "brightness" -> "亮度"; else -> id }
    }
    fun displayValue(value: JsonElement?): String {
        if (value == null) return "暂无状态"
        val number = (value as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull
        return if (number != null && unit in listOf("celsius_x100", "percent_x100")) {
            String.format(java.util.Locale.ROOT, "%.2f", number.toDouble()/100) + if (unit == "celsius_x100") " ℃" else " %RH"
        } else (value as? JsonPrimitive)?.content ?: value.toString()
    }
}
@Serializable data class ModelEvent(val id: String, val schema: ValueSchema)
@Serializable data class ModelAction(val id: String, val input: ValueSchema, val output: ValueSchema, val idempotent: Boolean, val risk: String, val completion: String)
@Serializable data class Service(val id: String, val properties: List<Property>, val events: List<ModelEvent>, val actions: List<ModelAction> = emptyList())
@Serializable data class Model(@SerialName("model_id") val modelId: String, val services: List<Service>)
@Serializable data class Inference(val configured: Boolean, val model: String? = null)
@Serializable data class Capabilities(val models: Map<String, Model>, val inference: Inference? = null)
@Serializable data class DraftReference(val space: String, val key: String = UUID.randomUUID().toString())
@Serializable data class DraftInput(val prompt: String, @SerialName("expires_at") val expiresAt: String = Instant.now().plusSeconds(120).toString())
@Serializable data class RuleDraft(@SerialName("draft_id") val draftId: String, val request: DraftInput, val status: String, val rule: Rule? = null, @SerialName("rule_revision") val ruleRevision: String? = null, val error: String? = null) {
    val statusText: String get() = mapOf("running" to "正在生成草案", "completed" to "草案已生成", "rejected" to "草案未通过", "unknown" to "生成结果未知", "expired" to "生成请求已过期")[status] ?: status
}
@Serializable data class Operation(val type: String = "property.set", val path: String, val value: JsonElement) {
    val summary: String get() {
        val input = value as? JsonObject
        if (type == "action.invoke" && path == "remote.press") (input?.get("key") as? JsonPrimitive)?.contentOrNull?.let { return "遥控：${keyLabels[it] ?: it}" }
        if (type == "action.invoke" && path == "apps.launch") (input?.get("application_id") as? JsonPrimitive)?.contentOrNull?.let { return "启动应用：$it" }
        return "${path}：$value"
    }
    companion object { val keyLabels = mapOf("up" to "向上", "down" to "向下", "left" to "向左", "right" to "向右", "select" to "确认", "back" to "返回", "home" to "主页", "menu" to "菜单", "play_pause" to "播放/暂停") }
}
@Serializable data class CommandInput(@SerialName("device_id") val deviceId: String, @SerialName("model_revision") val modelRevision: String, @SerialName("expires_at") val expiresAt: String, val operation: Operation)
@Serializable data class CommandIntent(val key: String, val input: CommandInput) {
    companion object {
        fun create(device: Device, path: String, value: JsonElement, now: Instant = Instant.now(), type: String = "property.set") = CommandIntent(UUID.randomUUID().toString(), CommandInput(device.deviceId, device.modelRevision, now.plusSeconds(5).toString(), Operation(type = type, path = path, value = value)))
    }
}
@Serializable data class Command(@SerialName("command_id") val commandId: String, val status: String, val request: CommandInput, @SerialName("run_id") val runId: String? = null, val evidence: JsonElement? = null, val error: String? = null) {
    val statusText: String get() = if (status == "confirmed" && request.operation.type == "action.invoke") actionStatus(evidence) else mapOf("accepted" to "已受理", "dispatched" to "已发送", "confirmed" to "已确认", "unknown" to "结果未知", "failed" to "执行失败", "expired" to "已过期", "rejected" to "已拒绝")[status] ?: status
    companion object {
        fun actionStatus(value: JsonElement?): String {
            val evidence = value as? JsonObject
            if (evidence?.get("type") != JsonPrimitive("action_result")) return "完成范围未知"
            return when (evidence["completion"]) { JsonPrimitive("submitted") -> "输入已提交"; JsonPrimitive("observed") -> "效果已观测"; else -> "完成范围未知" }
        }
    }
}
@Serializable data class SetValue(val path: String, val value: JsonElement)
@Serializable data class Rule(val version: Int = 1, val id: String, val trigger: Trigger, val conditions: List<JsonElement> = emptyList(), val actions: List<Action>, @SerialName("cooldown_ms") val cooldownMs: Int)
@Serializable data class Deployment(val revision: String, val rule: Rule, @SerialName("last_run") val lastRun: String? = null)
@Serializable data class Run(@SerialName("run_id") val runId: String, @SerialName("command_ids") val commandIds: List<String>, @SerialName("event_id") val eventId: String, val error: String? = null, @SerialName("condition_evaluation") val conditionEvaluation: JsonElement? = null)
@Serializable data class Simulation(val revision: String, val matched: Boolean, val executed: Boolean, val simulation: Boolean, @SerialName("trigger_matched") val triggerMatched: Boolean? = null, @SerialName("condition_evaluation") val conditionEvaluation: JsonElement? = null, @SerialName("proposed_actions") val proposedActions: List<Action>? = null) {
    val canDeploy get() = !executed && simulation && if (conditionEvaluation == null) matched else triggerMatched == true
}
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
