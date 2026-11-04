package run.limeai.iot.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import kotlin.test.*

class PropertyBridgeJourneyTest {
    @Test fun originalCommandSurvivesResponseLossAndGatewayRestart() = runBlocking {
        val phase = System.getenv("LIMEIOT_BRIDGE_PHASE") ?: return@runBlocking
        require(phase in listOf("create", "restore"))
        val original = Path.of(requireNotNull(System.getenv("LIMEIOT_BRIDGE_ORIGINAL")))
        val transport = OkHttpTransport()
        var posts = 0
        val client = GatewayClient(requireNotNull(System.getenv("LIMEIOT_ENDPOINT")), GatewayTransport { request ->
            val response = transport.send(request)
            if (request.method == "POST" && request.url.endsWith("/commands")) {
                posts++
                throw IOException("fixture_response_lost")
            }
            response
        }, allowLoopbackHTTP = true)
        client.login(requireNotNull(System.getenv("LIMEIOT_TOKEN")))
        val snapshot = client.snapshot()
        val device = snapshot.devices.first { it.deviceId == "zigbee-switch" }
        assertTrue(device.ready); assertNotNull(snapshot.models[device.modelRevision])
        val intent = if (phase == "create") {
            CommandIntent.create(device, "light.power", JsonPrimitive(true)).also {
                Files.createFile(original, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
                Files.writeString(original, Json.encodeToString(it))
                assertEquals(it, Json.decodeFromString<CommandIntent>(Files.readString(original)))
                val failure = assertFailsWith<IOException> { client.create(snapshot.space, it) }
                assertEquals("fixture_response_lost", failure.message)
            }
        } else Json.decodeFromString<CommandIntent>(Files.readString(original))
        var command = client.resolve(snapshot.space, intent.key)
        for (attempt in 0 until 100) {
            if (command.status !in listOf("accepted", "dispatched")) break
            delay(100); command = client.command(snapshot.space, command.commandId)
        }
        assertEquals("confirmed", command.status); assertEquals(intent.input, command.request)
        assertEquals(JsonPrimitive("property_observation_result"), command.evidence!!.jsonObject["type"])
        assertEquals(JsonPrimitive(true), client.snapshot().devices.first { it.deviceId == device.deviceId }.reported["light.power"]!!.value)
        assertEquals(if (phase == "create") 1 else 0, posts)
        val report = buildJsonObject {
            put("passed", true); put("phase", phase); put("key", intent.key); put("command_id", command.commandId)
            put("status", command.status); put("command_posts", posts)
        }
        Files.writeString(Path.of(requireNotNull(System.getenv("LIMEIOT_BRIDGE_TRACE"))), report.toString())
        client.logout()
    }
}
