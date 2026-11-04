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

private class VoiceFileStore(private val file: File) : SessionStore {
    override suspend fun load(origin: String): String? { check(origin.endsWith("#voice-turns:space-demo")); return if (file.isFile) file.readText() else null }
    override suspend fun save(origin: String, value: String?) {
        check(origin.endsWith("#voice-turns:space-demo") && value != null)
        if (!file.exists()) Files.createFile(file.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
        FileChannel.open(file.toPath(), StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING).use { channel -> val bytes = ByteBuffer.wrap(value.toByteArray()); while (bytes.hasRemaining()) channel.write(bytes); channel.force(true) }
    }
}
private class VoiceLiveWire(private val phase: String) : GatewayTransport {
    val upstream = OkHttpTransport(); val posts = mutableListOf<String>(); var other = 0
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        val result = upstream.send(request)
        if (request.method == "POST" && !request.url.endsWith("/auth/session")) {
            val kind = listOf("audio-transcriptions", "text-generations", "speech-syntheses").firstOrNull { request.url.contains("/$it") } ?: run { other++; error("unexpected effect") }
            posts += if (request.url.endsWith("/discard")) "discard" else kind
            if (phase == "create" && request.url.endsWith("/audio-transcriptions") || phase == "restore-stop" && request.url.endsWith("/discard")) throw IOException("actual receipt lost")
        }
        return result
    }
}
class VoiceTurnJourneyTest {
    @Test fun realGatewayTurnRecovery() = runBlocking {
        val env = System.getenv(); org.junit.Assume.assumeNotNull(env["LIMEIOT_VOICE_NATIVE_PHASE"])
        val phase = env.getValue("LIMEIOT_VOICE_NATIVE_PHASE"); val file = VoiceFileStore(File(env.getValue("LIMEIOT_VOICE_NATIVE_STORE"))); val w = VoiceLiveWire(phase)
        val g = GatewayClient(env.getValue("LIMEIOT_ENDPOINT"), w, allowLoopbackHTTP = true); g.login(env.getValue("LIMEIOT_TOKEN"))
        val s = VoiceTurnController(VoiceTurnClient(g, file, "space-demo"), "space-demo", this, {})
        s.refresh(); s.waitForIdle(); assertTrue(s.state.value.ready, s.state.value.message); assertNull(s.visible()?.answer); assertNull(s.visible()?.transcript); assertNull(s.visible()?.mediaId)
        when (phase) {
            "create" -> {
                s.selectMedia(env.getValue("LIMEIOT_VOICE_NATIVE_MEDIA")); s.selectVoice("local"); s.start(); s.waitForIdle(); assertFalse(s.state.value.ready); assertNotNull(s.state.value.record)
                withTimeout(15000) { do { s.recover(); s.waitForIdle(); if (s.state.value.view?.phase == "running") delay(50) } while (s.state.value.view?.phase == "running") }
                assertEquals("ready", s.state.value.view?.phase, s.state.value.message); assertTrue(s.state.value.canContinue)
            }
            "resume" -> {
                assertTrue(s.state.value.canContinue); s.poll(); s.waitForIdle(); assertTrue(w.posts.isEmpty())
                s.continueTurn(); s.waitForIdle()
                withTimeout(15000) { while (s.state.value.view?.phase == "running") { delay(50); s.poll(); s.waitForIdle() } }
                assertEquals("succeeded", s.state.value.view?.phase, s.state.value.message); assertEquals(env.getValue("LIMEIOT_VOICE_NATIVE_ANSWER"), s.visible()?.answer); assertNotNull(s.visible()?.mediaId)
            }
            "restore-stop" -> {
                s.recover(); s.waitForIdle(); assertEquals(env.getValue("LIMEIOT_VOICE_NATIVE_ANSWER"), s.visible()?.answer); assertNotNull(s.visible()?.mediaId)
                s.requestStop(); s.cancelStop(); s.confirmStop(); assertTrue(w.posts.isEmpty())
                s.requestStop(); s.confirmStop(); s.waitForIdle(); assertFalse(s.state.value.ready); assertNull(s.visible())
                s.recover(); s.waitForIdle(); s.requestStop(); s.confirmStop(); s.waitForIdle(); assertEquals("stopped", s.state.value.view?.phase); assertNull(s.visible())
            }
            "cleared" -> { s.recover(); s.waitForIdle(); s.poll(); s.waitForIdle(); assertEquals("stopped", s.state.value.view?.phase); assertNull(s.visible()) }
            else -> fail("invalid phase")
        }
        val expected = when (phase) { "create" -> listOf("audio-transcriptions"); "resume" -> listOf("text-generations", "speech-syntheses"); "restore-stop" -> listOf("discard"); else -> emptyList() }
        assertEquals(expected, w.posts); assertEquals(0, w.other)
        val trace = buildJsonObject { put("passed", true); put("phase", phase); put("posts", JsonArray(w.posts.map(::JsonPrimitive))); put("record", s.state.value.record!!.document); put("host_ui_state", true) }
        File(env.getValue("LIMEIOT_VOICE_NATIVE_TRACE")).writeText(OtaJSON.canonical(trace)); s.close()
    }
}
