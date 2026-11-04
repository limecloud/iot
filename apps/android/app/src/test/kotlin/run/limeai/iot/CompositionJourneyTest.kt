package run.limeai.iot

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption.*
import java.nio.file.attribute.PosixFilePermissions
import kotlin.test.*

private class CompositionFileStore(private val path: Path) : SessionStore {
    override suspend fun load(origin: String): String? {
        require(origin.endsWith("#composition:space-demo")); return if (Files.exists(path)) String(Files.readAllBytes(path), Charsets.UTF_8) else null
    }
    override suspend fun save(origin: String, value: String?) {
        require(origin.endsWith("#composition:space-demo") && value != null)
        val channel = if (Files.exists(path)) FileChannel.open(path, WRITE, TRUNCATE_EXISTING) else FileChannel.open(path, setOf(CREATE_NEW, WRITE), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
        channel.use { val bytes = ByteBuffer.wrap(value.toByteArray(Charsets.UTF_8)); while (bytes.hasRemaining()) it.write(bytes); it.force(true) }
    }
}
private class CompositionJourneyWire(val phase: String) : GatewayTransport {
    private val upstream = OkHttpTransport()
    val posts = mutableListOf<String>()
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        val result = upstream.send(request)
        if (request.method == "POST" && !request.url.endsWith("/auth/session")) {
            posts += request.url.substringAfterLast('/')
            if (phase == "deploy-lost" && request.url.endsWith("/rule-deployments")) throw IOException("receipt lost")
        }
        return result
    }
}
class CompositionJourneyTest {
    @Test fun originalNativeStateJourney() = runBlocking {
        val phase = System.getenv("LIMEIOT_COMPOSITION_PHASE") ?: error("explicit native phase required")
        val wire = CompositionJourneyWire(phase)
        val gateway = GatewayClient(System.getenv("LIMEIOT_ENDPOINT"), wire, allowLoopbackHTTP = true); gateway.login(System.getenv("LIMEIOT_TOKEN"))
        val client = CompositionClient(gateway, CompositionFileStore(Path.of(System.getenv("LIMEIOT_COMPOSITION_STORE"))), "space-demo")
        val controller = CompositionController(client, this, {})
        controller.updateDevices(gateway.snapshot().devices); controller.refresh(); controller.waitForIdle()
        if (phase == "deploy" || phase == "deploy-lost") {
            assertNull(controller.state.value.record)
            controller.bind("touch", "device-button"); controller.bind("light", "device-lamp")
            controller.plan(); controller.waitForIdle(); assertTrue(controller.canDeploy(), controller.state.value.message)
            controller.deploy(); controller.waitForIdle()
            assertEquals(if (phase == "deploy") "acknowledged" else "attempted", controller.state.value.record?.state, controller.state.value.message)
            assertEquals(listOf("rules:validate", "rules:simulate", "rule-deployments"), wire.posts)
        } else if (phase == "query-stop" || phase == "query-stopped") {
            val original = controller.state.value.record!!.json; controller.query(); controller.waitForIdle()
            assertEquals(original, controller.state.value.record!!.json); assertFalse(controller.canDeploy())
            val status = client.resolve()
            if (phase == "query-stop") gateway.stop("space-demo", assertNotNull(status.deployment)) else assertNull(status.deployment)
            assertEquals(if (phase == "query-stop") listOf("stop") else emptyList(), wire.posts)
        } else error("unknown phase")
        val trace = buildJsonObject {
            put("passed", true); put("phase", phase); put("host_ui_state", true); put("record", controller.state.value.record!!.document); put("posts", JsonArray(wire.posts.map(::JsonPrimitive)))
        }
        Files.write(Path.of(System.getenv("LIMEIOT_COMPOSITION_TRACE")), trace.toString().toByteArray(Charsets.UTF_8)); controller.close(); controller.waitForIdle()
    }
}
