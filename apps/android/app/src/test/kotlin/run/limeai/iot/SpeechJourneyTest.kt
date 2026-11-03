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

class SpeechJourneyTest {
    @Test fun originalRecoveryExplicitPlaybackAndGatewayRestart() = runBlocking {
        val env = System.getenv(); assumeTrue(env["LIMEIOT_SPEECH_STATE_CHECK"] == "1")
        val phase = env.getValue("LIMEIOT_SPEECH_PHASE"); val space = "space-demo"
        val vault = object : SessionStore {
            fun file(origin: String): File { val suffix = listOf("speech-syntheses", "media-operations").first { origin.endsWith("#$it") }; return File(env.getValue("LIMEIOT_SPEECH_STORE"), "$suffix.json") }
            override suspend fun load(origin: String) = file(origin).let { if (it.isFile) it.readText() else null }
            override suspend fun save(origin: String, value: String?) {
                checkNotNull(value); val file = file(origin)
                if (!file.exists()) Files.createFile(file.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
                FileOutputStream(file).use { it.write(value.toByteArray()); it.fd.sync() }
            }
        }
        val upstream = OkHttpTransport(); var speechPosts = 0; var mediaPosts = 0
        val wire = object : GatewayTransport {
            override suspend fun send(request: GatewayRequest): GatewayResponse {
                val result = upstream.send(request)
                if (request.method == "POST") {
                    if (request.url.contains("/speech-syntheses")) { speechPosts++; if (phase == "create" && request.url.endsWith("/speech-syntheses")) throw IOException("response lost") }
                    if (request.url.endsWith("/media-operations")) mediaPosts++
                }
                return result
            }
        }
        val gateway = GatewayClient(env.getValue("LIMEIOT_ENDPOINT"), wire, allowLoopbackHTTP = true); gateway.login(env.getValue("LIMEIOT_TOKEN"))
        val media = MediaController(MediaClient(gateway, vault), space, this, {}); media.refresh(); media.waitForIdle()
        val selected = mutableListOf<String>()
        val speech = SpeechController(SpeechClient(gateway, vault), space, this, {}) { id -> selected += id; media.useGenerated(id) }
        speech.refresh(); speech.waitForIdle(); assertTrue(speech.state.value.ready); assertTrue(media.state.value.ready)
        when (phase) {
            "create" -> {
                speech.setText("原生青柠萌宠欢迎回家。"); speech.generate(); speech.waitForIdle()
                assertFalse(speech.state.value.ready); assertEquals(1, speech.state.value.records.size); assertNull(speech.state.value.records.single().result)
                speech.recover(speech.state.value.records.single().key); speech.waitForIdle()
                withTimeout(10000) { while (speech.state.value.records.single().status != "succeeded") { delay(50); speech.poll(); speech.waitForIdle() } }
                assertEquals(1, selected.size); assertEquals(selected.single(), media.state.value.selectedMedia); assertFalse(media.state.value.approved)
                media.grant(); media.waitForIdle(); assertEquals(0, mediaPosts)
                media.approve(true); media.grant(); media.waitForIdle(); assertTrue(media.state.value.ready); assertFalse(media.state.value.approved)
                val snapshot = gateway.snapshot(); assertTrue(snapshot.commands.items.isEmpty())
                val device = snapshot.devices.first { it.deviceId == "device-lamp" }
                var command = gateway.create(space, CommandIntent.create(device, "playback.play", buildJsonObject { put("media_id", selected.single()) }, type = "action.invoke"))
                withTimeout(10000) { while (command.status != "confirmed") { delay(100); command = gateway.command(space, command.commandId) } }
            }
            "restore" -> {
                assertEquals(1, speech.state.value.records.size); assertEquals("succeeded", speech.state.value.records.single().status)
                assertTrue(media.state.value.page!!.grants.all { !it.active })
                speech.recover(speech.state.value.records.single().key); speech.waitForIdle(); assertTrue(speech.state.value.ready); assertEquals(1, selected.size); assertFalse(media.state.value.approved)
            }
            "unknown-start" -> {
                speech.setText("hold"); speech.generate(); speech.waitForIdle(); assertEquals(2, speech.state.value.records.size)
                assertEquals("running", speech.state.value.records.last().status); assertFalse(speech.state.value.canGenerate)
            }
            "unknown-restore" -> {
                assertEquals(2, speech.state.value.records.size); assertEquals("unknown", speech.state.value.records.last().status); assertTrue(speech.state.value.pending); assertFalse(speech.state.value.canGenerate)
                speech.setText("replacement"); speech.generate(); assertEquals(0, speechPosts)
                val key = speech.state.value.records.last().key; speech.requestDiscard(key); speech.cancelDiscard(); speech.confirmDiscard(); assertEquals(0, speechPosts)
                speech.requestDiscard(key); speech.confirmDiscard(); speech.waitForIdle(); assertEquals("discarded", speech.state.value.records.last().status); assertTrue(selected.isEmpty())
            }
            else -> error("unknown phase")
        }
        assertEquals(if (phase in listOf("create", "unknown-start", "unknown-restore")) 1 else 0, speechPosts)
        assertEquals(if (phase == "create") 1 else 0, mediaPosts)
        val trace = buildJsonObject {
            put("passed", true); put("phase", phase); put("host_ui_state", true); put("speech_posts", speechPosts); put("media_posts", mediaPosts); put("approved", media.state.value.approved)
            put("selected", JsonArray(selected.map(::JsonPrimitive)))
            put("records", JsonArray(speech.state.value.records.map { record -> buildJsonObject { put("original", record.original); put("result", record.result ?: JsonNull); put("discard_intents", JsonArray(record.discardIntents.map(::JsonPrimitive))) } }))
        }
        File(env.getValue("LIMEIOT_SPEECH_TRACE")).writeText(OtaJSON.canonical(trace)); speech.close(); media.close()
    }
}
