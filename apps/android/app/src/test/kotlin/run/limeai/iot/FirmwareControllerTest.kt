package run.limeai.iot

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.io.File
import java.io.IOException
import java.net.URI
import java.time.Instant
import kotlin.test.*

class FirmwareControllerTest {
    @Test fun ownerMustReviewEachStageAndUnknownCannotInstallAgain() = runBlocking {
        val env = System.getenv(); if (env["LIMEIOT_OTA_STATE_CHECK"] != "1") return@runBlocking
        val origin = env.getValue("LIMEIOT_ENDPOINT"); val space = "space-demo"
        val vector = OtaJSON.parse(File(env.getValue("LIMEIOT_OTA_VECTOR")).readText(), response = true).getValue("request").jsonObject
        val vault = object : SessionStore {
            val data = mutableMapOf<String, String>()
            override suspend fun load(origin: String) = data[origin]
            override suspend fun save(origin: String, value: String?) { if (value == null) data.remove(origin) else data[origin] = value }
        }
        var upstream = OkHttpTransport(); var posts = 0
        val wire = GatewayTransport { request ->
            val response = upstream.send(request)
            if (request.method == "POST" && request.url.endsWith("/ota-operations")) {
                posts++
                if (OtaJSON.parse(request.body!!)["type"] == JsonPrimitive("tasks.execute")) throw IOException("lost after actual send")
            }
            response
        }
        suspend fun connect(): FirmwareController {
            val gateway = GatewayClient(origin, wire, vault, allowLoopbackHTTP = true); gateway.login(env.getValue("LIMEIOT_TOKEN"))
            return FirmwareController(OtaClient(gateway, vault), space, this) { throw it }
        }
        suspend fun idle(controller: FirmwareController) { repeat(1000) { if (!controller.state.value.busy) return; delay(10) }; fail("controller remained busy") }
        fun checkpoint(name: String) { val connection = URI(env.getValue("LIMEIOT_OTA_FIXTURE") + "/" + name).toURL().openConnection() as java.net.HttpURLConnection; connection.connectTimeout = 15000; connection.readTimeout = 15000; try { assertEquals(200, connection.responseCode) } finally { connection.disconnect() } }
        val controller = connect(); controller.refresh(); idle(controller); assertTrue(controller.state.value.ready)
        controller.submit { buildJsonObject { put("type", "trust.add"); put("trust", vector.getValue("trust")); put("expected_signing_key_id", vector.getValue("trust").jsonObject.getValue("signing_key_id")) } }; idle(controller)
        val trust = controller.state.value.trusts.single()
        val plan = buildJsonObject { put("type", "tasks.plan"); put("device_id", "device-lamp"); put("trust_id", trust.id); put("manifest", vector.getValue("manifest")); put("expires_at", Instant.now().plusSeconds(600).toString()) }
        controller.submit { plan }; idle(controller); val cancelledId = controller.state.value.tasks.single().id
        controller.review(cancelledId); idle(controller); controller.transition("tasks.cancel"); idle(controller)
        assertEquals("cancelled", controller.state.value.tasks.single().status); assertNull(controller.state.value.reviewed)
        controller.submit { plan }; idle(controller); val id = controller.state.value.tasks.single { it.status == "planned" }.id
        controller.transition("tasks.approve"); idle(controller); assertEquals(4, posts)
        controller.review(id); idle(controller); controller.transition("tasks.approve"); idle(controller)
        assertNull(controller.state.value.reviewed); assertEquals("approved", controller.state.value.tasks.single { it.id == id }.status)
        controller.transition("tasks.execute"); idle(controller); assertEquals(5, posts); checkpoint("approved")
        controller.review(id); idle(controller); controller.transition("tasks.execute"); idle(controller)
        assertFalse(controller.state.value.ready); assertEquals(6, controller.state.value.records.size); assertNull(controller.state.value.records.last().result)
        controller.refresh(); idle(controller); controller.submit { plan }; idle(controller); assertEquals(6, posts)
        val original = controller.state.value.records.single { it.type == "tasks.execute" }.key
        controller.close(); controller.transition("tasks.execute"); idle(controller)
        checkpoint("restart"); upstream = OkHttpTransport()
        val resumed = connect(); resumed.refresh(); idle(resumed)
        assertEquals(6, resumed.state.value.records.size); assertEquals("unknown", resumed.state.value.tasks.single { it.id == id }.status)
        resumed.recover(original); idle(resumed); assertEquals(6, posts)
        resumed.review(id); idle(resumed); assertEquals(listOf("tasks.reconcile"), resumed.state.value.reviewed?.allowedActions)
        resumed.transition("tasks.reconcile"); idle(resumed); checkpoint("complete")
        repeat(40) { if (resumed.state.value.tasks.single { it.id == id }.status != "succeeded") { delay(100); resumed.refresh(); idle(resumed) } }
        assertEquals("succeeded", resumed.state.value.tasks.single { it.id == id }.status)
        resumed.submit { OtaChanges.revoke(trust) }; idle(resumed)
        assertEquals(8, resumed.state.value.records.size); assertTrue(resumed.state.value.records.all { it.result != null }); assertFalse(resumed.state.value.trusts.single().active); assertEquals(8, posts)
        File(env.getValue("LIMEIOT_OTA_TRACE")).writeText("""{"passed":true,"posts":$posts,"original_records":8,"host_ui_state":true,"hardware":false,"native_app_runtime":false}""")
    }
}
