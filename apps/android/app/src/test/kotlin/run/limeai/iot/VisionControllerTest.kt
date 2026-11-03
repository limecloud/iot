package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.io.File
import java.io.ByteArrayInputStream
import java.io.IOException
import java.security.MessageDigest
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.Base64
import kotlin.test.*

private fun visionVector(): JsonObject = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/vision/contract.json") }.first { it.isFile }.let { OtaJSON.parse(it.readText(), response = true) }
private fun hash(bytes: ByteArray) = "sha256:" + MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
private fun at() = Instant.now().truncatedTo(ChronoUnit.MILLIS)
private class VisionMemory : SessionStore {
    val data = mutableMapOf<String, String>(); var fail = false; var hold = false; var saves = 0
    override suspend fun load(origin: String) = data[origin]
    override suspend fun save(origin: String, value: String?) { if (fail) throw IOException("fixture storage"); saves++; if (value == null) data.remove(origin) else data[origin] = value; while (hold) delay(5) }
}
private class VisionStateWire : GatewayTransport {
    val vector = visionVector(); val tasks = mutableMapOf<String, JsonObject>()
    var posts = 0; var otherPosts = 0; var status = 200; var state = "running"; var drop = false; var configured = true; var hold = false
    val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (status != 200) return GatewayResponse(status, """{"error":{"code":"fixture_failure"}}""")
        if (request.url.endsWith("/capabilities")) return GatewayResponse(200, buildJsonObject { put("vision", if (configured) vector.getValue("capabilities") else buildJsonObject { put("configured", false); put("capability", "vision.understand") }) }.toString())
        if (!request.url.contains("/vision-observations")) { if (request.method == "POST") otherPosts++; error("unexpected effect") }
        val discard = request.url.endsWith("/discard"); val key = request.headers["Idempotency-Key"] ?: if (discard) request.url.substringBeforeLast('/').substringAfterLast('/') else request.url.substringAfterLast('/')
        if (request.method == "POST") {
            posts++
            if (discard) {
                val task = tasks.getValue(key)
                tasks[key] = if (task["status"] == JsonPrimitive("succeeded")) JsonObject(task + ("output" to JsonObject(task.getValue("output").jsonObject + buildJsonObject { put("text", JsonNull); put("cleared_at", maxOf(at(), Instant.parse(task.getValue("updated_at").jsonPrimitive.content)).toString()) })))
                else { state = "discarded"; JsonObject(task + buildJsonObject { put("status", "discarded"); put("updated_at", at().toString()); put("output", JsonNull); put("error_code", "vision_output_discarded") }) }
            } else {
                val input = VisionRequests.parse(request.body!!); val bytes = Base64.getDecoder().decode(input.getValue("image_base64").jsonPrimitive.content)
                val summary = buildJsonObject { put("image_digest", hash(bytes)); put("image_bytes", bytes.size); put("content_type", input.getValue("content_type")); put("prompt_digest", hash(input.getValue("prompt").jsonPrimitive.content.toByteArray())); put("retain_seconds", input.getValue("retain_seconds")); put("expires_at", input.getValue("expires_at")) }
                val created = at().toString()
                tasks[key] = JsonObject(vector.getValue("tasks").jsonObject.getValue("running").jsonObject + buildJsonObject { put("vision_id", "vision-$key"); put("idempotency_key", key); put("input", summary); put("created_at", created); put("updated_at", created); put("request_digest", OtaJSON.digest(buildJsonObject { put("space_id", "space-demo"); put("idempotency_key", key); put("input", summary) })) })
            }
            if (hold) { entered.complete(Unit); withContext(NonCancellable) { release.await() } }
            if (drop) throw IOException("response lost")
        }
        var task = tasks[key] ?: return GatewayResponse(404, """{"error":{"code":"vision_not_found"}}""")
        if (task["status"] != JsonPrimitive(state)) {
            val updated = maxOf(at(), Instant.parse(task.getValue("created_at").jsonPrimitive.content))
            task = JsonObject(task + buildJsonObject {
                put("status", state); put("updated_at", updated.toString()); put("error_code", when (state) { "unknown" -> JsonPrimitive("vision_interrupted"); "discarded" -> JsonPrimitive("vision_output_discarded"); else -> JsonNull })
                put("output", if (state == "succeeded") buildJsonObject { val text = "观察结果🍋"; put("text", text); put("content_digest", hash(text.toByteArray())); put("expires_at", updated.plusSeconds(600).toString()); put("cleared_at", JsonNull) } else JsonNull)
            }); tasks[key] = task
        }
        return GatewayResponse(200, task.toString())
    }
}
private suspend fun connectVision(scope: CoroutineScope, memory: VisionMemory, wire: VisionStateWire, now: () -> Instant = Instant::now, onAuth: (Exception) -> Unit = {}): VisionController {
    val gateway = GatewayClient("https://nas.local", wire); gateway.login("fixture")
    val controller = VisionController(VisionClient(gateway, memory), "space-demo", scope, onAuth, now); controller.refresh(); controller.waitForIdle(); return controller
}
private fun choose(controller: VisionController) { controller.selectFile("blocks.png", Base64.getDecoder().decode(visionVector().getValue("input").jsonObject.getValue("image_base64").jsonPrimitive.content)); controller.setPrompt("请观察图片") }
class VisionControllerTest {
    @Test fun explicitFileQuestionAndGenerationHaveNoDeviceEffects() = runBlocking {
        val wire = VisionStateWire(); val controller = connectVision(this, VisionMemory(), wire)
        assertTrue(controller.state.value.ready); assertFalse(controller.state.value.canGenerate); choose(controller); assertTrue(controller.state.value.canGenerate)
        controller.generate(); controller.waitForIdle(); assertTrue(controller.state.value.pending); assertFalse(controller.state.value.canGenerate); assertEquals("", controller.state.value.prompt); assertFalse(controller.state.value.hasImage)
        wire.state = "succeeded"; controller.poll(); controller.waitForIdle(); assertEquals("观察结果🍋", controller.state.value.text(controller.state.value.records.single().key)); assertEquals(1, wire.posts); assertEquals(0, wire.otherPosts)
    }
    @Test fun backgroundOfflineAndCloseClearInputAndPlaintext() = runBlocking {
        val wire = VisionStateWire().apply { state = "succeeded" }; val controller = connectVision(this, VisionMemory(), wire); choose(controller); controller.generate(); controller.waitForIdle(); val key = controller.state.value.records.single().key
        choose(controller); controller.pause(); assertTrue(controller.state.value.outputs.isEmpty()); assertEquals("", controller.state.value.prompt); assertEquals("", controller.state.value.fileName)
        controller.refresh(); controller.waitForIdle(); assertTrue(controller.state.value.outputs.isEmpty()); controller.recover(key); controller.waitForIdle(); assertNotNull(controller.state.value.text(key))
        controller.setOnline(false); choose(controller); assertTrue(controller.state.value.outputs.isEmpty()); assertFalse(controller.state.value.hasImage)
        controller.close(); controller.setOnline(true); controller.refresh(); choose(controller); controller.generate(); assertFalse(controller.state.value.ready); assertFalse(controller.state.value.hasImage)
    }
    @Test fun lostResponseAndUnknownKeepBudgetAndCancelHasZeroPosts() = runBlocking {
        val memory = VisionMemory(); val wire = VisionStateWire(); val controller = connectVision(this, memory, wire); wire.drop = true; choose(controller); controller.generate(); controller.waitForIdle()
        assertFalse(controller.state.value.ready); assertNull(controller.state.value.records.single().observation)
        wire.drop = false; wire.state = "unknown"; val restored = connectVision(this, memory, wire); assertTrue(restored.state.value.pending); choose(restored); restored.generate(); assertEquals(1, wire.posts)
        val key = restored.state.value.records.single().key; restored.requestDiscard(key); restored.poll(); assertEquals(key, restored.state.value.confirmation)
        restored.cancelDiscard(); restored.confirmDiscard(); assertEquals(1, wire.posts); restored.requestDiscard(key); restored.confirmDiscard(); restored.waitForIdle(); assertEquals("discarded", restored.state.value.records.single().status); assertEquals(2, wire.posts)
    }
    @Test fun lateResponseCannotRepopulatePausedPage() = runBlocking {
        val wire = VisionStateWire(); val controller = connectVision(this, VisionMemory(), wire); wire.hold = true; choose(controller); controller.generate(); withTimeout(10000) { wire.entered.await() }
        controller.pause(); wire.state = "succeeded"; wire.release.complete(Unit); controller.waitForIdle(); assertTrue(controller.state.value.outputs.isEmpty()); assertFalse(controller.state.value.ready)
        controller.refresh(); controller.waitForIdle(); assertTrue(controller.state.value.ready); assertTrue(controller.state.value.outputs.isEmpty()); assertEquals(1, wire.posts)
    }
    @Test fun storageFailureOrCancellationHasZeroPosts() = runBlocking {
        for (cancel in listOf(false, true)) {
            val memory = VisionMemory(); val wire = VisionStateWire(); val controller = connectVision(this, memory, wire); memory.fail = !cancel; memory.hold = cancel; choose(controller); controller.generate()
            if (cancel) { withTimeout(10000) { while (memory.saves == 0) delay(1) }; controller.pause() }
            controller.waitForIdle(); memory.hold = false; assertEquals(0, wire.posts)
        }
    }
    @Test fun readFailureKeepsRecordsAnd401ReachesOwner() = runBlocking {
        var auth = 0; val wire = VisionStateWire(); val controller = connectVision(this, VisionMemory(), wire, onAuth = { auth++ }); choose(controller); controller.generate(); controller.waitForIdle(); val count = controller.state.value.records.size
        wire.status = 500; controller.refresh(); controller.waitForIdle(); assertFalse(controller.state.value.ready); assertEquals(count, controller.state.value.records.size)
        wire.status = 401; controller.refresh(); controller.waitForIdle(); assertEquals(1, auth); assertTrue(controller.state.value.outputs.isEmpty())
    }
    @Test fun advancedStateClockEvictsExpiredResult() = runBlocking {
        var clock = Instant.now(); val wire = VisionStateWire().apply { state = "succeeded" }; val controller = connectVision(this, VisionMemory(), wire, now = { clock }); choose(controller); controller.generate(); controller.waitForIdle(); assertFalse(controller.state.value.outputs.isEmpty())
        clock = Instant.now().plusSeconds(601); controller.poll(); assertTrue(controller.state.value.outputs.isEmpty())
    }
    @Test fun successfulClearNeedsConfirmationAndKeepsSuccessIdentity() = runBlocking {
        val wire = VisionStateWire().apply { state = "succeeded" }; val controller = connectVision(this, VisionMemory(), wire); choose(controller); controller.generate(); controller.waitForIdle(); val original = controller.state.value.records.single(); controller.requestDiscard(original.key); assertTrue(controller.state.value.clearingSuccess)
        controller.cancelDiscard(); controller.confirmDiscard(); assertEquals(1, wire.posts); controller.requestDiscard(original.key); controller.confirmDiscard(); controller.waitForIdle()
        val cleared = controller.state.value.records.single(); assertEquals(original.original, cleared.original); assertEquals("succeeded", cleared.status); assertFalse(cleared.canDiscard); assertTrue(controller.state.value.outputs.isEmpty()); assertEquals(2, wire.posts)
    }
    @Test fun invalidInputDisabledProviderAndBoundedFileRead() = runBlocking {
        val wire = VisionStateWire(); val controller = connectVision(this, VisionMemory(), wire); controller.selectFile("bad.png", byteArrayOf(1,2,3)); controller.setPrompt("问题"); assertFalse(controller.state.value.canGenerate); assertFalse(controller.state.value.hasImage)
        choose(controller); controller.setPrompt("🍋".repeat(513)); assertFalse(controller.state.value.canGenerate); assertFails { VisionRequests.validatePrompt("\uD800") }
        wire.configured = false; controller.refresh(); controller.waitForIdle(); choose(controller); controller.generate(); assertEquals(0, wire.posts)
        val bytes = ByteArray(VisionRequests.MAX_IMAGE_BYTES + 1); assertFailsWith<IOException> { MediaFile.read(ByteArrayInputStream(bytes), VisionRequests.MAX_IMAGE_BYTES) }; assertContentEquals(bytes, MediaFile.read(ByteArrayInputStream(bytes)))
    }
}
