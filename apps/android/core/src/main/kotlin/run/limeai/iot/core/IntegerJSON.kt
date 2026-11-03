package run.limeai.iot.core

import kotlinx.serialization.json.*
import java.security.MessageDigest

// 媒体与OTA共用的有界安全整数JSON；领域字段仍由各自合同核对。
internal object IntegerJSON {
    private fun fail(): Nothing = throw GatewayException("invalid_response")
    fun parse(text: String, maxBytes: Int = 2_000_000, maxDepth: Int = 24, maxNodes: Int = 65536): JsonObject = Parser(text, maxBytes, maxDepth, maxNodes).parse() as? JsonObject ?: fail()
    private class Parser(val text: String, maxBytes: Int, val depthLimit: Int, val nodeLimit: Int) {
        var p = 0; var nodes = 0
        init { if (text.toByteArray(Charsets.UTF_8).size > maxBytes) fail() }
        fun ws() { while (p < text.length && text[p] in " \t\r\n") p++ }
        fun take(c: Char): Boolean { ws(); return if (p < text.length && text[p] == c) { p++; true } else false }
        fun string(): String {
            ws(); val start = p
            if (p >= text.length || text[p++] != '"') fail()
            while (p < text.length) {
                val c = text[p++]
                if (c == '\\') { if (p == text.length) fail(); p++ }
                else if (c == '"') {
                    val value = runCatching { Json.parseToJsonElement(text.substring(start, p)).jsonPrimitive.content }.getOrElse { fail() }
                    var i = 0
                    while (i < value.length) {
                        if (value[i].isHighSurrogate()) { if (++i >= value.length || !value[i].isLowSurrogate()) fail() }
                        else if (value[i].isLowSurrogate()) fail()
                        i++
                    }
                    return value
                } else if (c < ' ') fail()
            }
            fail()
        }
        fun value(depth: Int): JsonElement {
            ws(); if (++nodes > nodeLimit || depth > depthLimit || p == text.length) fail()
            if (take('{')) {
                val values = linkedMapOf<String, JsonElement>()
                if (!take('}')) { do { val key = string(); if (values.containsKey(key) || !take(':')) fail(); values[key] = value(depth + 1) } while (take(',')); if (!take('}')) fail() }
                return JsonObject(values)
            }
            if (take('[')) {
                val values = mutableListOf<JsonElement>()
                if (!take(']')) { do { values += value(depth + 1) } while (take(',')); if (!take(']')) fail() }
                return JsonArray(values)
            }
            if (text[p] == '"') return JsonPrimitive(string())
            val start = p
            while (p < text.length && text[p] !in ",]} \t\r\n") p++
            val token = text.substring(start, p)
            return when (token) {
                "true" -> JsonPrimitive(true); "false" -> JsonPrimitive(false); "null" -> JsonNull
                else -> {
                    if (token.length > 32 || !token.matches(Regex("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?"))) fail()
                    val n = token.toBigDecimalOrNull() ?: fail()
                    if (n.scale() !in -4096..4096) fail()
                    val integer = runCatching { n.toBigIntegerExact().longValueExact() }.getOrElse { fail() }
                    if (integer !in -9007199254740991L..9007199254740991L) fail()
                    JsonPrimitive(integer)
                }
            }
        }
        fun parse(): JsonElement { val result = value(0); ws(); if (p != text.length) fail(); return result }
    }
    fun canonical(value: JsonElement): String = when (value) {
        is JsonObject -> value.keys.sorted().joinToString(",", "{", "}") { JsonPrimitive(it).toString() + ":" + canonical(value.getValue(it)) }
        is JsonArray -> value.joinToString(",", "[", "]") { canonical(it) }
        else -> value.toString()
    }
    fun digest(value: JsonElement) = "sha256:" + MessageDigest.getInstance("SHA-256").digest(canonical(value).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
