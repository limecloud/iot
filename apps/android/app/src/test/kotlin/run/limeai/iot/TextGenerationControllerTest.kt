package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.test.*

private fun vector() = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/text/contract.json") }.first { it.isFile }.let { OtaJSON.parse(it.readText(), response = true) }
private fun hash(bytes: ByteArray) = "sha256:" + MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
private fun at() = Instant.now().truncatedTo(ChronoUnit.MILLIS)
private class TextStateMemory : SessionStore {
    val data = mutableMapOf<String, String>(); var fail = false; var hold = false; var saves = 0
    override suspend fun load(origin: String) = data[origin]
    override suspend fun save(origin: String, value: String?) { if (fail) throw IOException("storage"); saves++; if (value == null) data.remove(origin) else data[origin] = value; while (hold) delay(5) }
}
private class TextStateWire : GatewayTransport {
    val fixture = vector(); val tasks = mutableMapOf<String, JsonObject>(); val inputs = mutableListOf<JsonObject>()
    var posts = 0; var otherPosts = 0; var status = 200; var state = "running"; var drop = false; var missing = false; var configured = true; var hold = false
    val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (status != 200) return GatewayResponse(status, """{"error":{"code":"fixture_failure"}}""")
        if (request.url.endsWith("/capabilities")) return GatewayResponse(200, buildJsonObject { put("text", if (configured) fixture.getValue("capabilities") else buildJsonObject { put("configured", false); put("capability", "text.generate") }) }.toString())
        if (!request.url.contains("/text-generations")) { if (request.method == "POST") otherPosts++; error("unexpected effect") }
        val discard = request.url.endsWith("/discard")
        val key = if (discard) request.url.substringBeforeLast('/').substringAfterLast('/') else request.headers["Idempotency-Key"] ?: request.url.substringAfterLast('/')
        if (request.method == "POST") {
            posts++
            if (discard) {
                val task = tasks.getValue(key)
                tasks[key] = if (task["status"] == JsonPrimitive("succeeded")) JsonObject(task + ("output" to JsonObject(task.getValue("output").jsonObject + buildJsonObject { put("text", JsonNull); put("cleared_at", at().toString()) })))
                else { state = "discarded"; JsonObject(task + buildJsonObject { put("status", "discarded"); put("updated_at", at().toString()); put("output", JsonNull); put("usage", JsonNull); put("error_code", "text_output_discarded") }) }
            } else {
                val input = TextGenerationRequests.parse(request.body!!); inputs += input
                val messages = input.getValue("messages").jsonArray
                val summary = buildJsonObject {
                    put("context_digest", OtaJSON.digest(buildJsonObject { put("instructions", input.getValue("instructions")); put("messages", messages) }))
                    put("context_bytes", input.getValue("instructions").jsonPrimitive.content.toByteArray().size + messages.sumOf { it.jsonObject.getValue("content").jsonPrimitive.content.toByteArray().size })
                    put("message_count", messages.size); put("retain_seconds", input.getValue("retain_seconds")); put("expires_at", input.getValue("expires_at"))
                }
                val created = at().toString()
                tasks[key] = JsonObject(fixture.getValue("tasks").jsonObject.getValue("running").jsonObject + buildJsonObject { put("text_id", "text-$key"); put("idempotency_key", key); put("input", summary); put("created_at", created); put("updated_at", created); put("request_digest", OtaJSON.digest(buildJsonObject { put("space_id", "space-demo"); put("idempotency_key", key); put("input", summary) })) })
            }
            if (hold) { entered.complete(Unit); withContext(NonCancellable) { release.await() } }
            if (drop) throw IOException("receipt lost")
        }
        if (missing) return GatewayResponse(404, """{"error":{"code":"text_not_found"}}""")
        var task = tasks[key] ?: return GatewayResponse(404, """{"error":{"code":"text_not_found"}}""")
        if (task["status"] != JsonPrimitive(state)) {
            val updated = maxOf(at(), Instant.parse(task.getValue("created_at").jsonPrimitive.content))
            task = JsonObject(task + buildJsonObject {
                put("status", state); put("updated_at", updated.toString()); put("error_code", when (state) { "unknown" -> JsonPrimitive("text_interrupted"); "discarded" -> JsonPrimitive("text_output_discarded"); else -> JsonNull })
                put("usage", if (state == "succeeded") buildJsonObject { put("input_tokens", 42); put("output_tokens", 12) } else JsonNull)
                put("output", if (state == "succeeded") buildJsonObject { val text = "回答🍋保留 é"; put("text", text); put("content_digest", hash(text.toByteArray())); put("expires_at", updated.plusSeconds(600).toString()); put("cleared_at", JsonNull) } else JsonNull)
            }); tasks[key] = task
        }
        return GatewayResponse(200, task.toString())
    }
}
private suspend fun connectText(scope: CoroutineScope, memory: TextStateMemory, wire: TextStateWire, now: () -> Instant = Instant::now, auth: (Exception) -> Unit = {}): TextGenerationController {
    val gateway = GatewayClient("https://nas.local", wire); gateway.login("fixture")
    val c = TextGenerationController(TextGenerationClient(gateway, memory), "space-demo", scope, auth, now); c.refresh(); c.waitForIdle(); assertTrue(c.state.value.ready, c.state.value.message); return c
}
class TextGenerationControllerTest {
    @Test fun preparedQuestionStartsFreshWithoutSendingAndHonorsPendingAndOffline() = runBlocking {
        val memory = TextStateMemory(); val wire = TextStateWire().apply { state = "succeeded" }; val c = connectText(this, memory, wire)
        c.setPrompt("原对话"); c.generate(); c.waitForIdle(); assertEquals(2, c.state.value.messages.size)
        assertTrue(c.prepareQuestion("识别得到的新问题")); assertTrue(c.state.value.messages.isEmpty()); assertEquals("识别得到的新问题", c.state.value.prompt); assertEquals(1, wire.posts)
        assertFalse(c.prepareQuestion(" ")); assertEquals("识别得到的新问题", c.state.value.prompt)
        wire.state = "running"; c.generate(); c.waitForIdle(); assertFalse(c.prepareQuestion("不能替换未决任务")); assertEquals(2, wire.posts)
        c.pause(); assertFalse(c.prepareQuestion("后台")); assertEquals("", c.state.value.prompt)
        c.setOnline(false); assertFalse(c.prepareQuestion("离线")); c.close(); assertFalse(c.prepareQuestion("关闭"))
    }
    @Test fun exactMultiTurnContextAndDigestOnlyStorage() = runBlocking {
        val memory = TextStateMemory(); val wire = TextStateWire().apply { state = "succeeded" }; val c = connectText(this, memory, wire)
        c.setPrompt("第一条🍋 é"); c.generate(); c.waitForIdle(); assertEquals(2, c.state.value.messages.size, c.state.value.message)
        c.setPrompt("第二条"); c.generate(); c.waitForIdle(); assertEquals(4, c.state.value.messages.size)
        assertEquals(listOf("第一条🍋 é", "回答🍋保留 é", "第二条"), wire.inputs[1].getValue("messages").jsonArray.map { it.jsonObject.getValue("content").jsonPrimitive.content })
        val raw = memory.data.values.single(); for (secret in listOf("第一条", "回答🍋", "\"messages\"", "\"text\"")) assertFalse(raw.contains(secret))
        assertEquals(2, wire.posts); assertEquals(0, wire.otherPosts)
    }
    @Test fun pauseOfflineCloseAndNewInstanceDoNotRestorePlaintext() = runBlocking {
        val memory = TextStateMemory(); val wire = TextStateWire().apply { state = "succeeded" }; val c = connectText(this, memory, wire)
        c.setPrompt("正文"); c.generate(); c.waitForIdle(); val key = c.state.value.records.single().key
        c.pause(); c.refresh(); c.waitForIdle(); assertTrue(c.state.value.messages.isEmpty()); assertTrue(c.state.value.outputs.isEmpty())
        c.recover(key); c.waitForIdle(); assertNotNull(c.state.value.text(key)); assertTrue(c.state.value.messages.isEmpty())
        c.setOnline(false); assertTrue(c.state.value.outputs.isEmpty()); c.close(); c.setOnline(true); c.refresh(); c.setPrompt("不可发送"); c.generate(); assertFalse(c.state.value.ready)
        val restored = connectText(this, memory, wire); assertTrue(restored.state.value.outputs.isEmpty()); assertTrue(restored.state.value.messages.isEmpty()); assertEquals(1, wire.posts)
    }
    @Test fun lostReceipt404UnknownAndExplicitDiscard() = runBlocking {
        val memory = TextStateMemory(); val wire = TextStateWire(); val c = connectText(this, memory, wire); wire.drop = true
        c.setPrompt("丢失"); c.generate(); c.waitForIdle(); assertTrue(c.state.value.pending); assertTrue(c.state.value.messages.isEmpty())
        wire.drop = false; wire.missing = true; c.recover(c.state.value.records.single().key); c.waitForIdle(); assertTrue(c.state.value.pending); assertEquals(1, wire.posts)
        wire.missing = false; wire.state = "unknown"; val restored = connectText(this, memory, wire); assertTrue(restored.state.value.pending)
        restored.setPrompt("不可替换"); restored.generate(); assertEquals(1, wire.posts)
        val key = restored.state.value.records.single().key; restored.requestDiscard(key); restored.cancelDiscard(); restored.confirmDiscard(); assertEquals(1, wire.posts)
        restored.requestDiscard(key); restored.confirmDiscard(); restored.waitForIdle(); assertEquals("discarded", restored.state.value.records.single().status); assertEquals(2, wire.posts)
    }
    @Test fun lateReplyCannotReviveBackgroundOrEnterNextContext() = runBlocking {
        val wire = TextStateWire(); val c = connectText(this, TextStateMemory(), wire); wire.hold = true
        c.setPrompt("旧消息"); c.generate(); withTimeout(10000) { wire.entered.await() }; c.pause(); wire.state = "succeeded"; wire.hold = false; wire.release.complete(Unit); c.waitForIdle()
        assertTrue(c.state.value.outputs.isEmpty()); assertTrue(c.state.value.messages.isEmpty())
        c.refresh(); c.waitForIdle(); assertTrue(c.state.value.outputs.isEmpty()); c.setPrompt("新消息"); c.generate(); c.waitForIdle()
        assertEquals(1, wire.inputs.last().getValue("messages").jsonArray.size); assertEquals("新消息", wire.inputs.last().getValue("messages").jsonArray.single().jsonObject.getValue("content").jsonPrimitive.content)
    }
    @Test fun storageFailureAndCancellationBeforePostHaveZeroEffects() = runBlocking {
        for (cancel in listOf(false, true)) {
            val memory = TextStateMemory(); val wire = TextStateWire(); val c = connectText(this, memory, wire); memory.fail = !cancel; memory.hold = cancel
            c.setPrompt("正文"); c.generate(); if (cancel) { withTimeout(10000) { while (memory.saves == 0) delay(1) }; c.pause() }; c.waitForIdle(); memory.hold = false; assertEquals(0, wire.posts)
        }
    }
    @Test fun expiryClearsWholeContextAndSuccessClearKeepsIdentity() = runBlocking {
        var clock = Instant.now(); val wire = TextStateWire().apply { state = "succeeded" }; val c = connectText(this, TextStateMemory(), wire, now = { clock })
        c.setPrompt("期限"); c.generate(); c.waitForIdle(); val original = c.state.value.records.single()
        c.requestDiscard(original.key); c.cancelDiscard(); c.confirmDiscard(); assertEquals(1, wire.posts)
        c.requestDiscard(original.key); c.confirmDiscard(); c.waitForIdle(); assertTrue(c.state.value.messages.isEmpty()); assertTrue(c.state.value.outputs.isEmpty()); assertEquals(original.original, c.state.value.records.single().original); assertFalse(c.state.value.records.single().canDiscard)
        c.setPrompt("下一轮"); c.generate(); c.waitForIdle(); clock = Instant.now().plusSeconds(601); c.poll(); assertTrue(c.state.value.messages.isEmpty()); assertTrue(c.state.value.outputs.isEmpty())
    }
    @Test fun disabledProviderInvalidInputAnd401FailClosed() = runBlocking {
        var auth = 0; val wire = TextStateWire(); val c = connectText(this, TextStateMemory(), wire, auth = { auth++ })
        c.setPrompt("🍋".repeat(2049)); assertFalse(c.state.value.canGenerate)
        wire.configured = false; c.refresh(); c.waitForIdle(); c.setPrompt("正文"); c.generate(); assertEquals(0, wire.posts)
        wire.status = 401; c.refresh(); c.waitForIdle(); assertEquals(1, auth); assertTrue(c.state.value.outputs.isEmpty()); assertTrue(c.state.value.messages.isEmpty())
    }
}
