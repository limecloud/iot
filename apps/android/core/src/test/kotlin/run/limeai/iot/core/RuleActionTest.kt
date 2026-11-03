package run.limeai.iot.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import kotlin.test.*

class RuleActionTest {
    @Test fun strictExclusiveActionAndLegacyRoundTrip() {
        val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
        for (input in listOf("""{"device":"tv","invoke":{"path":"remote.press","input":{"key":"home"}}}""", """{"device":"lamp","set":{"path":"light.power","value":true}}""")) {
            val action = json.decodeFromString<Action>(input)
            assertEquals(Json.parseToJsonElement(input), json.encodeToJsonElement(action))
            assertEquals(if (action.invoke != null) "action.invoke" else "property.set", action.operation.type)
        }
        for (input in listOf(
            """{"device":"tv"}""", """{"device":"tv","invoke":null}""",
            """{"device":"tv","invoke":{"path":"remote.press"}}""",
            """{"device":"tv","invoke":{"path":"remote.press","input":{}},"set":null}""",
            """{"device":"tv","set":{"path":"audio.muted","value":true},"invoke":{"path":"remote.press","input":{}}}""",
            """{"device":"tv","invoke":{"path":"remote.press","input":{},"shell":"reboot"}}""",
            """{"device":"tv","set":{"path":"audio.muted"}}"""
        )) assertFails { json.decodeFromString<Action>(input) }
    }
    @Test fun actualRuleSimulationDeploymentAndReadback() = runBlocking {
        if (System.getenv("LIMEIOT_RULE_ACTION_CHECK") != "1") return@runBlocking
        val client = GatewayClient(System.getenv("LIMEIOT_ENDPOINT"), allowLoopbackHTTP = true)
        client.login(System.getenv("LIMEIOT_TOKEN"))
        val snapshot = client.snapshot()
        val rule = Rule(id = "kotlin-action-rule", trigger = Trigger("device-button", "button.pressed"), actions = listOf(Action("device-lamp", invoke = InvokeValue("remote.press", buildJsonObject { put("key", "home") }))), cooldownMs = 10000)
        val proof = client.simulate(snapshot.space, rule, buildJsonObject { put("count", 1) })
        assertTrue(proof.matched); assertFalse(proof.executed); assertTrue(proof.simulation)
        assertTrue(client.snapshot().commands.items.isEmpty())
        val deployment = client.deploy(snapshot.space, rule)
        assertEquals(deployment.revision, client.deploy(snapshot.space, rule).revision)
        val saved = client.snapshot(); assertEquals(rule, saved.deployments.single().rule); assertTrue(saved.commands.items.isEmpty())
    }
}
