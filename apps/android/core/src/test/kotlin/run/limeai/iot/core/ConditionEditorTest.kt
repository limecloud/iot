package run.limeai.iot.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import kotlin.test.*

class ConditionEditorTest {
    private val json = Json { ignoreUnknownKeys = true }
    private val sources = listOf(ConditionSource("sensor", "environment.temperature", "温度", ValueSchema("integer", minimum = -4500.0, maximum = 13000.0), "celsius_x100"), ConditionSource("lamp", "light.power", "电源", ValueSchema("boolean")), ConditionSource("pet", "voice.mode", "模式", ValueSchema("string", minLength = 1, maxLength = 8)))
    private val temperature = ConditionEditor.new(sources[0]).copy(comparison = "gte", value = "28.03")
    @Test fun fullTreeRoundTripAndExactValues() {
        val group = ConditionForm(kind = "all", children = listOf(temperature, ConditionForm(kind = "any", children = listOf(ConditionEditor.new(sources[1]), ConditionEditor.new(sources[2]).copy(value = " Talk ")))))
        val tree = assertNotNull(ConditionEditor.compile(listOf(group), sources))
        assertEquals(JsonPrimitive(2803), tree[0].jsonObject["all"]!!.jsonArray[0].jsonObject["value"])
        assertTrue(RuleProof.equal(JsonArray(tree), JsonArray(assertNotNull(ConditionEditor.compile(assertNotNull(ConditionEditor.restore(tree, sources)), sources)))))
        for (value in listOf("28.001", "NaN", "131", "1e2", "")) assertNull(ConditionEditor.compile(listOf(temperature.copy(value = value)), sources), value)
        assertNull(ConditionEditor.compile(listOf(ConditionEditor.new(sources[1]).copy(value = "1")), sources))
        assertNull(ConditionEditor.compile(listOf(ConditionEditor.new(sources[2]).copy(value = "")), sources))
    }
    @Test fun losslessRestoreAndBoundedStructure() {
        val comparison = assertNotNull(ConditionEditor.compile(listOf(temperature), sources))[0].jsonObject
        assertNull(ConditionEditor.restore(listOf(comparison), sources.drop(1)))
        assertNull(ConditionEditor.restore(listOf(JsonObject(comparison + ("extra" to JsonPrimitive(true)))), sources))
        assertNull(ConditionEditor.restore(listOf(JsonObject(comparison + ("unit" to JsonPrimitive("kelvin")))), sources))
        assertNull(ConditionEditor.compile(List(17) { temperature }, sources))
        assertNull(ConditionEditor.compile(List(16) { ConditionForm(kind = "any", children = listOf(temperature, temperature)) }, sources))
        var deep = temperature; repeat(4) { deep = ConditionForm(kind = "all", children = listOf(deep)) }
        assertNull(ConditionEditor.compile(listOf(deep), sources)); assertNull(ConditionEditor.compile(listOf(ConditionForm(kind = "any")), sources))
    }
    @Test fun millisecondCooldownIsExact() {
        assertEquals(1001, ConditionEditor.cooldown("1.001")); assertEquals("1.001", ConditionEditor.cooldownText(1001))
        for (value in listOf("0.0001", "NaN", "-1", "86400.001", "1e2", "")) assertNull(ConditionEditor.cooldown(value))
    }
    @Test fun proofRequiresValidTriggerAndFullUnmetEvidence() {
        val condition = json.parseToJsonElement("""{"device":"lamp","property":"light.power","operator":"eq","value":true}""")
        val rule = Rule(id = "test", trigger = Trigger("button", "button.pressed"), conditions = listOf(condition), actions = listOf(Action("lamp", SetValue("light.power", JsonPrimitive(true)))), cooldownMs = 1001)
        val revision = "sha256:" + "a".repeat(64)
        val proof = json.parseToJsonElement("""{"revision":"$revision","matched":false,"executed":false,"simulation":true,"trigger_matched":true,"proposed_actions":[],"condition_evaluation":{"evaluated_at":"2026-11-03T00:00:00Z","conditions":[$condition],"matched":false,"results":[{"matched":false,"model_revision":"$revision","observation":{"value":false,"observed_at":"2026-11-03T00:00:00Z","quality":"confirmed","source":"device"}}]}}""").jsonObject
        val valid = json.decodeFromString<Simulation>(proof.toString()); RuleProof.verify(valid, rule, true, revision); assertTrue(valid.canDeploy)
        val evaluation = proof.getValue("condition_evaluation").jsonObject
        val node = evaluation.getValue("results").jsonArray[0].jsonObject
        val metObservation = JsonObject(node.getValue("observation").jsonObject + ("value" to JsonPrimitive(true)))
        val metNode = JsonObject(node + ("matched" to JsonPrimitive(true)) + ("observation" to metObservation))
        val metEvaluation = JsonObject(evaluation + ("matched" to JsonPrimitive(true)) + ("results" to JsonArray(listOf(metNode))))
        val met = JsonObject(proof + ("matched" to JsonPrimitive(true)) + ("proposed_actions" to json.parseToJsonElement(json.encodeToString(rule.actions))) + ("condition_evaluation" to metEvaluation))
        RuleProof.verify(json.decodeFromString<Simulation>(met.toString()), rule, true, revision)
        val corrupted = JsonObject(proof + ("condition_evaluation" to JsonObject(evaluation + ("results" to JsonArray(listOf(metNode))))))
        assertFails { RuleProof.verify(json.decodeFromString<Simulation>(corrupted.toString()), rule, true, revision) }
        for ((field, value) in listOf("trigger_matched" to JsonPrimitive(false), "executed" to JsonPrimitive(true), "revision" to JsonPrimitive("wrong"), "condition_evaluation" to JsonNull, "proposed_actions" to json.parseToJsonElement(json.encodeToString(rule.actions)))) {
            assertFails { RuleProof.verify(json.decodeFromString<Simulation>(JsonObject(proof + (field to value)).toString()), rule, true, revision) }
        }
        assertFails { RuleProof.verify(json.decodeFromString<Simulation>(JsonObject(proof - "trigger_matched").toString()), rule, true, revision) }
    }
    @Test fun actualGatewayUnmetPreviewAndReadback() = runBlocking {
        if (System.getenv("LIMEIOT_CONDITION_CHECK") != "1") return@runBlocking
        val client = GatewayClient(System.getenv("LIMEIOT_ENDPOINT"), allowLoopbackHTTP = true); client.login(System.getenv("LIMEIOT_TOKEN"))
        val snapshot = client.snapshot()
        if (System.getenv("LIMEIOT_CONDITION_PHASE") == "read") {
            val run = snapshot.runs.single { it.eventId == "native-condition-met" }
            val evaluation = assertNotNull(run.conditionEvaluation).jsonObject
            assertNull(run.error); assertEquals(1, run.commandIds.size)
            assertEquals(JsonPrimitive(50), evaluation["results"]!!.jsonArray[0].jsonObject["children"]!!.jsonArray[0].jsonObject["observation"]!!.jsonObject["value"])
            assertTrue(ConditionEditor.evidenceRows(assertNotNull(run.conditionEvaluation)).any { it.contains("观测值 50.0") })
            assertTrue(snapshot.runs.single { it.error == "rule_conditions_not_met" }.commandIds.isEmpty()); return@runBlocking
        }
        val original = snapshot.deployments.single().rule
        val forms = assertNotNull(ConditionEditor.restore(original.conditions, ConditionEditor.sources(snapshot)))
        val children = forms[0].children.toMutableList(); children[0] = children[0].copy(value = "45")
        val updated = forms.toMutableList(); updated[0] = forms[0].copy(children = children)
        val rule = original.copy(conditions = assertNotNull(ConditionEditor.compile(updated, ConditionEditor.sources(snapshot))))
        val proof = client.simulate(snapshot.space, rule, buildJsonObject { put("count", 1) })
        assertFalse(proof.matched); assertTrue(proof.canDeploy); assertEquals(true, proof.triggerMatched); assertNotNull(proof.conditionEvaluation)
        assertTrue(client.snapshot().commands.items.isEmpty())
        val deployment = client.deploy(snapshot.space, rule); assertEquals(rule, deployment.rule); assertEquals(1001, deployment.rule.cooldownMs)
    }
}
