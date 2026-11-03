package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.time.Instant
import kotlin.test.*

private fun transcriptionFixture(name: String): JsonObject = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/$name.json") }.first { it.isFile }.let { OtaJSON.parse(it.readText(), response = true) }
private class TranscriptionMemory : SessionStore {
    val data = mutableMapOf<String, String>(); var fail = false; var hold = false; var saves = 0
    override suspend fun load(origin: String) = data[origin]
    override suspend fun save(origin: String, value: String?) { if (fail) throw IOException("fixture storage"); saves++; if (value == null) data.remove(origin) else data[origin] = value; while (hold) delay(5) }
}
private class TranscriptionStateWire : GatewayTransport {
    val vector = transcriptionFixture("transcription/contract"); val media = transcriptionFixture("media/upload")
    val tasks = mutableMapOf<String, JsonObject>(); var posts = 0; var otherPosts = 0; var status = 200; var state = "running"; var drop = false; var sourceAvailable = true; var outputMillis = 600000L
    var hold = false; val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (status != 200) return GatewayResponse(status, """{"error":{"code":"fixture_failure"}}""")
        if (request.url.endsWith("/capabilities")) return GatewayResponse(200, buildJsonObject { put("transcription", vector.getValue("capabilities")) }.toString())
        if (request.url.endsWith("/media")) {
            val metadata = JsonObject(media.getValue("operation").jsonObject.getValue("result").jsonObject.getValue("media").jsonObject + buildJsonObject { put("created_at", Instant.now().toString()); put("expires_at", Instant.now().plusSeconds(600).toString()) })
            return GatewayResponse(200, JsonObject(media.getValue("page").jsonObject + buildJsonObject { put("grants", JsonArray(emptyList())); put("items", JsonArray(listOf(buildJsonObject { put("metadata", metadata); put("available", sourceAvailable); put("deleted_at", JsonNull) }))) }).toString())
        }
        if (!request.url.contains("/audio-transcriptions")) { if (request.method == "POST") otherPosts++; error("unexpected effect") }
        val discard = request.url.endsWith("/discard")
        val key = request.headers["Idempotency-Key"] ?: if (discard) request.url.substringBeforeLast('/').substringAfterLast('/') else request.url.substringAfterLast('/')
        if (request.method == "POST") {
            posts++
            if (discard) state = "discarded"
            else {
                val input = TranscriptionRequests.parse(request.body!!)
                tasks[key] = JsonObject(vector.getValue("tasks").jsonObject.getValue("running").jsonObject + buildJsonObject {
                    put("transcription_id", "transcription-$key"); put("idempotency_key", key); put("input", input)
                    put("request_digest", OtaJSON.digest(buildJsonObject { put("space_id", "space-demo"); put("idempotency_key", key); put("input", input) }))
                    val created = Instant.now().toString(); put("created_at", created); put("updated_at", created)
                })
            }
            if (hold) { entered.complete(Unit); withContext(NonCancellable) { release.await() } }
            if (drop) throw IOException("response lost")
        }
        var task = tasks[key] ?: return GatewayResponse(404, """{"error":{"code":"transcription_not_found"}}""")
        if (task["status"] != JsonPrimitive(state)) {
            task = JsonObject(task + buildJsonObject {
                put("status", state); put("updated_at", Instant.now().toString())
                put("error_code", when (state) { "unknown" -> JsonPrimitive("transcription_interrupted"); "discarded" -> JsonPrimitive("transcription_output_discarded"); else -> JsonNull })
                put("output", if (state == "succeeded") buildJsonObject {
                    val text = "识别结果🍋"; put("text", text); put("content_digest", "sha256:" + MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }); put("expires_at", Instant.now().plusMillis(outputMillis).toString()); put("cleared_at", JsonNull)
                } else JsonNull)
            }); tasks[key] = task
        }
        return GatewayResponse(200, task.toString())
    }
}
private suspend fun connectTranscription(scope: CoroutineScope, memory: TranscriptionMemory, wire: TranscriptionStateWire, onAuth: (Exception) -> Unit = {}): TranscriptionController {
    val gateway = GatewayClient("https://nas.local", wire); gateway.login("fixture")
    val controller = TranscriptionController(TranscriptionClient(gateway, memory), MediaClient(gateway, memory), "space-demo", scope, onAuth)
    controller.refresh(); controller.waitForIdle(); return controller
}
class TranscriptionControllerTest {
    @Test fun explicitSourceAndGenerationNeverAuthorizeOrExecute() = runBlocking {
        val wire = TranscriptionStateWire(); val controller = connectTranscription(this, TranscriptionMemory(), wire)
        assertTrue(controller.state.value.ready); assertFalse(controller.state.value.canGenerate); assertEquals(1, controller.state.value.sources.size)
        controller.selectMedia("media-original"); controller.selectLanguage("en"); controller.selectLanguage("fr")
        assertTrue(controller.state.value.canGenerate); assertEquals("en", controller.state.value.language); assertEquals(0, wire.posts)
        controller.generate(); controller.waitForIdle(); assertTrue(controller.state.value.pending); assertFalse(controller.state.value.canGenerate)
        wire.state = "succeeded"; controller.poll(); controller.waitForIdle()
        assertEquals("识别结果🍋", controller.state.value.text(controller.state.value.records.single().key)); assertEquals(1, wire.posts); assertEquals(0, wire.otherPosts)
    }
    @Test fun backgroundOfflineAndCloseClearTextWhileExplicitQueryCanRestore() = runBlocking {
        val wire = TranscriptionStateWire().apply { state = "succeeded" }; val controller = connectTranscription(this, TranscriptionMemory(), wire)
        controller.selectMedia("media-original"); controller.generate(); controller.waitForIdle(); val key = controller.state.value.records.single().key
        assertNotNull(controller.state.value.text(key)); controller.pause(); assertTrue(controller.state.value.outputs.isEmpty()); assertFalse(controller.state.value.ready)
        controller.refresh(); controller.waitForIdle(); assertNull(controller.state.value.text(key))
        controller.recover(key); controller.waitForIdle(); assertNotNull(controller.state.value.text(key))
        controller.setOnline(false); assertTrue(controller.state.value.outputs.isEmpty())
        controller.close(); controller.setOnline(true); controller.refresh(); controller.generate(); assertFalse(controller.state.value.ready); assertEquals(1, wire.posts)
    }
    @Test fun lostResponseRecoversOnlyOriginalAndDiscardRequiresConfirmation() = runBlocking {
        val memory = TranscriptionMemory(); val wire = TranscriptionStateWire(); val controller = connectTranscription(this, memory, wire)
        wire.drop = true; controller.selectMedia("media-original"); controller.generate(); controller.waitForIdle()
        assertFalse(controller.state.value.ready); assertNull(controller.state.value.records.single().observation)
        wire.drop = false; wire.state = "unknown"; val restored = connectTranscription(this, memory, wire)
        assertTrue(restored.state.value.pending); assertFalse(restored.state.value.canGenerate)
        val key = restored.state.value.records.single().key
        restored.requestDiscard(key); restored.cancelDiscard(); restored.confirmDiscard(); assertEquals(1, wire.posts)
        restored.requestDiscard(key); restored.confirmDiscard(); restored.waitForIdle(); assertEquals("discarded", restored.state.value.records.single().status); assertEquals(2, wire.posts)
    }
    @Test fun lateResponseCannotUpdatePausedUI() = runBlocking {
        val wire = TranscriptionStateWire(); val controller = connectTranscription(this, TranscriptionMemory(), wire)
        wire.hold = true; controller.selectMedia("media-original"); controller.generate(); withTimeout(5000) { wire.entered.await() }
        controller.pause(); wire.state = "succeeded"; wire.release.complete(Unit); controller.waitForIdle()
        assertTrue(controller.state.value.outputs.isEmpty()); assertFalse(controller.state.value.ready)
        controller.refresh(); controller.waitForIdle(); assertTrue(controller.state.value.ready); assertEquals(1, wire.posts)
    }
    @Test fun failedOrCancelledOriginalSaveHasZeroPosts() = runBlocking {
        for (cancel in listOf(false, true)) {
            val memory = TranscriptionMemory(); val wire = TranscriptionStateWire(); val controller = connectTranscription(this, memory, wire)
            if (cancel) memory.hold = true else memory.fail = true
            controller.selectMedia("media-original"); controller.generate()
            if (cancel) { withTimeout(5000) { while (memory.saves == 0) delay(1) }; controller.pause() }
            controller.waitForIdle(); memory.hold = false; assertEquals(0, wire.posts); assertFalse(controller.state.value.ready)
            if (cancel) { controller.refresh(); controller.waitForIdle(); assertTrue(controller.state.value.ready); assertTrue(controller.state.value.pending); assertEquals(0, wire.posts) }
        }
    }
    @Test fun readFailurePreservesObservationsAnd401ClearsText() = runBlocking {
        var auth = 0; val wire = TranscriptionStateWire(); val controller = connectTranscription(this, TranscriptionMemory(), wire) { auth++ }
        controller.selectMedia("media-original"); controller.generate(); controller.waitForIdle(); val observed = controller.state.value.records
        wire.status = 500; controller.refresh(); controller.waitForIdle(); assertFalse(controller.state.value.ready); assertEquals(observed, controller.state.value.records)
        wire.status = 401; controller.refresh(); controller.waitForIdle(); assertEquals(1, auth); assertTrue(controller.state.value.outputs.isEmpty())
    }
    @Test fun expiredTextIsEvicted() = runBlocking {
        val wire = TranscriptionStateWire().apply { state = "succeeded"; outputMillis = 250 }; val controller = connectTranscription(this, TranscriptionMemory(), wire)
        controller.selectMedia("media-original"); controller.generate(); controller.waitForIdle(); val key = controller.state.value.records.single().key
        assertNotNull(controller.state.value.text(key)); delay(300); controller.poll(); assertTrue(controller.state.value.outputs.isEmpty()); assertNull(controller.state.value.text(key))
    }
    @Test fun unavailableSourceClearsSelectionAndText() = runBlocking {
        val wire = TranscriptionStateWire().apply { state = "succeeded" }; val controller = connectTranscription(this, TranscriptionMemory(), wire)
        controller.selectMedia("media-original"); controller.generate(); controller.waitForIdle(); assertTrue(controller.state.value.outputs.isNotEmpty())
        wire.sourceAvailable = false; controller.refresh(); controller.waitForIdle()
        assertTrue(controller.state.value.sources.isEmpty()); assertEquals("", controller.state.value.selectedMedia); assertTrue(controller.state.value.outputs.isEmpty()); assertFalse(controller.state.value.canGenerate)
        controller.recover(controller.state.value.records.single().key); controller.waitForIdle(); assertTrue(controller.state.value.outputs.isEmpty())
    }
}
