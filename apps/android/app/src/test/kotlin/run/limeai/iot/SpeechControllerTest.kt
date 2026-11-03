package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.time.Instant
import kotlin.test.*

private fun speechFixture(name: String): JsonObject = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/$name.json") }.first { it.isFile }.let { OtaJSON.parse(it.readText(), response = true) }
private class SpeechMemory : SessionStore {
    val data = mutableMapOf<String, String>(); var fail = false; var hold = false; var saves = 0
    override suspend fun load(origin: String) = data[origin]
    override suspend fun save(origin: String, value: String?) { if (fail) throw IOException("fixture storage"); saves++; if (value == null) data.remove(origin) else data[origin] = value; while (hold) delay(5) }
}
private class SpeechStateWire : GatewayTransport {
    val vector = speechFixture("speech/contract"); val media = speechFixture("media/upload"); val targets = speechFixture("media/targets")
    val tasks = mutableMapOf<String, JsonObject>(); var posts = 0; var mediaPosts = 0; var status = 200; var state = "running"; var drop = false
    var hold = false; val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (status != 200) return GatewayResponse(status, """{"error":{"code":"fixture_failure"}}""")
        when {
            request.url.endsWith("/capabilities") -> return GatewayResponse(200, buildJsonObject { put("speech", vector.getValue("capabilities")) }.toString())
            request.url.endsWith("/media") -> return GatewayResponse(200, media.getValue("page").toString())
            request.url.endsWith("/execution-adapters") -> return GatewayResponse(200, targets.getValue("page").toString())
            request.url.endsWith("/execution-binding") -> return GatewayResponse(200, targets.getValue("bindings").jsonObject.getValue(request.url.substringBeforeLast('/').substringAfterLast('/')).toString())
            request.url.endsWith("/media-operations") -> { mediaPosts++; error("unexpected authorization or playback") }
        }
        val discard = request.url.endsWith("/discard")
        val key = request.headers["Idempotency-Key"] ?: if (discard) request.url.substringBeforeLast('/').substringAfterLast('/') else request.url.substringAfterLast('/')
        if (request.method == "POST") {
            posts++
            if (discard) state = "discarded"
            else {
                val input = SpeechRequests.parse(request.body!!); val text = input.getValue("text").jsonPrimitive.content
                tasks[key] = JsonObject(vector.getValue("tasks").jsonObject.getValue("running").jsonObject + buildJsonObject {
                    put("synthesis_id", "speech-$key"); put("idempotency_key", key)
                    put("request_digest", OtaJSON.digest(buildJsonObject { put("space_id", "space-demo"); put("idempotency_key", key); put("input", input) }))
                    put("input_digest", "sha256:" + MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) })
                    put("input_characters", text.codePointCount(0, text.length)); for (name in listOf("voice", "retain_seconds", "expires_at")) put(name, input.getValue(name))
                    val created = Instant.now().toString(); put("created_at", created); put("updated_at", created)
                })
            }
            if (hold) { entered.complete(Unit); withContext(NonCancellable) { release.await() } }
            if (drop) throw IOException("response lost")
        }
        val task = tasks[key] ?: return GatewayResponse(404, """{"error":{"code":"speech_synthesis_not_found"}}""")
        return GatewayResponse(200, JsonObject(task + buildJsonObject {
            put("status", state); if (state != "running") put("updated_at", Instant.now().toString())
            put("media_id", if (state == "succeeded") JsonPrimitive("media-original") else JsonNull)
            put("error_code", when (state) { "unknown" -> JsonPrimitive("speech_interrupted"); "discarded" -> JsonPrimitive("speech_output_discarded"); else -> JsonNull })
        }).toString())
    }
}
private suspend fun connectSpeech(scope: CoroutineScope, memory: SpeechMemory, wire: SpeechStateWire, onAuth: (Exception) -> Unit = {}, selected: MutableList<String> = mutableListOf()): Pair<SpeechController, MediaController> {
    val gateway = GatewayClient("https://nas.local", wire); gateway.login("fixture")
    val media = MediaController(MediaClient(gateway, memory), "space-demo", scope, {})
    media.refresh(); media.waitForIdle()
    val speech = SpeechController(SpeechClient(gateway, memory), "space-demo", scope, onAuth) { id -> selected += id; media.useGenerated(id) }
    speech.refresh(); speech.waitForIdle(); return speech to media
}
class SpeechControllerTest {
    @Test fun selectionAndGenerationRequireSeparateMediaAuthorization() = runBlocking {
        val wire = SpeechStateWire(); val selected = mutableListOf<String>(); val (speech, media) = connectSpeech(this, SpeechMemory(), wire, selected = selected)
        speech.setText("青柠🍋萌宠"); speech.selectVoice("other"); speech.setRetention(3600)
        assertTrue(speech.state.value.canGenerate); assertEquals(0, wire.posts); media.approve(true)
        speech.generate(); speech.waitForIdle(); assertEquals("", speech.state.value.text); assertEquals("running", speech.state.value.records.single().status); assertFalse(speech.state.value.canGenerate)
        wire.state = "succeeded"; speech.poll(); speech.waitForIdle()
        assertEquals(listOf("media-original"), selected); assertEquals("media-original", media.state.value.selectedMedia); assertFalse(media.state.value.approved)
        assertEquals(0, wire.mediaPosts); assertEquals(1, wire.posts)
    }
    @Test fun invalidInputAndOfflineBackgroundCloseNeverWrite() = runBlocking {
        val wire = SpeechStateWire(); val (speech, _) = connectSpeech(this, SpeechMemory(), wire)
        speech.setText("bad\rtext"); speech.generate(); assertTrue(speech.state.value.ready); assertTrue(speech.state.value.message.isNotEmpty())
        speech.setText("私密正文"); speech.setOnline(false); speech.generate(); assertEquals("", speech.state.value.text); assertFalse(speech.state.value.ready)
        speech.setOnline(true); speech.refresh(); speech.waitForIdle(); speech.setText("后台正文"); speech.pause(); assertEquals("", speech.state.value.text)
        speech.close(); speech.setOnline(true); speech.refresh(); speech.setText("closed"); speech.generate(); assertFalse(speech.state.value.ready); assertEquals("", speech.state.value.text); assertEquals(0, wire.posts)
    }
    @Test fun lostResponseRecoversOnlyOriginalAndDiscardRequiresConfirmation() = runBlocking {
        val memory = SpeechMemory(); val wire = SpeechStateWire(); val (speech, _) = connectSpeech(this, memory, wire)
        wire.drop = true; speech.setText("丢失响应"); speech.generate(); speech.waitForIdle()
        assertFalse(speech.state.value.ready); assertNull(speech.state.value.records.single().result)
        wire.drop = false; wire.state = "unknown"; val (restored, _) = connectSpeech(this, memory, wire)
        assertTrue(restored.state.value.pending); assertFalse(restored.state.value.canGenerate)
        val key = restored.state.value.records.single().key
        restored.requestDiscard(key); restored.cancelDiscard(); restored.confirmDiscard(); assertEquals(1, wire.posts)
        restored.requestDiscard(key); restored.confirmDiscard(); restored.waitForIdle(); assertEquals("discarded", restored.state.value.records.single().status); assertEquals(2, wire.posts)
    }
    @Test fun lateResponseCannotSelectMediaAfterPause() = runBlocking {
        val selected = mutableListOf<String>(); val memory = SpeechMemory(); val wire = SpeechStateWire(); val (speech, _) = connectSpeech(this, memory, wire, selected = selected)
        wire.hold = true; speech.setText("迟到输出"); speech.generate(); withTimeout(5000) { wire.entered.await() }
        speech.pause(); wire.state = "succeeded"; wire.release.complete(Unit); speech.waitForIdle()
        assertFalse(speech.state.value.ready); assertEquals("", speech.state.value.text); assertTrue(selected.isEmpty())
        speech.refresh(); speech.waitForIdle(); assertTrue(speech.state.value.ready); assertEquals(1, wire.posts)
    }
    @Test fun failedOrCancelledOriginalSaveHasZeroPosts() = runBlocking {
        for (cancel in listOf(false, true)) {
            val memory = SpeechMemory(); val wire = SpeechStateWire(); val (speech, _) = connectSpeech(this, memory, wire)
            if (cancel) memory.hold = true else memory.fail = true
            speech.setText("保存后取消"); speech.generate()
            if (cancel) { withTimeout(5000) { while (memory.saves == 0) delay(1) }; speech.pause() }
            speech.waitForIdle(); memory.hold = false; assertEquals(0, wire.posts); assertFalse(speech.state.value.ready)
            if (cancel) { speech.refresh(); speech.waitForIdle(); assertTrue(speech.state.value.ready); assertTrue(speech.state.value.pending); assertEquals(0, wire.posts) }
        }
    }
    @Test fun readFailurePreservesObservationsAnd401ReachesSessionHandler() = runBlocking {
        var auth = 0; val wire = SpeechStateWire(); val (speech, _) = connectSpeech(this, SpeechMemory(), wire, { auth++ })
        speech.setText("产生原记录"); speech.generate(); speech.waitForIdle(); val observed = speech.state.value.records
        wire.status = 500; speech.refresh(); speech.waitForIdle(); assertFalse(speech.state.value.ready); assertEquals(observed, speech.state.value.records)
        wire.status = 401; speech.refresh(); speech.waitForIdle(); assertEquals(1, auth); assertEquals("", speech.state.value.text)
    }
    @Test fun generatedSelectionWaitsForMediaAndAlwaysClearsApproval() = runBlocking {
        val wire = SpeechStateWire(); val (speech, media) = connectSpeech(this, SpeechMemory(), wire)
        media.approve(true); media.useGenerated("missing-media"); assertEquals("", media.state.value.selectedMedia); assertFalse(media.state.value.approved)
        media.approve(true); media.useGenerated("media-original"); assertEquals("media-original", media.state.value.selectedMedia); assertFalse(media.state.value.approved)
        speech.close(); media.close(); assertEquals(0, wire.posts); assertEquals(0, wire.mediaPosts)
    }
}
