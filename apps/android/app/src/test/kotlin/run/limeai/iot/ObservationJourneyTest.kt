package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.io.File
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import kotlin.test.*

private class SourceFileStore(private val file: File) : SessionStore {
    override suspend fun load(origin: String): String? { check(origin.endsWith("#observation-operations")); return if (file.isFile) file.readText() else null }
    override suspend fun save(origin: String, value: String?) {
        check(origin.endsWith("#observation-operations") && value != null)
        if (!file.exists()) Files.createFile(file.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
        FileChannel.open(file.toPath(), StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING).use { channel -> val bytes = ByteBuffer.wrap(value.toByteArray()); while (bytes.hasRemaining()) channel.write(bytes); channel.force(true) }
    }
}
private class SourceLiveWire(private val drop: Boolean) : GatewayTransport {
    private val upstream = OkHttpTransport(); var posts = 0; var queries = 0
    var discoveries = 0; var endpointQueries = 0
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        val result = upstream.send(request)
        if (request.method == "POST" && request.url.endsWith("/observation-operations")) { posts++; if (drop && posts == 1) throw IOException("actual receipt lost") }
        if (request.method == "POST" && request.url.endsWith("/observation-candidates")) queries++
        if (request.method == "POST" && request.url.endsWith("/observation-discoveries")) discoveries++
        if (request.method == "POST" && request.url.endsWith("/observation-endpoints")) endpointQueries++
        return result
    }
}
class ObservationJourneyTest {
    @Test fun realGatewaySourceRecovery() = runBlocking {
        val env = System.getenv(); val endpoint = env["LIMEIOT_ENDPOINT"] ?: return@runBlocking
        val phase = env.getValue("LIMEIOT_OBSERVATION_PHASE"); val space = "space-demo"
        val onOff = env["LIMEIOT_OBSERVATION_PROFILE"] == "on_off"; val device = if (onOff) "zigbee-switch" else "zigbee-environment"; val ieee = if (onOff) "1122334455667789" else "1122334455667788"
        val file = SourceFileStore(File(env.getValue("LIMEIOT_OBSERVATION_STORE"))); val wire = SourceLiveWire(phase == "create")
        val gateway = GatewayClient(endpoint, wire, allowLoopbackHTTP = true); gateway.login(env.getValue("LIMEIOT_TOKEN"))
        suspend fun make(): ObservationController {
            val c = ObservationController(ObservationClient(gateway, file), space, this, {})
            c.updateDevices(gateway.snapshot().devices); c.refresh(); c.waitForIdle(); assertTrue(c.state.value.ready, c.state.value.message)
            assertNull(c.state.value.discovery); assertNull(c.state.value.endpoints)
            c.setIEEE(ieee); c.setDevice(device); return c
        }
        suspend fun discoverAndQuery(state: ObservationController) {
            state.discover(); state.waitForIdle()
            assertTrue(state.state.value.discovery?.items?.any { it.ieee == ieee } == true, state.state.value.message); assertNull(state.state.value.review)
            state.readEndpoints(ieee); state.waitForIdle()
            assertTrue(state.state.value.endpoints?.items?.any { it.endpoint == 1 && (if (onOff) it.supportsOnOff else it.supportsEnvironment) } == true, state.state.value.message)
            assertEquals(device, state.state.value.device)
            state.queryEndpoint(1); state.waitForIdle(); assertNotNull(state.state.value.review, state.state.value.message)
            assertEquals(if (onOff) ObservationProfile.OnOff else ObservationProfile.Environment, state.state.value.review?.candidate?.profile)
        }
        suspend fun sample() {
            repeat(100) {
                val d = gateway.snapshot().devices.firstOrNull { it.deviceId == device }
                if (d?.ready == true && d.reported[if (onOff) "light.power" else "environment.temperature"]?.quality == "confirmed") return
                delay(100)
            }
            fail("live source sample missing")
        }
        val state = make()
        when (phase) {
            "create" -> {
                discoverAndQuery(state)
                state.confirm(); state.waitForIdle(); assertTrue(state.state.value.records.single().pending)
                sample(); state.close()
                val restored = make(); val key = restored.state.value.records.single().key
                restored.recover(key); restored.waitForIdle(); assertEquals("applied", restored.state.value.records.single().status)
                restored.reviewRevoke(device); restored.waitForIdle(); assertNotNull(restored.state.value.review)
                restored.confirm(); restored.waitForIdle(); assertFalse(restored.state.value.bindings.single().active, restored.state.value.message)
                restored.recover(key); restored.waitForIdle(); assertFalse(restored.state.value.bindings.single().active); restored.close()
            }
            "restore" -> {
                assertEquals(2, state.state.value.records.size); assertFalse(state.state.value.bindings.single().active)
                state.recover(state.state.value.records.first().key); state.waitForIdle(); assertFalse(state.state.value.bindings.single().active)
                discoverAndQuery(state)
                state.confirm(); state.waitForIdle(); assertTrue(state.state.value.bindings.single().active, state.state.value.message)
                sample(); state.close()
            }
            else -> fail("invalid phase")
        }
        val records = ObservationClient(gateway, file).records(space)
        assertEquals(if (phase == "create") 2 else 1, wire.posts); assertEquals(1, wire.queries); assertEquals(if (phase == "create") 2 else 3, records.size)
        assertEquals(1, wire.discoveries); assertEquals(1, wire.endpointQueries)
        val trace = buildJsonObject { put("passed", true); put("phase", phase); put("host_ui_state", true); put("decision_posts", wire.posts); put("query_posts", wire.queries); put("discovery_posts", wire.discoveries); put("endpoint_posts", wire.endpointQueries); put("records", JsonArray(records.map { buildJsonObject { put("request", it.request); put("result", it.result ?: JsonNull) } })); put("hardware", false); put("native_app_runtime", false) }
        File(env.getValue("LIMEIOT_OBSERVATION_TRACE")).writeText(ObservationJSON.canonical(trace))
    }
}
