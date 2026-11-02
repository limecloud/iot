package run.limeai.iot.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import java.io.File
import java.io.IOException
import java.net.URI
import java.time.Instant
import kotlin.test.*

class OtaIntegrationTest {
    @Test fun localUpgradeOriginalRecoveryAndNewBootEvidence() = runBlocking {
        val env = System.getenv()
        if (env["LIMEIOT_OTA_CHECK"] != "1") return@runBlocking
        val origin = env.getValue("LIMEIOT_ENDPOINT"); val space = "space-demo"
        val vector = OtaJSON.parse(File(env.getValue("LIMEIOT_OTA_VECTOR")).readText(), response = true).getValue("request").jsonObject
        val store = object : SessionStore {
            val data = mutableMapOf<String, String>()
            override suspend fun load(origin: String) = data[origin]
            override suspend fun save(origin: String, value: String?) { if (value == null) data.remove(origin) else data[origin] = value }
        }
        var upstream = OkHttpTransport(); var posts = 0
        val wire = GatewayTransport { request ->
            val response = upstream.send(request)
            if (request.method == "POST" && request.url.endsWith("/ota-operations")) {
                posts++
                if (OtaJSON.parse(request.body!!)["type"] == JsonPrimitive("tasks.execute")) throw IOException("response lost after actual send")
            }
            response
        }
        val gateway = GatewayClient(origin, wire, store, allowLoopbackHTTP = true); gateway.login(env.getValue("LIMEIOT_TOKEN"))
        val client = OtaClient(gateway, store)
        val add = buildJsonObject { put("type", "trust.add"); put("trust", vector.getValue("trust")); put("expected_signing_key_id", vector.getValue("trust").jsonObject.getValue("signing_key_id")) }
        client.submit(space, add, "native-trust")
        val trust = client.trusts(space).single()
        val plan = buildJsonObject { put("type", "tasks.plan"); put("device_id", "device-lamp"); put("trust_id", trust.id); put("manifest", vector.getValue("manifest")); put("expires_at", Instant.now().plusSeconds(600).toString()) }
        fun transition(task: OtaTask, type: String) = buildJsonObject { put("type", type); put("task_id", task.id); put("expected_revision", task.revision) }
        fun checkpoint(name: String) { val connection = URI(env.getValue("LIMEIOT_OTA_FIXTURE") + "/" + name).toURL().openConnection() as java.net.HttpURLConnection; connection.connectTimeout = 15000; connection.readTimeout = 15000; try { assertEquals(200, connection.responseCode) } finally { connection.disconnect() } }
        client.submit(space, plan, "cancel-plan")
        val cancelled = client.tasks(space).single()
        client.submit(space, transition(cancelled, "tasks.cancel"), "cancel")
        assertEquals("cancelled", client.task(space, cancelled.id).status)
        client.submit(space, plan, "install-plan")
        var task = client.tasks(space).single { it.status == "planned" }
        client.submit(space, transition(task, "tasks.approve"), "approve")
        task = client.task(space, task.id); assertEquals("approved", task.status); checkpoint("approved")
        assertFailsWith<IOException> { client.submit(space, transition(task, "tasks.execute"), "execute") }
        assertEquals("ota_pending_operation", assertFailsWith<OtaException> { client.submit(space, plan, "replacement-plan") }.code)
        val restoredGateway = GatewayClient(origin, wire, store, allowLoopbackHTTP = true); restoredGateway.restore()
        var restored = OtaClient(restoredGateway, store); restored.resolve(space, "execute")
        checkpoint("restart")
        upstream = OkHttpTransport()
        val resumedGateway = GatewayClient(origin, wire, store, allowLoopbackHTTP = true); resumedGateway.login(env.getValue("LIMEIOT_TOKEN"))
        restored = OtaClient(resumedGateway, store); restored.resolve(space, "execute")
        task = restored.task(space, task.id); assertEquals("unknown", task.status)
        restored.submit(space, transition(task, "tasks.reconcile"), "reconcile"); checkpoint("complete")
        repeat(40) { if (task.status != "succeeded") { delay(100); task = restored.task(space, task.id) } }
        assertEquals("succeeded", task.status)
        restored.submit(space, buildJsonObject { put("type", "trust.revoke"); put("trust_id", trust.id); put("expected_revision", trust.revision) }, "revoke")
        val records = restored.records(space); assertEquals(8, records.size); assertTrue(records.all { it.result != null }); assertEquals(8, posts)
        File(env.getValue("LIMEIOT_OTA_TRACE")).writeText("""{"passed":true,"posts":$posts,"original_records":${records.size},"hardware":false,"native_app_runtime":false}""")
    }
}
