package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import kotlin.test.*

private class JoinFileStore(private val file: File) : SessionStore {
    override suspend fun load(origin: String): String? { check(origin.endsWith("#zigbee-operations")); return if (file.isFile) file.readText() else null }
    override suspend fun save(origin: String, value: String?) {
        check(origin.endsWith("#zigbee-operations") && value != null)
        if (!file.exists()) Files.createFile(file.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
        FileChannel.open(file.toPath(), StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING).use { channel -> val bytes = ByteBuffer.wrap(value.toByteArray()); while (bytes.hasRemaining()) channel.write(bytes); channel.force(true) }
    }
}
private class JoinLiveWire(private val drop: Boolean) : GatewayTransport {
    private val upstream = OkHttpTransport(); var posts = 0
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        val result = upstream.send(request)
        if (request.method == "POST" && request.url.endsWith("/zigbee-operations")) { posts++; if (drop && posts == 1) throw IOException("actual receipt lost") }
        return result
    }
}
class ZigbeeJourneyTest {
    @Test fun realGatewayCommissioningRecovery() = runBlocking {
        val env = System.getenv(); val endpoint = env["LIMEIOT_ENDPOINT"] ?: error("live gateway endpoint required")
        val phase = env.getValue("LIMEIOT_ZIGBEE_PHASE"); val space = "space-demo"; val file = JoinFileStore(File(env.getValue("LIMEIOT_ZIGBEE_STORE"))); val wire = JoinLiveWire(phase == "create")
        val gateway = GatewayClient(endpoint, wire, allowLoopbackHTTP = true); gateway.login(env.getValue("LIMEIOT_TOKEN"))
        suspend fun make(): ZigbeeController = ZigbeeController(ZigbeeClient(gateway, file), space, this, {}).also { it.refresh(); it.waitForIdle(); assertTrue(it.state.value.ready, it.state.value.message) }
        var state = make()
        if (phase == "create") {
            state.prepare(); state.waitForIdle(); assertNotNull(state.state.value.review); assertTrue(state.state.value.records.isEmpty())
            state.confirm(); state.waitForIdle(); assertEquals(1, state.state.value.records.size); assertNull(state.state.value.records[0].result)
            state.close(); state = make(); state.recover(state.state.value.records[0].key); state.waitForIdle(); assertTrue(state.state.value.records[0].accepted)
            val memory = object : SessionStore {
                val values = mutableMapOf<String, String>()
                override suspend fun load(origin: String) = values[origin]
                override suspend fun save(origin: String, value: String?) { if (value == null) values.remove(origin) else values[origin] = value }
            }
            val sources = ObservationController(ObservationClient(gateway, memory), space, this, {})
            sources.updateDevices(gateway.snapshot().devices); sources.refresh(); sources.waitForIdle(); sources.setDevice("zigbee-environment")
            sources.discover(); sources.waitForIdle(); sources.readEndpoints("1122334455667788"); sources.waitForIdle(); sources.queryEndpoint(1); sources.waitForIdle()
            assertNotNull(sources.state.value.review, sources.state.value.message); sources.confirm(); sources.waitForIdle(); assertTrue(sources.state.value.bindings.first().active); sources.close()
        } else {
            assertEquals("restore", phase); assertEquals(2, state.state.value.records.size)
            for (record in state.state.value.records) { state.recover(record.key); state.waitForIdle() }
        }
        state.prepare(close = true); state.waitForIdle(); assertNotNull(state.state.value.review, state.state.value.message)
        state.confirm(); state.waitForIdle(); assertTrue(state.state.value.entries.last().accepted, state.state.value.message)
        val records = ZigbeeClient(gateway, file).records(space); assertEquals(if (phase == "create") 2 else 1, wire.posts); assertEquals(if (phase == "create") 2 else 3, records.size); state.close()
        val trace = buildJsonObject { put("passed", true); put("phase", phase); put("host_ui_state", true); put("commissioning_posts", wire.posts); put("records", JsonArray(records.map { buildJsonObject { put("request", it.request); put("result", it.result ?: JsonNull) } })); put("hardware", false); put("native_app_runtime", false) }
        File(env.getValue("LIMEIOT_ZIGBEE_TRACE")).writeText(ObservationJSON.canonical(trace))
    }
}
