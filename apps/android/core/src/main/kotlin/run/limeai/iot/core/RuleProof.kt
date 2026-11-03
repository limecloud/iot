package run.limeai.iot.core

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import java.time.Instant

// 核对同一次规则校验/预演及完整证据，不在客户端授予领域权限。
object RuleProof {
    private fun number(value: JsonElement?): Double? = (value as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull?.takeIf { it.isFinite() }
    fun equal(a: JsonElement, b: JsonElement): Boolean {
        val x = number(a); val y = number(b); if (x != null && y != null) return x == y
        return when { a is JsonArray && b is JsonArray -> a.size == b.size && a.zip(b).all { equal(it.first, it.second) }
            a is JsonObject && b is JsonObject -> a.keys == b.keys && a.all { (key, value) -> equal(value, b.getValue(key)) }
            else -> a == b }
    }
    private fun time(value: JsonElement?) = (value as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { runCatching { Instant.parse(it) }.isSuccess } == true
    private fun revision(value: String) = Regex("^sha256:[a-f0-9]{64}$").matches(value)
    private fun nodes(conditions: List<JsonElement>, results: List<JsonElement>): Boolean {
        if (conditions.size != results.size) return false
        return conditions.zip(results).all { (condition, result) ->
            val c = condition as? JsonObject ?: return@all false; val n = result as? JsonObject ?: return@all false
            val matched = (n["matched"] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull ?: return@all false
            val group = c["all"] ?: c["any"]
            if (group != null) {
                val children = group as? JsonArray ?: return@all false; val values = n["children"] as? JsonArray ?: return@all false
                if (listOf("reason", "observation", "model_revision").any { it in n } || !nodes(children, values)) return@all false
                val matches = values.map { it.jsonObject["matched"] == JsonPrimitive(true) }
                return@all matched == if ("all" in c) matches.all { it } else matches.any { it }
            }
            if (!revision((n["model_revision"] as? JsonPrimitive)?.content ?: "") || n["children"]?.let { it != JsonArray(emptyList()) } == true) return@all false
            n["reason"]?.let { reason -> return@all !matched && (reason as? JsonPrimitive)?.takeIf { it.isString }?.content in listOf("device_not_found", "model_authority_unavailable", "device_offline", "invalid_condition", "unconfirmed_observation", "future_observation", "stale_observation", "missing_observation") }
            val observation = n["observation"] as? JsonObject ?: return@all false
            if (observation["quality"] != JsonPrimitive("confirmed") || !time(observation["observed_at"])) return@all false
            val a = observation["value"] ?: return@all false; val b = c["value"] ?: return@all false
            if (a !is JsonPrimitive || b !is JsonPrimitive || a == JsonNull || b == JsonNull || a.isString != b.isString || (number(a) == null) != (number(b) == null)) return@all false
            val op = (c["operator"] as? JsonPrimitive)?.content ?: return@all false
            val expected = when (op) { "eq" -> equal(a, b); "ne" -> !equal(a, b); else -> {
                val x = number(a) ?: return@all false; val y = number(b) ?: return@all false
                when (op) { "lt" -> x < y; "lte" -> x <= y; "gt" -> x > y; "gte" -> x >= y; else -> return@all false }
            } }
            matched == expected
        }
    }
    fun verify(proof: Simulation, rule: Rule, valid: Boolean, validationRevision: String) {
        require(valid && revision(validationRevision) && proof.revision == validationRevision && !proof.executed && proof.simulation)
        val proposed = requireNotNull(proof.proposedActions)
        val json = Json
        require(equal(json.parseToJsonElement(json.encodeToString(proposed)), json.parseToJsonElement(json.encodeToString(if (proof.matched) rule.actions else emptyList()))))
        if (rule.conditions.isEmpty()) { require(proof.matched && proof.conditionEvaluation == null); return }
        val evaluation = proof.conditionEvaluation as? JsonObject ?: error("invalid_simulation")
        require(proof.triggerMatched == true && time(evaluation["evaluated_at"]) && evaluation["conditions"]?.let { equal(it, JsonArray(rule.conditions)) } == true)
        val results = evaluation["results"] as? JsonArray ?: error("invalid_simulation")
        require(nodes(rule.conditions, results) && evaluation["matched"] == JsonPrimitive(proof.matched) && results.all { it.jsonObject["matched"] == JsonPrimitive(true) } == proof.matched)
    }
}
