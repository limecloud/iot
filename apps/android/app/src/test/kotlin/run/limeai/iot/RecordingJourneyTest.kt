package run.limeai.iot

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assume.assumeTrue
import run.limeai.iot.core.*
import kotlin.test.*

class RecordingJourneyTest {
    @Test fun explicitRecordingUploadAndOriginalRestore() = runBlocking {
        val env = System.getenv(); assumeTrue(env["LIMEIOT_RECORDING_NATIVE_PHASE"] != null)
        val phase = env.getValue("LIMEIOT_RECORDING_NATIVE_PHASE"); val file = File(env.getValue("LIMEIOT_RECORDING_NATIVE_STORE"))
        val vault = object : SessionStore {
            override suspend fun load(origin: String) = if (file.isFile) file.readText() else null
            override suspend fun save(origin: String, value: String?) {
                checkNotNull(value)
                if (!file.exists()) Files.createFile(file.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
                FileOutputStream(file).use { it.write(value.toByteArray()); it.fd.sync() }
            }
        }
        val upstream = OkHttpTransport(); var posts = 0; var gets = 0; var other = 0; var opened = 0; var closed = 0
        val wire = GatewayTransport { request ->
            val response = upstream.send(request)
            if (request.method == "POST" && request.url.endsWith("/media-operations")) { posts++; if (phase == "create") throw IOException("upload receipt lost") }
            else if (request.method == "POST" && !request.url.endsWith("/auth/session")) other++
            if (request.method == "GET" && request.url.contains("/media-operations/by-key/")) gets++
            response
        }
        val gateway = GatewayClient(env.getValue("LIMEIOT_ENDPOINT"), wire, allowLoopbackHTTP = true); gateway.login(env.getValue("LIMEIOT_TOKEN"))
        val media = MediaController(MediaClient(gateway, vault), "space-demo", this) { throw it }
        media.refresh(); media.waitForIdle(); assertTrue(media.state.value.ready)
        lateinit var push: (ShortArray, Int) -> Unit
        val recorder = RecordingController(this, {
            opened++
            object : RecordingInput {
                override fun start(samples: (ShortArray, Int) -> Unit, interrupted: () -> Unit) { push = samples }
                override fun close() { closed++ }
            }
        }, media::selectRecording, media::clearRecording)
        recorder.setAvailable(true)
        if (phase == "create") {
            val epoch = recorder.request()!!; recorder.authorize(epoch, true)
            withTimeout(5000) { while (recorder.state.value.phase != RecordingPhase.RECORDING) delay(5) }
            repeat(10) { push(ShortArray(1600) { 321 }, 1600) }; assertEquals(0, posts)
            recorder.finish()
            withTimeout(5000) { while (recorder.state.value.busy) delay(5) }
            assertEquals(1, closed); assertEquals("recording.wav", media.state.value.fileName); assertEquals(0, posts)
            assertFalse(file.exists())
            media.setRetention(600); media.upload(); media.waitForIdle()
            assertFalse(media.state.value.ready); assertEquals(1, posts); assertNull(media.state.value.records.single().result)
        } else {
            assertEquals(1, media.state.value.records.size); assertEquals("", media.state.value.fileName)
            media.upload(); assertEquals(0, posts); assertEquals(0, opened)
        }
        media.recover(media.state.value.records.single().key); media.waitForIdle()
        assertTrue(media.state.value.ready); assertTrue(gets > 0)
        val record = media.state.value.records.single(); assertNotNull(record.result)
        assertTrue(media.state.value.page!!.grants.isEmpty()); assertTrue(gateway.snapshot().commands.items.isEmpty())
        recorder.close(); media.close(); media.upload(); assertEquals(if (phase == "create") 1 else 0, posts); assertEquals(0, other)
        File(env.getValue("LIMEIOT_RECORDING_NATIVE_TRACE")).writeText(buildJsonObject {
            put("passed", true); put("phase", phase); put("posts", posts); put("other_posts", other); put("gets", gets); put("input_opened", opened); put("input_closed", closed)
            put("original", record.original); put("result", record.result!!); put("host_ui_state", true); put("system_microphone", false); put("native_app_runtime", false)
        }.toString())
    }
}
