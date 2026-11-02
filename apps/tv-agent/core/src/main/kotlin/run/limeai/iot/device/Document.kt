package run.limeai.iot.device

import com.fasterxml.jackson.core.JsonFactory
import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.core.JsonToken
import com.fasterxml.jackson.core.StreamReadConstraints
import kotlinx.serialization.json.*
import java.security.MessageDigest
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class DeviceFault(val code: String) : Exception(code)
internal fun checkDevice(value: Boolean, code: String = "invalid_message") { if (!value) throw DeviceFault(code) }
internal val identifier = Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
internal val applicationId = Regex("[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)+")
internal fun JsonElement.obj(): JsonObject = this as? JsonObject ?: throw DeviceFault("invalid_message")
internal fun JsonObject.text(key: String): String {
    val p = get(key) as? JsonPrimitive ?: throw DeviceFault("invalid_message")
    checkDevice(p.isString)
    return p.content
}
internal fun JsonObject.integer(key: String): Long {
    val p = get(key) as? JsonPrimitive ?: throw DeviceFault("invalid_message")
    checkDevice(!p.isString)
    return p.longOrNull ?: throw DeviceFault("invalid_message")
}
internal fun JsonObject.fields(vararg keys: String) = checkDevice(this.keys == keys.toSet())
internal fun obj(vararg values: Pair<String, JsonElement>) = JsonObject(linkedMapOf(*values))
internal fun text(value: String) = JsonPrimitive(value)

// 设备模型只有字符串动作及安全整数元数据，不接受浮点数或任意 JSON Schema 执行。
object DeviceDocument {
    private val factory = JsonFactory.builder()
        .streamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(16).maxStringLength(4096).maxNumberLength(20).build())
        .build().enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)

    fun parse(bytes: ByteArray, maxBytes: Int = 16384, maxNodes: Int = 2048): JsonObject {
        checkDevice(bytes.isNotEmpty() && bytes.size <= maxBytes)
        try {
            factory.createParser(bytes).use { parser ->
                var nodes = 0
                fun read(token: JsonToken?): JsonElement {
                    checkDevice(++nodes <= maxNodes)
                    return when (token) {
                        JsonToken.START_OBJECT -> {
                            val values = linkedMapOf<String, JsonElement>()
                            while (parser.nextToken() != JsonToken.END_OBJECT) {
                                checkDevice(parser.currentToken() == JsonToken.FIELD_NAME)
                                val key = scalar(parser.currentName())
                                values[key] = read(parser.nextToken())
                            }
                            JsonObject(values)
                        }
                        JsonToken.START_ARRAY -> {
                            val values = mutableListOf<JsonElement>()
                            while (parser.nextToken() != JsonToken.END_ARRAY) values += read(parser.currentToken())
                            JsonArray(values)
                        }
                        JsonToken.VALUE_STRING -> text(scalar(parser.text))
                        JsonToken.VALUE_NUMBER_INT -> {
                            val n = parser.longValue
                            checkDevice(n in -9007199254740991L..9007199254740991L)
                            JsonPrimitive(n)
                        }
                        JsonToken.VALUE_TRUE -> JsonPrimitive(true)
                        JsonToken.VALUE_FALSE -> JsonPrimitive(false)
                        JsonToken.VALUE_NULL -> JsonNull
                        else -> throw DeviceFault("invalid_message")
                    }
                }
                val value = read(parser.nextToken()).obj()
                checkDevice(parser.nextToken() == null)
                return value
            }
        } catch (failure: DeviceFault) { throw failure }
        catch (_: Exception) { throw DeviceFault("invalid_message") }
    }

    private fun scalar(value: String): String {
        var i = 0
        while (i < value.length) {
            val c = value[i++]
            if (Character.isHighSurrogate(c)) checkDevice(i < value.length && Character.isLowSurrogate(value[i++]))
            else checkDevice(!Character.isLowSurrogate(c))
        }
        return value
    }

    // 本模块的有界整数/字符串子集与 RFC 8785 一致，字段按 UTF-16 排序。
    fun canonical(value: JsonElement): String = when (value) {
        is JsonObject -> value.keys.sorted().joinToString(",", "{", "}") { text(scalar(it)).toString() + ":" + canonical(value.getValue(it)) }
        is JsonArray -> value.joinToString(",", "[", "]") { canonical(it) }
        is JsonPrimitive -> if (value.isString) text(scalar(value.content)).toString() else {
            checkDevice(value == JsonNull || value.booleanOrNull != null || value.longOrNull?.let { it in -9007199254740991L..9007199254740991L } == true)
            value.longOrNull?.toString() ?: value.toString()
        }
    }
    fun digest(value: JsonElement): String = "sha256:" + MessageDigest.getInstance("SHA-256")
        .digest(canonical(value).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
}

internal object DeviceTime {
    private val pattern = Regex("(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})(?:\\.(\\d{1,9}))?(Z|[+-]\\d{2}:\\d{2})")
    private fun formatter() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC"); isLenient = false }
    fun parse(value: String): Long {
        val match = pattern.matchEntire(value) ?: throw DeviceFault("invalid_time")
        val position = ParsePosition(0)
        val base = formatter().parse(match.groupValues[1], position) ?: throw DeviceFault("invalid_time")
        checkDevice(position.index == 19, "invalid_time")
        val zone = match.groupValues[3]
        var offset = 0L
        if (zone != "Z") {
            val hours = zone.substring(1, 3).toInt(); val minutes = zone.substring(4, 6).toInt()
            checkDevice(hours <= 23 && minutes <= 59, "invalid_time")
            offset = (hours * 60L + minutes) * 60000L * if (zone[0] == '-') -1 else 1
        }
        return base.time - offset + match.groupValues[2].padEnd(3, '0').take(3).toInt()
    }
    fun format(millis: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(millis))
}
