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

private class CompanionFileStore(private val file: File) : SessionStore {
    override suspend fun load(origin: String): String? { check(origin.endsWith("#companion:space-demo")); return if (file.isFile) file.readText() else null }
    override suspend fun save(origin: String, value: String?) {
        check(origin.endsWith("#companion:space-demo") && value != null)
        if (!file.exists()) Files.createFile(file.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
        FileChannel.open(file.toPath(), StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING).use { channel -> val bytes = ByteBuffer.wrap(value.toByteArray()); while (bytes.hasRemaining()) channel.write(bytes); channel.force(true) }
    }
}
private class CompanionLiveWire(private val phase: String) : GatewayTransport {
    val upstream = OkHttpTransport(); val posts = mutableListOf<String>(); var lost = false
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        val result = upstream.send(request)
        if (request.method == "POST" && !request.url.endsWith("/auth/session")) {
            val kind = listOf("audio-transcriptions", "text-generations", "speech-syntheses").firstOrNull { request.url.contains("/$it") } ?: error("unexpected endpoint")
            posts += if (request.url.endsWith("/discard")) "discard" else kind
            if (phase == "restore-stop" && request.url.endsWith("/discard") && !lost) { lost = true; throw IOException("actual receipt lost") }
        }
        return result
    }
}
class CompanionJourneyTest {
    @Test fun realGatewayTwoTurnsRecovery() = runBlocking {
        val env = System.getenv(); org.junit.Assume.assumeNotNull(env["LIMEIOT_COMPANION_NATIVE_PHASE"])
        val phase = env.getValue("LIMEIOT_COMPANION_NATIVE_PHASE"); val file = CompanionFileStore(File(env.getValue("LIMEIOT_COMPANION_NATIVE_STORE"))); val w = CompanionLiveWire(phase)
        val g = GatewayClient(env.getValue("LIMEIOT_ENDPOINT"), w, allowLoopbackHTTP = true); g.login(env.getValue("LIMEIOT_TOKEN"))
        val s = CompanionController(CompanionClient(g, file, "space-demo"), "space-demo", this, {})
        s.refresh(); s.waitForIdle(); assertTrue(s.state.value.ready, s.state.value.message); assertNull(s.visible()?.answer); assertNull(s.visible()?.mediaId)
        when (phase) {
            "two-turns" -> {
                s.selectVoice("local"); s.start(); s.waitForIdle(); assertEquals("ready", s.state.value.view?.phase, s.state.value.message); assertTrue(w.posts.isEmpty())
                for (index in 1..2) {
                    s.selectMedia(env.getValue("LIMEIOT_COMPANION_NATIVE_MEDIA")); assertTrue(s.canReply()); s.reply(); s.waitForIdle()
                    withTimeout(15000) { while (s.state.value.view?.phase == "running") { delay(50); s.poll(); s.waitForIdle() } }
                    assertEquals("succeeded", s.state.value.view?.phase, s.state.value.message); assertEquals(env.getValue("LIMEIOT_COMPANION_NATIVE_ANSWER"), s.visible()?.answer); assertNotNull(s.visible()?.mediaId); assertEquals(index, s.state.value.record?.turnCount)
                }
                s.pause(); s.waitForIdle(); s.refresh(); s.waitForIdle(); assertEquals(false, s.state.value.view?.historyAvailable); assertFalse(s.canReply()); assertFalse(s.canContinue()); assertNull(s.visible()?.answer)
            }
            "restore-stop" -> {
                assertEquals(false, s.state.value.view?.historyAvailable); assertFalse(s.canContinue()); assertFalse(s.canReply()); s.poll(); s.waitForIdle(); assertTrue(w.posts.isEmpty())
                s.recover(); s.waitForIdle(); assertEquals(env.getValue("LIMEIOT_COMPANION_NATIVE_ANSWER"), s.visible()?.answer)
                s.requestStop(); s.cancelStop(); s.confirmStop(); assertTrue(w.posts.isEmpty())
                s.requestStop(); s.confirmStop(); s.waitForIdle(); assertFalse(s.state.value.ready); assertNull(s.visible())
                s.recover(); s.waitForIdle(); s.requestStop(); s.confirmStop(); s.waitForIdle(); assertEquals(true, s.state.value.view?.stopSettled); assertNull(s.visible())
            }
            "cleared" -> { s.recover(); s.waitForIdle(); s.poll(); s.waitForIdle(); assertEquals(true, s.state.value.view?.stopSettled); assertNull(s.visible()) }
            else -> fail("invalid phase")
        }
        val expected = when (phase) { "two-turns" -> listOf("audio-transcriptions", "text-generations", "speech-syntheses", "audio-transcriptions", "text-generations", "speech-syntheses"); "restore-stop" -> listOf("discard", "discard"); else -> emptyList() }
        assertEquals(expected, w.posts)
        File(env.getValue("LIMEIOT_COMPANION_NATIVE_TRACE")).writeText(buildJsonObject { put("passed", true); put("phase", phase); put("posts", JsonArray(w.posts.map(::JsonPrimitive))); put("record", s.state.value.record!!.document); put("host_ui_state", true) }.toString())
        s.close(); s.waitForIdle(); Unit
    }
}
