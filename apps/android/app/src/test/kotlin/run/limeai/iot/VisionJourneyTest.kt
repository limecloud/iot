package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assume.assumeTrue
import run.limeai.iot.core.*
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import kotlin.test.*

class VisionJourneyTest {
    @Test fun originalRecoveryUnknownAndSuccessfulClearing() = runBlocking {
        val env = System.getenv(); assumeTrue(env["LIMEIOT_VISION_STATE_CHECK"] == "1")
        val phase = env.getValue("LIMEIOT_VISION_PHASE"); val space = "space-demo"
        val vault = object : SessionStore {
            val file = File(env.getValue("LIMEIOT_VISION_STORE"))
            override suspend fun load(origin: String): String? { check(origin.endsWith("#vision-observations")); return if (file.isFile) file.readText() else null }
            override suspend fun save(origin: String, value: String?) {
                check(origin.endsWith("#vision-observations")); checkNotNull(value)
                if (!file.exists()) Files.createFile(file.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
                FileOutputStream(file).use { it.write(value.toByteArray()); it.fd.sync() }
            }
        }
        val upstream = OkHttpTransport(); var posts = 0; var otherPosts = 0
        val wire = object : GatewayTransport {
            override suspend fun send(request: GatewayRequest): GatewayResponse {
                val result = upstream.send(request)
                if (request.method == "POST" && !request.url.endsWith("/auth/session")) {
                    if (request.url.contains("/vision-observations")) { posts++; if (phase == "create" && request.url.endsWith("/vision-observations")) throw IOException("actual receipt lost") } else otherPosts++
                }
                return result
            }
        }
        val gateway = GatewayClient(env.getValue("LIMEIOT_ENDPOINT"), wire, allowLoopbackHTTP = true); gateway.login(env.getValue("LIMEIOT_TOKEN"))
        val controller = VisionController(VisionClient(gateway, vault), space, this, {})
        controller.refresh(); controller.waitForIdle(); assertTrue(controller.state.value.ready); assertTrue(controller.state.value.outputs.isEmpty())
        fun choose() { controller.selectFile("input.png", File(env.getValue("LIMEIOT_VISION_IMAGE")).readBytes()); controller.setPrompt("请观察青柠🍋与é，有什么形状？") }
        when (phase) {
            "create" -> {
                choose(); controller.generate(); controller.waitForIdle(); assertFalse(controller.state.value.ready); assertEquals(1, controller.state.value.records.size); assertNull(controller.state.value.records.single().observation)
                controller.recover(controller.state.value.records.single().key); controller.waitForIdle()
                withTimeout(10000) { while (controller.state.value.records.single().status == "running") { delay(50); controller.poll(); controller.waitForIdle() } }
                assertEquals(env.getValue("LIMEIOT_VISION_TEXT"), controller.state.value.text(controller.state.value.records.single().key))
                controller.pause(); controller.refresh(); controller.waitForIdle(); assertTrue(controller.state.value.outputs.isEmpty())
            }
            "restore" -> { assertEquals(1, controller.state.value.records.size); assertEquals("succeeded", controller.state.value.records.single().status); controller.recover(controller.state.value.records.single().key); controller.waitForIdle(); assertEquals(env.getValue("LIMEIOT_VISION_TEXT"), controller.state.value.text(controller.state.value.records.single().key)) }
            "unknown-start" -> { choose(); controller.generate(); controller.waitForIdle(); assertEquals(2, controller.state.value.records.size); assertEquals("running", controller.state.value.records.last().status); assertFalse(controller.state.value.canGenerate) }
            "unknown-restore" -> {
                assertEquals("unknown", controller.state.value.records.last().status); assertTrue(controller.state.value.pending); choose(); controller.generate(); assertEquals(0, posts)
                val key = controller.state.value.records.last().key; controller.requestDiscard(key); controller.cancelDiscard(); controller.confirmDiscard(); assertEquals(0, posts); controller.requestDiscard(key); controller.confirmDiscard(); controller.waitForIdle(); assertEquals("discarded", controller.state.value.records.last().status)
            }
            "clear" -> {
                val key = controller.state.value.records.first().key; controller.recover(key); controller.waitForIdle(); controller.requestDiscard(key); controller.cancelDiscard(); controller.confirmDiscard(); assertEquals(0, posts); controller.requestDiscard(key); controller.confirmDiscard(); controller.waitForIdle()
                assertTrue(controller.state.value.outputs.isEmpty()); assertEquals("succeeded", controller.state.value.records.first().status); assertFalse(controller.state.value.records.first().canDiscard)
            }
            "cleared-restore" -> { controller.recover(controller.state.value.records.first().key); controller.waitForIdle(); assertTrue(controller.state.value.outputs.isEmpty()); assertFalse(controller.state.value.records.first().canDiscard) }
            else -> error("invalid phase")
        }
        assertEquals(if (phase in listOf("create", "unknown-start", "unknown-restore", "clear")) 1 else 0, posts); assertEquals(0, otherPosts)
        val trace = buildJsonObject {
            put("passed", true); put("phase", phase); put("native_host_library", true); put("host_ui_state", true); put("vision_posts", posts); put("other_posts", otherPosts)
            put("records", JsonArray(controller.state.value.records.map { record -> buildJsonObject { put("original", record.original); put("observation", record.observation ?: JsonNull); put("discard_intents", JsonArray(record.discardIntents.map(::JsonPrimitive))) } }))
        }
        File(env.getValue("LIMEIOT_VISION_TRACE")).writeText(OtaJSON.canonical(trace)); controller.close(); assertTrue(controller.state.value.outputs.isEmpty())
    }
}
