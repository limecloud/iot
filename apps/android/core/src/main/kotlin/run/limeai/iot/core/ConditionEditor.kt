package run.limeai.iot.core

import kotlinx.serialization.json.*
import java.math.BigDecimal

data class ConditionSource(val device: String, val path: String, val name: String, val schema: ValueSchema, val unit: String? = null) { val id get() = "$device/$path" }
data class ConditionForm(val kind: String = "compare", val source: String = "", val comparison: String = "eq", val value: String = "", val children: List<ConditionForm> = emptyList())
object ConditionEditor {
    fun count(forms: List<ConditionForm>): Int = forms.sumOf { 1 + count(it.children) }
    val operators = listOf("eq", "ne", "lt", "lte", "gt", "gte")
    fun label(op: String) = mapOf("eq" to "等于", "ne" to "不等于", "lt" to "小于", "lte" to "小于或等于", "gt" to "大于", "gte" to "大于或等于")[op] ?: op
    fun operators(schema: ValueSchema) = if (schema.type in listOf("integer", "number")) operators else listOf("eq", "ne")
    fun sources(snapshot: Snapshot) = snapshot.devices.flatMap { device -> snapshot.models[device.modelRevision]?.services.orEmpty().flatMap { service -> service.properties.filter { "read" in it.access && it.schema.type in listOf("integer", "number", "boolean", "string") }.map { ConditionSource(device.deviceId, "${service.id}.${it.id}", "${snapshot.name(device)} ${it.displayName}", it.schema, it.unit) } } }
    fun new(source: ConditionSource): ConditionForm {
        val value = source.schema.sample() as JsonPrimitive
        return ConditionForm(source = source.id, value = if (source.schema.type in listOf("integer", "number")) ThresholdEditor.display(value, source.unit ?: "") else value.content)
    }
    fun compile(forms: List<ConditionForm>, sources: List<ConditionSource>): List<JsonElement>? {
        var count = 0
        fun walk(nodes: List<ConditionForm>, depth: Int): List<JsonElement>? {
            if (nodes.size > 16 || nodes.isNotEmpty() && depth > 4) return null
            val result = mutableListOf<JsonElement>()
            for (node in nodes) {
                if (++count > 32) return null
                if (node.kind != "compare") {
                    if (node.kind !in listOf("all", "any") || node.children.isEmpty()) return null
                    val children = walk(node.children, depth + 1) ?: return null
                    result += buildJsonObject { put(node.kind, JsonArray(children)) }; continue
                }
                if (node.children.isNotEmpty()) return null
                val source = sources.firstOrNull { it.id == node.source } ?: return null
                if (node.comparison !in operators(source.schema)) return null
                val value: JsonPrimitive = when (source.schema.type) {
                    "integer", "number" -> ThresholdEditor.number(node.value, source.schema, source.unit ?: "") ?: return null
                    "boolean" -> if (node.value in listOf("true", "false")) JsonPrimitive(node.value == "true") else return null
                    "string" -> { val length = node.value.codePointCount(0, node.value.length); if (length < (source.schema.minLength ?: 0) || length > (source.schema.maxLength ?: 4096)) return null; JsonPrimitive(node.value) }
                    else -> return null
                }
                if (source.schema.enumValues.isNotEmpty() && source.schema.enumValues.none { RuleProof.equal(it, value) }) return null
                result += buildJsonObject { put("device", source.device); put("property", source.path); put("operator", node.comparison); put("value", value); source.unit?.let { put("unit", it) } }
            }
            return result
        }
        return walk(forms, 1)
    }
    fun restore(conditions: List<JsonElement>, sources: List<ConditionSource>): List<ConditionForm>? {
        fun walk(values: List<JsonElement>, depth: Int): List<ConditionForm>? {
            if (values.size > 16 || values.isNotEmpty() && depth > 4) return null
            val forms = mutableListOf<ConditionForm>()
            for (value in values) {
                val fields = value as? JsonObject ?: return null
                val group = if ("all" in fields) "all" else "any"
                if (fields[group] is JsonArray) forms += ConditionForm(kind = group, children = walk(fields.getValue(group).jsonArray, depth + 1) ?: return null)
                else {
                    val source = sources.firstOrNull { fields["device"] == JsonPrimitive(it.device) && fields["property"] == JsonPrimitive(it.path) } ?: return null
                    val op = (fields["operator"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
                    val raw = fields["value"] as? JsonPrimitive ?: return null
                    val text = if (source.schema.type in listOf("integer", "number") && !raw.isString && raw.doubleOrNull != null) ThresholdEditor.display(raw, source.unit ?: "") else raw.content
                    forms += ConditionForm(source = source.id, comparison = op, value = text)
                }
            }
            return forms
        }
        val forms = walk(conditions, 1) ?: return null
        val compiled = compile(forms, sources) ?: return null
        return forms.takeIf { RuleProof.equal(JsonArray(compiled), JsonArray(conditions)) }
    }
    fun cooldown(text: String): Int? {
        if (!Regex("^\\d+(?:\\.\\d{0,3})?$").matches(text)) return null
        val decimal = text.toBigDecimalOrNull() ?: return null
        return if (decimal >= BigDecimal.ZERO && decimal <= BigDecimal(86400)) decimal.multiply(BigDecimal(1000)).intValueExact() else null
    }
    fun cooldownText(milliseconds: Int): String = BigDecimal(milliseconds).divide(BigDecimal(1000)).stripTrailingZeros().toPlainString()
    fun rows(conditions: List<JsonElement>, results: List<JsonElement> = emptyList(), prefix: String = ""): List<String> = conditions.flatMapIndexed { index, condition ->
        val fields = condition as? JsonObject ?: return@flatMapIndexed emptyList()
        val node = results.getOrNull(index) as? JsonObject ?: JsonObject(emptyMap())
        val number = prefix + (index + 1); val matched = (node["matched"] as? JsonPrimitive)?.booleanOrNull
        val status = matched?.let { if (it) "，已满足" else "，未满足" } ?: ""
        val children = (fields["all"] ?: fields["any"]) as? JsonArray
        if (children != null) return@flatMapIndexed listOf(number + " " + (if ("all" in fields) "全部满足" else "任一满足") + status) + rows(children, node["children"] as? JsonArray ?: emptyList(), "$number-")
        val unit = (fields["unit"] as? JsonPrimitive)?.content ?: ""
        fun display(value: JsonElement?): String = if (value is JsonPrimitive && !value.isString && value.doubleOrNull != null) ThresholdEditor.display(value, unit) + (if (unit.isEmpty()) "" else " " + ThresholdEditor.label(unit)) else value.toString()
        var row = "$number ${(fields["device"] as? JsonPrimitive)?.content} ${(fields["property"] as? JsonPrimitive)?.content} ${label((fields["operator"] as? JsonPrimitive)?.content ?: "")} ${display(fields["value"])}$status"
        (node["observation"] as? JsonObject)?.let { row += "；观测值 ${display(it["value"])}，${(it["observed_at"] as? JsonPrimitive)?.content}" }
        (node["reason"] as? JsonPrimitive)?.content?.let { row += "；" + (mapOf("device_offline" to "设备离线", "stale_observation" to "观测已过期", "missing_observation" to "暂无观测", "future_observation" to "观测时间超前", "unconfirmed_observation" to "观测尚未确认", "model_authority_unavailable" to "设备能力未获授权", "invalid_condition" to "属性与条件不兼容", "device_not_found" to "未找到设备")[it] ?: it) }
        listOf(row)
    }
    fun evidenceRows(evaluation: JsonElement): List<String> { val fields = evaluation as? JsonObject ?: return emptyList(); return rows(fields["conditions"] as? JsonArray ?: emptyList(), fields["results"] as? JsonArray ?: emptyList()) }
}
