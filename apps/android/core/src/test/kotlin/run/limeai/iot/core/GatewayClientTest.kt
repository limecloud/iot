package run.limeai.iot.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import java.io.IOException
import kotlin.test.*

class GatewayClientTest {
    @Test fun timedOutDraftQueriesOriginalWithoutAnotherSubmission() = runBlocking {
        val requests = mutableListOf<GatewayRequest>()
        val client = GatewayClient("https://nas.local:8443", GatewayTransport { request ->
            requests += request
            when {
                request.url.endsWith("/auth/session") -> GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=${"a".repeat(64)}; Secure; HttpOnly")
                request.url.contains("/rule-drafts/by-key/") -> GatewayResponse(200, """{"draft_id":"original-draft","request":{"prompt":"按下按钮开灯","expires_at":"2030-01-01T00:00:00Z"},"status":"unknown","rule":null,"error":"inference_unknown"}""")
                else -> throw IOException("response_lost")
            }
        })
        client.login("one-time-owner-input")
        val reference = DraftReference("space-demo", "original-key")
        assertFailsWith<IOException> { client.createDraft(reference, DraftInput("按下按钮开灯")) }
        val recovered = client.resolveDraft(reference)
        assertEquals("unknown", recovered.status); assertNull(recovered.rule)
        assertEquals(3, requests.size); assertEquals("GET", requests.last().method)
        assertTrue(requests.last().url.endsWith("/rule-drafts/by-key/original-key"))
        assertEquals(reference.key, requests[1].headers["Idempotency-Key"])
        val body = Json.parseToJsonElement(requests[1].body!!).jsonObject
        assertEquals("按下按钮开灯", body["prompt"]!!.jsonPrimitive.content)
        assertNull(body["space_id"]); assertNull(body["idempotency_key"])
    }
    @Test fun endpointRequiresExactHTTPSOrigin() {
        listOf("http://nas.local", "https://user@nas.local", "https://nas.local/", "https://nas.local/path", "https://nas.local?token=secret").forEach { endpoint -> assertFailsWith<GatewayException> { GatewayClient(endpoint) } }
        GatewayClient("https://nas.local:8443")
    }
    @Test fun credentialsAreIsolatedAndTimedOutCommandsAreNotRetried() = runBlocking {
        val requests = mutableListOf<GatewayRequest>()
        val client = GatewayClient("https://nas.local:8443", GatewayTransport { request ->
            requests += request
            if (request.url.endsWith("/auth/session")) GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=${"a".repeat(64)}; Secure; HttpOnly")
            else throw IOException("connection_lost")
        })
        client.login("one-time-owner-input")
        val intent = CommandIntent.create(Device("device-lamp", "sha256:fixture", true), "light.brightness", JsonPrimitive(42))
        assertFailsWith<IOException> { client.create("space-demo", intent) }
        assertEquals(2, requests.size)
        val command = requests.last()
        assertEquals("csrf", command.headers["X-CSRF-Token"])
        assertEquals(intent.key, command.headers["Idempotency-Key"])
        assertNull(command.headers["Authorization"])
        assertFalse(command.body!!.contains("owner"))
        val body = Json.parseToJsonElement(command.body).jsonObject
        assertNull(body["space_id"]); assertNull(body["idempotency_key"])
        assertEquals(42, body["operation"]!!.jsonObject["value"]!!.jsonPrimitive.int)
    }
    @Test fun actualGatewayDeviceEvidenceAndRevocation() = runBlocking {
        if (System.getenv("LIMEIOT_ACTION_CHECK") == "1") return@runBlocking
        val endpoint = System.getenv("LIMEIOT_ENDPOINT") ?: return@runBlocking
        val client = GatewayClient(endpoint, allowLoopbackHTTP = true)
        client.login(System.getenv("LIMEIOT_TOKEN"))
        val snapshot = client.snapshot(); assertEquals(2, snapshot.devices.size)
        val lamp = snapshot.devices.first { it.deviceId == "device-lamp" }
        val intent = CommandIntent.create(lamp, "light.brightness", JsonPrimitive(38))
        val accepted = client.create(snapshot.space, intent)
        var command = accepted
        repeat(50) { if (command.status != "confirmed") { delay(100); command = client.command(snapshot.space, accepted.commandId) } }
        assertEquals("confirmed", command.status)
        assertEquals(accepted.commandId, client.resolve(snapshot.space, intent.key).commandId)
        val rule = Rule(id = "kotlin-rule", trigger = Trigger("device-button", "button.pressed"), actions = listOf(Action("device-lamp", SetValue("light.power", JsonPrimitive(true)))), cooldownMs = 0)
        val simulation = client.simulate(snapshot.space, rule, buildJsonObject { put("count", 1) }); assertTrue(simulation.matched); assertFalse(simulation.executed)
        val deployment = client.deploy(snapshot.space, rule); client.stop(snapshot.space, deployment)
        assertEquals(true, snapshot.inference?.configured)
        val reference = DraftReference(snapshot.space); val input = DraftInput("按下按钮时把环境灯亮度设为37")
        var draft = client.createDraft(reference, input)
        repeat(50) { if (draft.status == "running") { delay(100); draft = client.resolveDraft(reference) } }
        assertEquals("completed", draft.status)
        assertEquals(draft.draftId, client.createDraft(reference, input).draftId)
        assertTrue(client.snapshot().deployments.isEmpty())
        val generated = requireNotNull(draft.rule)
        val proof = client.simulate(snapshot.space, generated, requireNotNull(snapshot.eventSample(generated)))
        assertTrue(proof.matched); assertFalse(proof.executed); assertEquals(draft.ruleRevision, proof.revision)
        val enabled = client.deploy(snapshot.space, generated); client.stop(snapshot.space, enabled)
        client.logout(); assertEquals(401, assertFailsWith<GatewayException> { client.snapshot() }.status)
    }
}
