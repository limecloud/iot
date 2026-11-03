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

class TranscriptionJourneyTest {
    @Test fun originalRecoveryGatewayRestartUnknownAndSourceDeletion() = runBlocking {
        val env = System.getenv(); assumeTrue(env["LIMEIOT_TRANSCRIPTION_STATE_CHECK"] == "1")
        val phase = env.getValue("LIMEIOT_TRANSCRIPTION_PHASE"); val space = "space-demo"
        val vault = object : SessionStore {
            fun file(origin: String): File { check(origin.endsWith("#audio-transcriptions")); return File(env.getValue("LIMEIOT_TRANSCRIPTION_STORE"), "audio-transcriptions.json") }
            override suspend fun load(origin: String) = file(origin).let { if (it.isFile) it.readText() else null }
            override suspend fun save(origin: String, value: String?) {
                checkNotNull(value); val file = file(origin)
                if (!file.exists()) Files.createFile(file.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
                FileOutputStream(file).use { it.write(value.toByteArray()); it.fd.sync() }
            }
        }
        val upstream = OkHttpTransport(); var posts = 0; var otherPosts = 0
        val wire = object : GatewayTransport {
            override suspend fun send(request: GatewayRequest): GatewayResponse {
                val result = upstream.send(request)
                if (request.method == "POST" && !request.url.endsWith("/auth/session")) {
                    if (request.url.contains("/audio-transcriptions")) { posts++; if (phase == "create" && request.url.endsWith("/audio-transcriptions")) throw IOException("response lost") }
                    else otherPosts++
                }
                return result
            }
        }
        val gateway = GatewayClient(env.getValue("LIMEIOT_ENDPOINT"), wire, allowLoopbackHTTP = true); gateway.login(env.getValue("LIMEIOT_TOKEN"))
        val controller = TranscriptionController(TranscriptionClient(gateway, vault), MediaClient(gateway, vault), space, this, {})
        controller.refresh(); controller.waitForIdle(); assertTrue(controller.state.value.ready); assertTrue(controller.state.value.outputs.isEmpty())
        val source = env.getValue("LIMEIOT_TRANSCRIPTION_MEDIA")
        when (phase) {
            "create" -> {
                controller.selectMedia(source); controller.generate(); controller.waitForIdle()
                assertFalse(controller.state.value.ready); assertEquals(1, controller.state.value.records.size); assertNull(controller.state.value.records.single().observation)
                controller.recover(controller.state.value.records.single().key); controller.waitForIdle()
                withTimeout(10000) { while (controller.state.value.records.single().status != "succeeded") { delay(50); controller.poll(); controller.waitForIdle() } }
                assertEquals("你好，这是本地识别结果。", controller.state.value.text(controller.state.value.records.single().key))
                controller.pause(); assertTrue(controller.state.value.outputs.isEmpty())
                controller.refresh(); controller.waitForIdle(); assertTrue(controller.state.value.outputs.isEmpty())
            }
            "restore" -> {
                assertEquals(1, controller.state.value.records.size); assertEquals("succeeded", controller.state.value.records.single().status)
                controller.recover(controller.state.value.records.single().key); controller.waitForIdle(); assertEquals("你好，这是本地识别结果。", controller.state.value.text(controller.state.value.records.single().key))
            }
            "unknown-start" -> {
                controller.selectMedia(source); controller.generate(); controller.waitForIdle(); assertEquals(2, controller.state.value.records.size)
                assertEquals("running", controller.state.value.records.last().status); assertFalse(controller.state.value.canGenerate)
            }
            "unknown-restore" -> {
                assertEquals(2, controller.state.value.records.size); assertEquals("unknown", controller.state.value.records.last().status); assertTrue(controller.state.value.pending)
                controller.selectMedia(source); controller.generate(); assertEquals(0, posts)
                val key = controller.state.value.records.last().key; controller.requestDiscard(key); controller.cancelDiscard(); controller.confirmDiscard(); assertEquals(0, posts)
                controller.requestDiscard(key); controller.confirmDiscard(); controller.waitForIdle(); assertEquals("discarded", controller.state.value.records.last().status); assertTrue(controller.state.value.outputs.isEmpty())
            }
            "cleared" -> {
                assertTrue(controller.state.value.sources.isEmpty()); controller.recover(controller.state.value.records.first().key); controller.waitForIdle()
                assertEquals("succeeded", controller.state.value.records.first().status); assertTrue(controller.state.value.outputs.isEmpty())
            }
            else -> error("invalid phase")
        }
        assertEquals(if (phase in listOf("create", "unknown-start", "unknown-restore")) 1 else 0, posts); assertEquals(0, otherPosts)
        val trace = buildJsonObject {
            put("passed", true); put("phase", phase); put("host_ui_state", true); put("transcription_posts", posts); put("other_posts", otherPosts)
            put("records", JsonArray(controller.state.value.records.map { record -> buildJsonObject { put("original", record.original); put("observation", record.observation ?: JsonNull); put("discard_intents", JsonArray(record.discardIntents.map(::JsonPrimitive))) } }))
        }
        File(env.getValue("LIMEIOT_TRANSCRIPTION_TRACE")).writeText(OtaJSON.canonical(trace)); controller.close(); assertTrue(controller.state.value.outputs.isEmpty())
    }
}
