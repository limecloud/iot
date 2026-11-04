package run.limeai.iot.core

import kotlinx.serialization.json.*
import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import java.security.MessageDigest

class CompositionException(val code: String) : Exception(code) {
    val userMessage: String get() = mapOf("invalid_composition" to "组合包格式不正确", "invalid_composition_bindings" to "请为每个模块选择不同的兼容设备", "composition_model_mismatch" to "设备能力已变化，请重新选择并预演", "composition_record_unavailable" to "无法核对本地提交记录，已暂停新提交", "composition_busy" to "组合操作正在进行，请稍后查询", "composition_preview_required" to "请重新预演组合", "composition_pending" to "原提交结果待核实", "composition_not_found" to "未找到本地组合记录")[code] ?: "组合操作未完成"
}

// 组合包允许有限小数；旧媒体/OTA的安全整数解析保持默认限制。
internal object CompositionJSON {
    fun require(value: Boolean, code: String = "invalid_composition") { if (!value) throw CompositionException(code) }
    fun match(value: JsonElement?, regex: String) { require(MediaJSON.str(value).matches(Regex(regex))) }
    fun parse(text: String, bytes: Int, depth: Int, nodes: Int) = IntegerJSON.parse(text, bytes, depth, nodes, allowFractionalNumbers = true)
    private fun number(value: Double): String {
        if (value == 0.0) return "0"
        val exact = BigDecimal(value)
        val magnitude = exact.abs()
        var shortest: BigDecimal? = null
        // 选择能往返同一IEEE754值的最短十进制，平局采用偶数尾位。
        for (precision in 1..17) {
            val rounded = exact.round(MathContext(precision, RoundingMode.HALF_EVEN))
            val step = BigDecimal.ONE.scaleByPowerOfTen(magnitude.precision() - magnitude.scale() - precision)
            val candidates = listOf(rounded, rounded.add(step), rounded.subtract(step)).filter { it.toDouble() == value }
            if (candidates.isNotEmpty()) {
                shortest = candidates.minWith(compareBy<BigDecimal> { it.subtract(exact).abs() }.thenBy { it.stripTrailingZeros().unscaledValue().abs().testBit(0) }).stripTrailingZeros()
                break
            }
        }
        val n = shortest ?: throw CompositionException("invalid_composition")
        val exponent = n.precision() - n.scale() - 1
        if (exponent in -6..20) return n.toPlainString()
        val digits = n.unscaledValue().abs().toString()
        return (if (n.signum() < 0) "-" else "") + digits.first() + (if (digits.length > 1) "." + digits.drop(1) else "") + "e" + (if (exponent >= 0) "+" else "") + exponent
    }
    fun canonical(value: JsonElement): String = when (value) {
        is JsonObject -> value.keys.sorted().joinToString(",", "{", "}") { JsonPrimitive(it).toString() + ":" + canonical(value.getValue(it)) }
        is JsonArray -> value.joinToString(",", "[", "]") { canonical(it) }
        is JsonPrimitive -> if (value.isString || value == JsonNull || value.booleanOrNull != null) value.toString() else value.longOrNull?.toString() ?: number(value.double)
    }
    fun digest(value: JsonElement) = "sha256:" + MessageDigest.getInstance("SHA-256").digest(canonical(value).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
}

class CompositionPackage private constructor(val document: JsonObject) {
    val name get() = MediaJSON.text(document, "name")
    val roles get() = document.getValue("modules").jsonObject.keys.sorted()
    fun modelRevision(role: String) = document.getValue("modules").jsonObject.getValue(role).jsonObject.getValue("model_revision").jsonPrimitive.content
    companion object {
        fun parse(text: String): CompositionPackage = try {
            val v = CompositionJSON.parse(text, 32768, 8, 2048)
            MediaJSON.fields(v, "schema_version,package_id,version,name,modules,rule,sample_event_data")
            CompositionJSON.require(v["schema_version"] == JsonPrimitive(1))
            CompositionJSON.match(v["package_id"], "[a-z][a-z0-9-]{0,63}")
            CompositionJSON.match(v["version"], "(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})")
            val name = MediaJSON.text(v, "name"); CompositionJSON.require(name.codePointCount(0, name.length) in 1..80)
            val modules = v["modules"] as? JsonObject ?: throw CompositionException("invalid_composition")
            CompositionJSON.require(modules.size in 1..8)
            modules.forEach { (role, value) -> CompositionJSON.match(JsonPrimitive(role), "[a-z][a-z0-9_]{0,31}"); val m = value.jsonObject; MediaJSON.fields(m, "model_revision"); MediaJSON.hash(m["model_revision"]) }
            val r = v.getValue("rule").jsonObject; MediaJSON.fields(r, "version,id,trigger,conditions,actions,cooldown_ms")
            CompositionJSON.require(r["version"] == JsonPrimitive(1) && r["conditions"] == JsonArray(emptyList()))
            val id = MediaJSON.text(r, "id"); CompositionJSON.require(id.codePointCount(0, id.length) in 1..128)
            MediaJSON.integer(r["cooldown_ms"], 0, 86400000)
            val trigger = r.getValue("trigger").jsonObject; MediaJSON.fields(trigger, "device,event"); MediaJSON.text(trigger, "event")
            val source = MediaJSON.text(trigger, "device"); CompositionJSON.require(source.codePointCount(0, source.length) in 1..128)
            val actions = r["actions"] as? JsonArray ?: throw CompositionException("invalid_composition"); CompositionJSON.require(actions.size in 1..16)
            val used = mutableSetOf(source)
            actions.forEach { value ->
                val a = value.jsonObject; MediaJSON.fields(a, "device,set"); val device = MediaJSON.text(a, "device")
                CompositionJSON.require(device.codePointCount(0, device.length) in 1..128); used.add(device)
                val set = a.getValue("set").jsonObject; MediaJSON.fields(set, "path,value"); MediaJSON.text(set, "path")
            }
            CompositionJSON.require(used == modules.keys, "composition_role_mismatch"); CompositionJSON.require(v["sample_event_data"] is JsonObject)
            CompositionPackage(v)
        } catch (error: CompositionException) { throw error } catch (_: Exception) { throw CompositionException("invalid_composition") }
    }
    fun compile(bindings: Map<String, String>, instanceId: String): CompositionCompiled = try {
        MediaJSON.id(JsonPrimitive(instanceId))
        CompositionJSON.require(bindings.keys == roles.toSet() && bindings.values.toSet().size == roles.size, "invalid_composition_bindings")
        bindings.values.forEach { MediaJSON.id(JsonPrimitive(it)) }
        val map = JsonObject(bindings.mapValues { JsonPrimitive(it.value) }); CompositionJSON.require(CompositionJSON.canonical(map).toByteArray().size <= 4096, "invalid_composition_bindings")
        val template = document.getValue("rule").jsonObject
        val trigger = template.getValue("trigger").jsonObject.let { JsonObject(it + ("device" to JsonPrimitive(bindings.getValue(MediaJSON.text(it, "device"))))) }
        val actions = template.getValue("actions").jsonArray.map { it.jsonObject.let { a -> JsonObject(a + ("device" to JsonPrimitive(bindings.getValue(MediaJSON.text(a, "device"))))) } }
        val rule = JsonObject(template + mapOf("id" to JsonPrimitive(instanceId), "trigger" to trigger, "actions" to JsonArray(actions)))
        val permissions = mutableListOf(buildJsonObject { put("kind", "event.read"); put("device_id", trigger.getValue("device")); put("path", trigger.getValue("event")) })
        actions.forEach { a ->
            val item = buildJsonObject { put("kind", "property.write"); put("device_id", a.getValue("device")); put("path", a.getValue("set").jsonObject.getValue("path")) }
            if (item !in permissions) permissions.add(item)
        }
        CompositionCompiled(buildJsonObject {
            put("schema_version", 1); put("package_id", document.getValue("package_id")); put("package_version", document.getValue("version"))
            put("package_digest", CompositionJSON.digest(document)); put("bindings_digest", CompositionJSON.digest(map)); put("rule_revision", CompositionJSON.digest(rule))
            put("expected_models", JsonArray(roles.map { buildJsonObject { put("role", it); put("device_id", bindings.getValue(it)); put("model_revision", modelRevision(it)) } }))
            put("required_permissions", JsonArray(permissions)); put("rule", rule)
            put("simulation_input", buildJsonObject { put("rule", rule); put("event", buildJsonObject { put("device_id", trigger.getValue("device")); put("path", trigger.getValue("event")); put("historical", false); put("data", document.getValue("sample_event_data")) }) })
            put("gateway_checked", false); put("deployed", false)
        }, this, bindings.toMap())
    } catch (error: CompositionException) { throw error } catch (_: Exception) { throw CompositionException("invalid_composition_bindings") }
}
class CompositionCompiled internal constructor(val document: JsonObject, val manifest: CompositionPackage, val bindings: Map<String, String>) {
    val rule get() = document.getValue("rule").jsonObject
    val instanceId get() = MediaJSON.text(rule, "id")
    val revision get() = MediaJSON.text(document, "rule_revision")
    val json get() = CompositionJSON.canonical(document)
}
class CompositionRecord private constructor(val document: JsonObject, val compiled: CompositionCompiled) {
    val state get() = MediaJSON.text(document, "state")
    val json get() = CompositionJSON.canonical(document)
    companion object {
        fun parse(text: String, origin: String, space: String): CompositionRecord = try {
            val v = CompositionJSON.parse(text, 65536, 12, 4096)
            MediaJSON.fields(v, "version,origin,space_id,package,bindings,instance_id,rule_revision,state,checksum")
            CompositionJSON.require(v["version"] == JsonPrimitive(1) && v["origin"] == JsonPrimitive(origin) && v["space_id"] == JsonPrimitive(space))
            CompositionJSON.require(MediaJSON.text(v, "state") in listOf("attempted", "acknowledged", "rejected"))
            CompositionJSON.require(v["checksum"] == JsonPrimitive(CompositionJSON.digest(JsonObject(v - "checksum"))))
            val manifest = CompositionPackage.parse(CompositionJSON.canonical(v.getValue("package")))
            val bindings = v.getValue("bindings").jsonObject.mapValues { MediaJSON.str(it.value) }
            val compiled = manifest.compile(bindings, MediaJSON.text(v, "instance_id"))
            CompositionJSON.require(v["rule_revision"] == JsonPrimitive(compiled.revision)); CompositionRecord(v, compiled)
        } catch (_: Exception) { throw CompositionException("composition_record_unavailable") }
    }
}
