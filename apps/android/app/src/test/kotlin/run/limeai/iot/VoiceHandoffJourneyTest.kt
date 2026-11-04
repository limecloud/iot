package run.limeai.iot

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assume.assumeTrue
import run.limeai.iot.core.*
import kotlin.test.*

class VoiceHandoffJourneyTest {
    @Test fun explicitStagesRecordingToSpeechAndRestartOnlyRead() = runBlocking {
        val env = System.getenv(); assumeTrue(env["LIMEIOT_VOICE_NATIVE_PHASE"] != null)
        val phase = env.getValue("LIMEIOT_VOICE_NATIVE_PHASE"); val directory = File(env.getValue("LIMEIOT_VOICE_NATIVE_STORE")); val space = "space-demo"
        val vault = object : SessionStore {
            fun file(origin: String): File {
                val name = listOf("media-operations", "audio-transcriptions", "text-generations", "speech-syntheses").first { origin.endsWith("#$it") }
                return File(directory, "$name.json")
            }
            override suspend fun load(origin: String) = file(origin).takeIf { it.isFile }?.readText()
            override suspend fun save(origin: String, value: String?) {
                checkNotNull(value); val file = file(origin)
                if (!file.exists()) Files.createFile(file.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
                FileOutputStream(file).use { it.write(value.toByteArray()); it.fd.sync() }
            }
        }
        val upstream = OkHttpTransport(); val posts = mutableListOf<String>()
        val wire = GatewayTransport { request ->
            if (request.method == "POST" && !request.url.endsWith("/auth/session")) posts += request.url.substringAfterLast('/')
            upstream.send(request)
        }
        val gateway = GatewayClient(env.getValue("LIMEIOT_ENDPOINT"), wire, allowLoopbackHTTP = true); gateway.login(env.getValue("LIMEIOT_TOKEN"))
        val media = MediaController(MediaClient(gateway, vault), space, this) { throw it }
        val transcription = TranscriptionController(TranscriptionClient(gateway, vault), MediaClient(gateway, vault), space, this) { throw it }
        val text = TextGenerationController(TextGenerationClient(gateway, vault), space, this, { throw it })
        val speech = SpeechController(SpeechClient(gateway, vault), space, this, { throw it }) { media.useGenerated(it) }
        media.refresh(); media.waitForIdle(); transcription.refresh(); transcription.waitForIdle(); text.refresh(); text.waitForIdle(); speech.refresh(); speech.waitForIdle()
        assertTrue(media.state.value.ready && transcription.state.value.ready && text.state.value.ready && speech.state.value.ready)
        var starts = 0; var closes = 0; lateinit var push: (ShortArray, Int) -> Unit
        val input = object : RecordingInput {
            override fun start(samples: (ShortArray, Int) -> Unit, interrupted: () -> Unit) { starts++; push = samples }
            override fun close() { closes++ }
        }
        val capture = RecordingController(this, { input }, media::selectRecording, media::clearRecording); capture.setAvailable(true)
        if (phase == "create") {
            val epoch = capture.request()!!; capture.authorize(epoch, true)
            withTimeout(5000) { while (capture.state.value.phase != RecordingPhase.RECORDING) delay(5) }
            repeat(10) { push(ShortArray(1600) { 321 }, 1600) }; capture.finish()
            withTimeout(5000) { while (capture.state.value.busy) delay(5) }
            assertEquals(1, closes); assertEquals("recording.wav", media.state.value.fileName); assertTrue(posts.isEmpty())
            media.setRetention(600); media.upload(); media.waitForIdle(); assertTrue(media.state.value.ready)
            val source = media.state.value.records.first { it.type == "media.upload" }.result!!.getValue("result").jsonObject.getValue("media").jsonObject.getValue("media_id").jsonPrimitive.content
            transcription.refresh(); transcription.waitForIdle(); transcription.selectMedia(source); transcription.selectLanguage("zh"); transcription.generate(); transcription.waitForIdle()
            withTimeout(20000) { while (transcription.state.value.records.lastOrNull()?.status != "succeeded") { transcription.poll(); transcription.waitForIdle(); delay(50) } }
            val recognized = transcription.state.value.text(transcription.state.value.records.last().key)!!; val beforeText = posts.size
            assertTrue(text.prepareQuestion(recognized)); assertEquals(recognized, text.state.value.prompt); assertTrue(text.state.value.messages.isEmpty()); assertEquals(beforeText, posts.size)
            text.generate(); text.waitForIdle()
            withTimeout(20000) { while (text.state.value.records.lastOrNull()?.status != "succeeded") { text.poll(); text.waitForIdle(); delay(50) } }
            val answer = text.state.value.text(text.state.value.records.last().key)!!; val beforeSpeech = posts.size
            assertTrue(speech.prepareAnswer(answer)); assertEquals(answer, speech.state.value.text); assertEquals(beforeSpeech, posts.size)
            speech.generate(); speech.waitForIdle()
            withTimeout(20000) { while (speech.state.value.records.lastOrNull()?.status != "succeeded") { speech.poll(); speech.waitForIdle(); delay(50) } }
            assertEquals(speech.state.value.records.last().mediaId, media.state.value.selectedMedia); assertFalse(media.state.value.approved); assertTrue(gateway.snapshot().commands.items.isEmpty())
            media.approve(true); media.grant(); media.waitForIdle(); assertTrue(media.state.value.ready); assertFalse(media.state.value.approved)
            val device = gateway.snapshot().devices.single { it.deviceId == "device-lamp" }
            var command = gateway.create(space, CommandIntent.create(device, "playback.play", buildJsonObject { put("media_id", speech.state.value.records.last().mediaId!!) }, type = "action.invoke"))
            repeat(50) { if (command.status != "confirmed") { delay(100); command = gateway.command(space, command.commandId) } }; assertEquals("confirmed", command.status)
        } else {
            assertEquals(0, starts); assertEquals("", text.state.value.prompt); assertTrue(text.state.value.messages.isEmpty()); assertEquals("", speech.state.value.text)
            assertTrue(transcription.state.value.outputs.isEmpty() && text.state.value.outputs.isEmpty()); assertFalse(media.state.value.approved); assertTrue(media.state.value.page!!.grants.none { it.active })
            for (record in media.state.value.records) { media.recover(record.key); media.waitForIdle() }
            transcription.recover(transcription.state.value.records.single().key); transcription.waitForIdle(); text.recover(text.state.value.records.single().key); text.waitForIdle(); speech.recover(speech.state.value.records.single().key); speech.waitForIdle()
            assertEquals("", text.state.value.prompt); assertEquals("", speech.state.value.text); assertFalse(media.state.value.approved); assertTrue(text.state.value.messages.isEmpty()); assertTrue(posts.isEmpty())
        }
        assertEquals(1, transcription.state.value.records.size); assertEquals(1, text.state.value.records.size); assertEquals(1, speech.state.value.records.size); assertEquals(2, media.state.value.records.size)
        val trace = buildJsonObject {
            put("passed", true); put("phase", phase); put("posts", JsonArray(posts.map(::JsonPrimitive))); put("recording_starts", starts); put("recording_closes", closes)
            put("transcription_key", transcription.state.value.records.single().key); put("text_key", text.state.value.records.single().key); put("speech_key", speech.state.value.records.single().key); put("generated_media", speech.state.value.records.single().mediaId!!)
            put("host_ui_state", true); put("system_microphone", false); put("native_app_runtime", false)
        }
        capture.close(); media.close(); transcription.close(); text.close(); speech.close()
        File(env.getValue("LIMEIOT_VOICE_NATIVE_TRACE")).writeText(trace.toString())
    }
}
