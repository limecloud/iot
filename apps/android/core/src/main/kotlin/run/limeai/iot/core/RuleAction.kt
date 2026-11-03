package run.limeai.iot.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.*

@Serializable data class InvokeValue(val path: String, val input: JsonElement)
@Serializable(with = ActionSerializer::class)
data class Action(val device: String, val set: SetValue? = null, val invoke: InvokeValue? = null) {
    init { require((set != null) != (invoke != null)) { "invalid_rule_action" } }
    val operation: Operation get() = set?.let { Operation(path = it.path, value = it.value) }
        ?: invoke!!.let { Operation(type = "action.invoke", path = it.path, value = it.input) }
}

// 不受客户端宽松读模型配置影响；规则动作必须精确选择一种操作且不输出 null 占位字段。
object ActionSerializer : KSerializer<Action> {
    override val descriptor = buildClassSerialDescriptor("LimeIoTRuleAction")
    override fun deserialize(decoder: Decoder): Action {
        val json = decoder as? JsonDecoder ?: throw SerializationException("json_required")
        val fields = json.decodeJsonElement() as? JsonObject ?: throw SerializationException("invalid_rule_action")
        val kind = when (fields.keys) {
            setOf("device", "set") -> "set"
            setOf("device", "invoke") -> "invoke"
            else -> throw SerializationException("invalid_rule_action")
        }
        val device = fields["device"] as? JsonPrimitive
        if (device == null || !device.isString) throw SerializationException("invalid_rule_action")
        val payload = fields[kind] as? JsonObject ?: throw SerializationException("invalid_rule_action")
        if (payload.keys != setOf("path", if (kind == "set") "value" else "input") || (payload["path"] as? JsonPrimitive)?.isString != true) throw SerializationException("invalid_rule_action")
        return if (kind == "set") Action(device.content, set = json.json.decodeFromJsonElement<SetValue>(payload))
            else Action(device.content, invoke = json.json.decodeFromJsonElement<InvokeValue>(payload))
    }
    override fun serialize(encoder: Encoder, value: Action) {
        val json = encoder as? JsonEncoder ?: throw SerializationException("json_required")
        json.encodeJsonElement(buildJsonObject {
            put("device", value.device)
            value.set?.let { put("set", json.json.encodeToJsonElement(it)) }
            value.invoke?.let { put("invoke", json.json.encodeToJsonElement(it)) }
        })
    }
}
