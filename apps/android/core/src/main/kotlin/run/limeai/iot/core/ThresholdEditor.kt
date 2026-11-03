package run.limeai.iot.core

import kotlinx.serialization.json.*
import java.math.BigDecimal
import java.time.Instant
import kotlin.math.abs
import kotlin.math.max

object ThresholdEditor {
    fun scale(unit: String): Double = if (unit in listOf("celsius_x100", "percent_x100")) 100.0 else 1.0
    fun label(unit: String): String = when (unit) { "celsius_x100" -> "℃"; "percent_x100" -> "%RH"; else -> unit }
    fun display(value: JsonElement, unit: String): String = ((value as JsonPrimitive).double / scale(unit)).toString()
    fun number(text: String, schema: ValueSchema, unit: String = ""): JsonPrimitive? {
        val trimmed = text.trim()
        if (!Regex("^-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)$").matches(trimmed)) return null
        if (scale(unit) == 100.0 && trimmed.substringAfter('.', "").length > 2) return null
        val decimal = runCatching { BigDecimal(trimmed).multiply(BigDecimal.valueOf(scale(unit).toLong())) }.getOrNull() ?: return null
        val value = decimal.toDouble()
        if (!value.isFinite() || abs(value) > 9_007_199_254_740_991.0 || schema.minimum?.let { value < it } == true || schema.maximum?.let { value > it } == true) return null
        return if (schema.type == "integer") {
            if (decimal.stripTrailingZeros().scale() > 0) null else JsonPrimitive(decimal.toLong())
        } else JsonPrimitive(value)
    }
    fun property(path: String, unit: String, schema: ValueSchema, edge: ThresholdEdge, threshold: String, hysteresis: String): PropertyTrigger? {
        val t = number(threshold, schema, unit) ?: return null
        val delta = number(hysteresis, ValueSchema(schema.type, minimum = 0.0), unit) ?: return null
        val boundary = if (edge == ThresholdEdge.Rising) t.double - delta.double else t.double + delta.double
        if (!boundary.isFinite() || schema.minimum?.let { boundary < it } == true || schema.maximum?.let { boundary > it } == true) return null
        return PropertyTrigger(path, unit, edge, t, delta)
    }
    fun samples(property: PropertyTrigger, schema: ValueSchema, now: Instant = Instant.now()): JsonObject? {
        val threshold = (property.threshold as? JsonPrimitive)?.doubleOrNull ?: return null
        val delta = (property.hysteresis as? JsonPrimitive)?.doubleOrNull ?: return null
        val rising = property.edge == ThresholdEdge.Rising
        val bound = if (rising) schema.maximum else schema.minimum
        val step = if (schema.type == "integer") 1.0 else bound?.let { abs(it - threshold) / 2 } ?: max(1.0, abs(threshold) * 0.01)
        val current = if (rising) threshold + step else threshold - step
        if (!current.isFinite() || current == threshold || schema.minimum?.let { current < it } == true || schema.maximum?.let { current > it } == true) return null
        fun sample(value: Double, at: Instant) = buildJsonObject {
            put("value", if (schema.type == "integer") JsonPrimitive(value.toLong()) else JsonPrimitive(value))
            put("observed_at", at.toString()); put("quality", "confirmed"); put("source", "simulation.ui")
        }
        return buildJsonObject {
            put("previous", sample(if (rising) threshold - delta else threshold + delta, now.minusMillis(1)))
            put("current", sample(current, now))
        }
    }
}
