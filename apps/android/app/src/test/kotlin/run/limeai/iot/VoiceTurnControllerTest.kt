package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.io.File
import java.time.Instant
import kotlin.test.*

private fun fixture(): JsonObject = System.getenv("LIMEIOT_VOICE_TURN_FIXTURE")?.let(::File)?.let { OtaJSON.parse(it.readText(), response = true) }
    ?: generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/voice-turns/contract.json") }.first { it.isFile }.let { OtaJSON.parse(it.readText(), response = true) }
private class VoiceStateMemory(var raw: String?) : SessionStore {
    override suspend fun load(origin: String) = raw
    override suspend fun save(origin: String, value: String?) { raw = value }
}
private class VoiceStateWire(val f: JsonObject) : GatewayTransport {
    val posts = mutableListOf<String>(); var cleared = false
    var hold = false; val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (request.url.endsWith("/capabilities")) return GatewayResponse(200, f.getValue("capabilities").toString())
        if (request.url.endsWith("/media")) return GatewayResponse(200, f.getValue("media").toString())
        val kind = mapOf("transcription" to "audio-transcriptions", "text" to "text-generations", "speech" to "speech-syntheses").entries.firstOrNull { request.url.contains("/" + it.value) }?.key ?: error("unexpected effect")
        if (request.method == "POST") {
            posts += if (request.url.endsWith("/discard")) "discard" else kind
            if (request.url.endsWith("/discard")) cleared = true
            if (hold) { entered.complete(Unit); withContext(NonCancellable) { release.await() } }
        }
        return GatewayResponse(200, (if (cleared && kind == "text") f.getValue("cleared_text") else f.getValue("tasks").jsonObject.getValue(kind)).toString())
    }
}
@OptIn(ExperimentalCoroutinesApi::class)
class VoiceTurnControllerTest {
    @Test fun explicitContinueStopAndBackgroundRecovery() = runTest {
        val f = fixture(); val m = VoiceStateMemory(f.getValue("ready").toString()); val w = VoiceStateWire(f); val g = GatewayClient("https://nas.local", w); g.login("fixture")
        val now = Instant.ofEpochMilli(f.getValue("now").jsonPrimitive.long)
        val s = VoiceTurnController(VoiceTurnClient(g, m, "space-demo") { now }, "space-demo", this, {}) { now }
        s.refresh(); s.waitForIdle(); assertTrue(s.state.value.ready); assertTrue(s.state.value.canContinue); assertNull(s.visible()?.transcript)
        s.poll(); s.waitForIdle(); assertTrue(w.posts.isEmpty())
        s.continueTurn(); s.waitForIdle(); assertNotNull(s.visible()?.answer); assertNotNull(s.visible()?.mediaId); assertEquals(listOf("text", "speech"), w.posts)
        s.requestStop(); s.cancelStop(); s.confirmStop(); assertEquals(2, w.posts.size)
        s.pause(); assertNull(s.visible()); assertFalse(s.state.value.ready); assertEquals("", s.state.value.selectedMedia)
        s.refresh(); s.waitForIdle(); assertNull(s.visible()?.answer); assertEquals(2, w.posts.size)
        s.recover(); s.waitForIdle(); assertNotNull(s.visible()?.answer)
        s.requestStop(); s.confirmStop(); s.waitForIdle(); assertEquals("stopped", s.state.value.view?.phase); assertNull(s.visible()); assertEquals(3, w.posts.size)
        s.setOnline(false); s.recover(); s.waitForIdle(); assertEquals(3, w.posts.size)
        s.close(); s.setOnline(true); s.refresh(); s.waitForIdle(); assertFalse(s.state.value.ready)
    }
    @Test fun lateReceiptAfterPauseCannotStartSpeechOrRestoreText() = runTest {
        val f = fixture(); val m = VoiceStateMemory(f.getValue("ready").toString()); val w = VoiceStateWire(f); val g = GatewayClient("https://nas.local", w); g.login("fixture")
        val now = Instant.ofEpochMilli(f.getValue("now").jsonPrimitive.long)
        val s = VoiceTurnController(VoiceTurnClient(g, m, "space-demo") { now }, "space-demo", this, {}) { now }
        s.refresh(); s.waitForIdle(); w.hold = true; s.continueTurn(); w.entered.await(); s.pause(); w.release.complete(Unit)
        advanceUntilIdle()
        assertNull(s.visible()); assertEquals(listOf("text"), w.posts)
        w.hold = false; s.refresh(); s.waitForIdle(); assertEquals("ready", s.state.value.view?.phase); s.poll(); s.waitForIdle(); assertEquals(listOf("text"), w.posts)
        s.close()
    }
}
