package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.io.File
import java.time.Instant
import kotlin.test.*

private fun companionStateFixture(): JsonObject = System.getenv("LIMEIOT_COMPANION_FIXTURE")?.let(::File)?.let { OtaJSON.parse(it.readText(), response = true) }
    ?: generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/companions/contract.json") }.first { it.isFile }.let { OtaJSON.parse(it.readText(), response = true) }
private class CompanionStateMemory(var raw: String?) : SessionStore {
    override suspend fun load(origin: String) = raw
    override suspend fun save(origin: String, value: String?) { raw = value }
}
private class CompanionStateWire(val f: JsonObject) : GatewayTransport {
    val posts = mutableListOf<String>(); val cleared = mutableSetOf<Int>()
    var hold = false; val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (request.url.endsWith("/capabilities")) return GatewayResponse(200, f.getValue("capabilities").toString())
        if (request.url.endsWith("/media")) return GatewayResponse(200, f.getValue("media").toString())
        val kind = mapOf("transcription" to "audio-transcriptions", "text" to "text-generations", "speech" to "speech-syntheses").entries.firstOrNull { request.url.contains("/" + it.value) }?.key ?: error("unexpected endpoint")
        val key = request.headers.entries.firstOrNull { it.key.equals("Idempotency-Key", true) }?.value ?: request.url.substringAfter("/by-key/")
        val index = if (key.contains("_t2-")) 2 else 1
        if (request.method == "POST") {
            val stopped = request.url.endsWith("/discard")
            posts += if (stopped) "discard$index" else kind
            if (stopped) cleared += index
            if (hold && kind == "text") { entered.complete(Unit); withContext(NonCancellable) { release.await() } }
        }
        return GatewayResponse(200, (if (index in cleared && kind == "text") f.getValue("cleared").jsonObject.getValue(index.toString()) else f.getValue("tasks").jsonObject.getValue(index.toString()).jsonObject.getValue(kind)).toString())
    }
}
class CompanionControllerTest {
    @Test fun explicitContinuationTwoTurnsBackgroundRecoveryAndStop() = runTest {
        val f = companionStateFixture(); val m = CompanionStateMemory(f.getValue("ready").toString()); val w = CompanionStateWire(f); val g = GatewayClient("https://nas.local", w); g.login("fixture")
        val now = Instant.ofEpochMilli(f.getValue("now").jsonPrimitive.long)
        val c = CompanionClient(g, m, "space-demo", CompanionPolicy.parse(f.getValue("policy").toString()), emptyList()) { now }
        val s = CompanionController(c, "space-demo", this, {}) { now }
        s.refresh(); s.waitForIdle(); assertTrue(s.canContinue()); assertNull(s.visible()?.answer)
        s.poll(); s.waitForIdle(); assertTrue(w.posts.isEmpty())
        s.continueSession(); s.waitForIdle(); assertNotNull(s.visible()?.answer); assertNotNull(s.visible()?.mediaId)
        val media = f.getValue("prepared_slot").jsonObject.getValue("turns").jsonArray[0].jsonObject.getValue("media_id").jsonPrimitive.content
        s.selectMedia(media); s.reply(); s.waitForIdle(); assertEquals(0, s.state.value.view?.turnsRemaining); assertFalse(s.canReply())
        s.pause(); assertNull(s.visible()); assertFalse(s.state.value.ready); assertEquals("", s.state.value.selectedMedia)
        s.refresh(); s.waitForIdle(); assertEquals(false, s.state.value.view?.historyAvailable); assertFalse(s.canReply()); assertFalse(s.canContinue()); assertNull(s.visible()?.answer)
        s.requestStop(); s.cancelStop(); s.confirmStop(); s.waitForIdle(); assertEquals(listOf("text", "speech", "transcription", "text", "speech"), w.posts)
        s.recover(); s.waitForIdle(); assertNotNull(s.visible()?.answer)
        s.requestStop(); s.confirmStop(); s.waitForIdle(); assertEquals(true, s.state.value.view?.stopSettled); assertNull(s.visible())
        s.setOnline(false); s.recover(); s.waitForIdle(); assertEquals(listOf("text", "speech", "transcription", "text", "speech", "discard1", "discard2"), w.posts)
        s.close(); s.setOnline(true); s.refresh(); s.waitForIdle(); assertFalse(s.state.value.ready)
    }
    @Test fun lateResponseCannotRestoreContextOrStartSpeech() = runTest {
        val f = companionStateFixture(); val m = CompanionStateMemory(f.getValue("ready").toString()); val w = CompanionStateWire(f); val g = GatewayClient("https://nas.local", w); g.login("fixture")
        val now = Instant.ofEpochMilli(f.getValue("now").jsonPrimitive.long)
        val c = CompanionClient(g, m, "space-demo", CompanionPolicy.parse(f.getValue("policy").toString()), emptyList()) { now }
        val s = CompanionController(c, "space-demo", this, {}) { now }
        s.refresh(); s.waitForIdle(); w.hold = true; s.continueSession(); w.entered.await(); s.pause(); w.release.complete(Unit); s.waitForIdle()
        assertNull(s.visible()); assertEquals(listOf("text"), w.posts)
        w.hold = false; s.refresh(); s.waitForIdle(); assertEquals(false, s.state.value.view?.historyAvailable); assertFalse(s.canContinue()); assertNull(s.visible()?.answer)
        s.poll(); s.waitForIdle(); assertEquals(listOf("text"), w.posts); s.close(); s.waitForIdle()
    }
}
