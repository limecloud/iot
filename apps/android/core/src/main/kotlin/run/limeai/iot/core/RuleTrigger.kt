package run.limeai.iot.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.*

@Serializable enum class ThresholdEdge { @kotlinx.serialization.SerialName("rising") Rising, @kotlinx.serialization.SerialName("falling") Falling }
@Serializable data class PropertyTrigger(val path: String, val unit: String, val edge: ThresholdEdge, val threshold: JsonElement, val hysteresis: JsonElement) {
    val summary: String get() {
        val name = when (path) { "environment.temperature" -> "温度"; "environment.humidity" -> "相对湿度"; else -> path }
        fun value(input: JsonElement): String {
            val number = (input as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull
            return if (number != null && unit in listOf("celsius_x100", "percent_x100"))
                String.format(java.util.Locale.ROOT, "%.2f", number / 100) + if (unit == "celsius_x100") " ℃" else " %RH"
            else "${(input as? JsonPrimitive)?.content ?: input} $unit"
        }
        return name + (if (edge == ThresholdEdge.Rising) "上升越过 " else "下降越过 ") + value(threshold) + "，滞回 " + value(hysteresis)
    }
}
@Serializable(with = TriggerSerializer::class)
data class Trigger(val device: String = "", val event: String? = null, val property: PropertyTrigger? = null, val schedule: ScheduleTrigger? = null) {
    init { require(listOf(event, property, schedule).count { it != null } == 1 && (schedule == null || device.isEmpty())) { "invalid_rule_trigger" } }
    val summary: String get() = schedule?.summary ?: property?.summary ?: if (event == "button.pressed") "按下时" else "发生 $event"
}
@Serializable data class ScheduleTrigger(val time: String, @kotlinx.serialization.SerialName("time_zone") val timeZone: String, val weekdays: List<Int>) {
    companion object {
        fun fromForm(time: String, timeZone: String, weekdays: List<Int>): ScheduleTrigger? = runCatching {
            java.time.ZoneId.of(timeZone)
            ScheduleTrigger(time, timeZone, weekdays.toList())
        }.getOrNull()
    }
    init { require(Regex("^(?:[01][0-9]|2[0-3]):[0-5][0-9]$").matches(time) && timeZone.isNotEmpty() && timeZone.toByteArray().size <= 128 && weekdays.isNotEmpty() && weekdays.size <= 7 && weekdays.distinct().size == weekdays.size && weekdays.all { it in 1..7 }) { "invalid_schedule" } }
    val summary: String get() = "$time，$timeZone，周${weekdays.joinToString("、") }"
}
// 触发类型精确互斥；宽松设备模型读取不能使混合触发或null占位变为合法规则。
object TriggerSerializer : KSerializer<Trigger> {
    override val descriptor = buildClassSerialDescriptor("LimeIoTRuleTrigger")
    override fun deserialize(decoder: Decoder): Trigger {
        val json = decoder as? JsonDecoder ?: throw SerializationException("json_required")
        val fields = json.decodeJsonElement() as? JsonObject ?: throw SerializationException("invalid_rule_trigger")
        if (fields.keys == setOf("schedule")) {
            val schedule = fields["schedule"] as? JsonObject ?: throw SerializationException("invalid_rule_trigger")
            if (schedule.keys != setOf("time", "time_zone", "weekdays")) throw SerializationException("invalid_rule_trigger")
            return Trigger(schedule = json.json.decodeFromJsonElement(schedule))
        }
        val kind = when (fields.keys) { setOf("device", "event") -> "event"; setOf("device", "property") -> "property"; else -> throw SerializationException("invalid_rule_trigger") }
        val device = fields["device"] as? JsonPrimitive
        if (device?.isString != true) throw SerializationException("invalid_rule_trigger")
        if (kind == "event") {
            val event = fields["event"] as? JsonPrimitive
            if (event?.isString != true) throw SerializationException("invalid_rule_trigger")
            return Trigger(device.content, event.content)
        }
        val property = fields["property"] as? JsonObject ?: throw SerializationException("invalid_rule_trigger")
        if (property.keys != setOf("path", "unit", "edge", "threshold", "hysteresis")) throw SerializationException("invalid_rule_trigger")
        return Trigger(device.content, property = json.json.decodeFromJsonElement(property))
    }
    override fun serialize(encoder: Encoder, value: Trigger) {
        val json = encoder as? JsonEncoder ?: throw SerializationException("json_required")
        if (value.schedule != null) { json.encodeJsonElement(buildJsonObject { put("schedule", json.json.encodeToJsonElement(value.schedule)) }); return }
        json.encodeJsonElement(buildJsonObject {
            put("device", value.device)
            value.event?.let { put("event", it) }
            value.property?.let { put("property", json.json.encodeToJsonElement(it)) }
        })
    }
}
