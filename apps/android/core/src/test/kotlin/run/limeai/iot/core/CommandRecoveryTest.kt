package run.limeai.iot.core

import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import kotlin.test.*

class CommandRecoveryTest {
    @Test fun originalRequestAndResultEvidenceUseSharedVectorsWithoutReplay() = runBlocking {
        val json = Json { ignoreUnknownKeys = true }
        val path = System.getenv("LIMEIOT_COMMAND_RECOVERY_FIXTURE") ?: "../../../tests/fixtures/commands/recovery.json"
        val cases = json.parseToJsonElement(File(path).readText()).jsonObject.getValue("cases").jsonArray
        assertEquals(30, cases.size)
        for (row in cases.map { it.jsonObject }) {
            val name = row.getValue("name").jsonPrimitive.content
            val expected = row.getValue("expected").jsonObject
            val intent = CommandIntent(expected.getValue("idempotency_key").jsonPrimitive.content, json.decodeFromJsonElement(expected))
            val space = expected.getValue("space_id").jsonPrimitive.content
            val methods = mutableListOf<String>()
            val client = GatewayClient("https://nas.local:8443", GatewayTransport { request ->
                methods += request.method
                if (request.url.endsWith("/auth/session")) GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
                else GatewayResponse(200, row.getValue("response").toString())
            })
            client.login("fixture")
            for (resolve in listOf(false, true)) {
                if (row.getValue("valid").jsonPrimitive.boolean) {
                    val result = if (resolve) client.resolve(space, intent) else client.create(space, intent)
                    assertEquals("command-original", result.commandId, name)
                } else {
                    val error = assertFailsWith<GatewayException>(name) { if (resolve) client.resolve(space, intent) else client.create(space, intent) }
                    assertEquals("invalid_response", error.code, name)
                }
            }
            assertEquals(listOf("POST", "POST", "GET"), methods, name)
        }
    }
}
