package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.io.File
import java.io.IOException
import java.time.Instant
import kotlin.test.*

// 向量包含故意非法的小数，容器按通用JSON读取，再逐项交给生产校验器拒绝。
private fun joinVector(): JsonObject = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/zigbee/commissioning-native.json") }.first { it.isFile }.let { Json.parseToJsonElement(it.readText()).jsonObject }
private class JoinMemory : SessionStore {
    val values = mutableMapOf<String, String>(); var fail = false; var mismatch = false; var hold: CompletableDeferred<Unit>? = null; var waiting = false
    override suspend fun load(origin: String) = values[origin]
    override suspend fun save(origin: String, value: String?) {
        if (fail) throw IOException("fixture store failed")
        if (!mismatch) { if (value == null) values.remove(origin) else values[origin] = value }
        hold?.let { waiting = true; withContext(NonCancellable) { it.await() }; waiting = false }
    }
}
private class JoinWire : GatewayTransport {
    val v = joinVector(); val requests = mutableListOf<GatewayRequest>(); val results = mutableListOf<JsonObject>()
    var drop = false; var missing = false; var corrupt = false; var duplicate = false; var unknown = false; var changed = false
    var hold: CompletableDeferred<Unit>? = null; var waiting = false
    val posts get() = requests.count { it.method == "POST" && it.url.endsWith("/zigbee-operations") }
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        requests += request
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (request.url.endsWith("/zigbee-coordinators")) {
            hold?.let { waiting = true; withContext(NonCancellable) { it.await() }; waiting = false }
            val page = v.getValue("coordinators").jsonObject
            val output = if (!changed) page else JsonObject(page + ("items" to JsonArray(page.getValue("items").jsonArray.map { JsonObject(it.jsonObject + ("revision" to JsonPrimitive("sha256:" + "0".repeat(64)))) })))
            return GatewayResponse(200, output.toString())
        }
        if (request.url.endsWith("/zigbee-operations") && request.method == "GET") return GatewayResponse(200, buildJsonObject { put("items", JsonArray(results)); put("next_cursor", JsonNull) }.toString())
        val key = request.headers["Idempotency-Key"] ?: request.url.substringAfterLast('/')
        if (request.method == "POST") {
            val change = ZigbeeJSON.parse(request.body!!); val seconds = change.getValue("duration_seconds").jsonPrimitive.int
            val original = buildJsonObject { put("space_id", "space-demo"); put("idempotency_key", key); put("change", change) }
            val base = v.getValue(if (unknown) "unknown" else "accepted").jsonObject
            val fields = mapOf("operation_id" to JsonPrimitive("join-$key"), "sequence" to JsonPrimitive(results.size + 1), "request" to original, "request_digest" to JsonPrimitive(ObservationJSON.digest(original)), "blocked_until" to JsonPrimitive(Instant.parse("2030-01-01T00:00:00Z").plusMillis(seconds * 1000L + 500).toString()))
            val value = JsonObject(base + fields + if (unknown) emptyMap() else mapOf("result" to JsonObject(base.getValue("result").jsonObject + ("duration_seconds" to JsonPrimitive(seconds)))))
            results += value; if (drop) throw IOException("fixture lost response")
        }
        var result = results.firstOrNull { it.getValue("request").jsonObject["idempotency_key"] == JsonPrimitive(key) }
        if (missing || result == null) return GatewayResponse(404, """{"error":{"code":"not_found"}}""")
        if (corrupt) result = JsonObject(result + ("request_digest" to JsonPrimitive("sha256:" + "0".repeat(64))))
        val text = result.toString(); return GatewayResponse(200, if (duplicate) "{\"status\":\"unknown\"," + text.drop(1) else text)
    }
}
private val joinNow = Instant.parse("2030-01-01T00:00:10Z")
private suspend fun joinClient(memory: JoinMemory, wire: JoinWire): ZigbeeClient {
    val gateway = GatewayClient("https://nas.local", wire); gateway.login("owner-input"); return ZigbeeClient(gateway, memory) { joinNow }
}
private suspend fun joinState(scope: CoroutineScope, memory: JoinMemory, wire: JoinWire, now: () -> Instant = { joinNow }): ZigbeeController {
    return ZigbeeController(joinClient(memory, wire), "space-demo", scope, {}, now).also { it.refresh(); it.waitForIdle(); assertTrue(it.state.value.ready, it.state.value.message) }
}

class ZigbeeControllerTest {
    @Test fun sharedContractsAndFullHistoryCapacity() = runBlocking {
        val v = joinVector(); ZigbeeJSON.coordinators(v.getValue("coordinators").jsonObject); ZigbeeJSON.change(v.getValue("change").jsonObject)
        ZigbeeJSON.operation(v.getValue("unknown").jsonObject); ZigbeeJSON.operation(v.getValue("accepted").jsonObject)
        for (item in v.getValue("invalid").jsonArray) {
            val fields = item.jsonObject; val doc = fields.getValue("document").jsonObject
            assertFails {
                when (fields.getValue("type").jsonPrimitive.content) {
                    "change" -> ZigbeeJSON.change(doc)
                    "coordinators" -> ZigbeeJSON.coordinators(doc)
                    "operation" -> ZigbeeJSON.operation(doc)
                    else -> ZigbeeJSON.history(doc, "space-demo")
                }
            }
        }
        val items = (0 until 256).map { index ->
            val base = v.getValue("accepted").jsonObject; val request = JsonObject(base.getValue("request").jsonObject + ("idempotency_key" to JsonPrimitive("original-$index")))
            JsonObject(base + mapOf("sequence" to JsonPrimitive(index + 1), "operation_id" to JsonPrimitive("join-$index"), "request" to request, "request_digest" to JsonPrimitive(ObservationJSON.digest(request))))
        }
        val page = buildJsonObject { put("items", JsonArray(items)); put("next_cursor", JsonNull) }
        assertEquals(256, ZigbeeJSON.history(ZigbeeJSON.parse(page.toString()), "space-demo").size)
    }
    @Test fun saveAndReadbackFailuresNeverPost() = runBlocking {
        for (mismatch in listOf(false, true)) {
            val memory = JoinMemory(); val wire = JoinWire(); val client = joinClient(memory, wire); val preparation = client.prepare("space-demo", "home-znp", 60)
            memory.fail = !mismatch; memory.mismatch = mismatch
            assertFails { client.submit("space-demo", preparation, joinNow.plusSeconds(60), "original") }; assertEquals(0, wire.posts)
        }
    }
    @Test fun lostMissingCorruptDuplicateAndChangedReceiptsOnlyReadOriginal() = runBlocking {
        val memory = JoinMemory(); val wire = JoinWire(); val client = joinClient(memory, wire); val preparation = client.prepare("space-demo", "home-znp", 60)
        wire.drop = true; assertFails { client.submit("space-demo", preparation, joinNow.plusSeconds(60), "original") }; wire.drop = false
        val restored = joinClient(memory, wire)
        for (mode in 0..2) {
            wire.missing = mode == 0; wire.corrupt = mode == 1; wire.duplicate = mode == 2
            assertFails { restored.submit("space-demo", preparation, Instant.EPOCH, "original") }; assertNull(restored.records("space-demo").single().result)
        }
        wire.missing = false; wire.corrupt = false; wire.duplicate = false
        assertTrue(restored.resolve("space-demo", "original").accepted); assertEquals(1, wire.posts)
        val other = joinClient(JoinMemory(), wire); assertTrue(other.resolve("space-demo", "original").accepted); assertTrue(other.records("space-demo").isEmpty())
        val old = wire.results[0]; val changedAt = JsonPrimitive("2030-01-01T00:00:00.200Z")
        wire.results[0] = JsonObject(old + mapOf("completed_at" to changedAt, "result" to JsonObject(old.getValue("result").jsonObject + ("observed_at" to changedAt))))
        assertFails { restored.resolve("space-demo", "original") }
        val post = wire.requests.single { it.method == "POST" && it.url.endsWith("/zigbee-operations") }
        assertEquals(35000L, post.timeoutMillis); assertNull(post.headers["Authorization"]); assertEquals("csrf", post.headers["X-CSRF-Token"])
    }
    @Test fun unknownBlocksReplacementButIndependentCloseIsAllowed() = runBlocking {
        val memory = JoinMemory(); val wire = JoinWire(); val client = joinClient(memory, wire); val preparation = client.prepare("space-demo", "home-znp", 60)
        wire.unknown = true; client.submit("space-demo", preparation, joinNow.plusSeconds(60), "unknown")
        assertFails { client.prepare("space-demo", "home-znp", 30) }; wire.unknown = false
        val close = client.prepare("space-demo", "home-znp", 0); client.submit("space-demo", close, joinNow.plusSeconds(60), "close")
        assertEquals(2, wire.posts); assertEquals(2, client.records("space-demo").size); assertFalse(client.records("space-demo").first().accepted)
    }
    @Test fun cancelDurableSavePreservesOriginalAndBlocksSilentDeletion() = runBlocking {
        val memory = JoinMemory(); val wire = JoinWire(); val client = joinClient(memory, wire); val preparation = client.prepare("space-demo", "home-znp", 60)
        memory.hold = CompletableDeferred()
        val pending = launch { client.submit("space-demo", preparation, joinNow.plusSeconds(60), "original") }
        withTimeout(2000) { while (!memory.waiting) delay(5) }; pending.cancel(); memory.hold!!.complete(Unit); pending.join()
        assertEquals(0, wire.posts); assertEquals(1, client.records("space-demo").size)
        memory.values.clear(); assertFails { client.prepare("space-demo", "home-znp", 0) }; assertEquals(0, wire.posts)
    }
    @Test fun explicitOpenCloseInputChangeAndCancel() = runBlocking {
        val wire = JoinWire(); val state = joinState(this, JoinMemory(), wire)
        state.prepare(); state.waitForIdle(); assertNotNull(state.state.value.review); assertEquals(0, wire.posts)
        state.setSeconds("30"); assertNull(state.state.value.review); state.prepare(); state.waitForIdle(); state.cancelReview(); assertEquals(0, wire.posts)
        state.prepare(); state.waitForIdle(); state.confirm(); state.waitForIdle(); assertTrue(state.state.value.records.single().accepted)
        state.prepare(close = true); state.waitForIdle(); assertEquals(1, wire.posts); state.confirm(); state.waitForIdle(); assertEquals(2, wire.posts)
    }
    @Test fun expirationAndConfigurationChangesNeverPost() = runBlocking {
        val wire = JoinWire(); var now = joinNow; val state = joinState(this, JoinMemory(), wire) { now }
        state.prepare(); state.waitForIdle(); now = now.plusSeconds(60); state.poll(); state.confirm(); assertNull(state.state.value.review); assertEquals(0, wire.posts)
        now = joinNow; state.prepare(); state.waitForIdle(); wire.changed = true; state.confirm(); state.waitForIdle(); assertEquals(0, wire.posts); assertNull(state.state.value.review)
    }
    @Test fun lateReadCannotReviveBackgroundState() = runBlocking {
        val wire = JoinWire(); val state = joinState(this, JoinMemory(), wire); wire.hold = CompletableDeferred(); state.prepare()
        withTimeout(2000) { while (!wire.waiting) delay(5) }; state.pause(); wire.hold!!.complete(Unit); state.waitForIdle()
        assertNull(state.state.value.review); assertFalse(state.state.value.ready); assertFalse(state.state.value.busy); assertEquals(0, wire.posts)
    }
    @Test fun offlineDuringDurableSaveAndClosedStateCannotSend() = runBlocking {
        val memory = JoinMemory(); val wire = JoinWire(); val state = joinState(this, memory, wire)
        state.prepare(); state.waitForIdle(); memory.hold = CompletableDeferred(); state.confirm()
        withTimeout(2000) { while (!memory.waiting) delay(5) }; state.setOnline(false); memory.hold!!.complete(Unit); state.waitForIdle()
        assertEquals(0, wire.posts); assertNull(state.state.value.review); assertFalse(state.state.value.ready)
        val restored = joinState(this, memory, wire); assertEquals(1, restored.state.value.records.size)
        restored.close(); restored.setOnline(true); restored.refresh(); assertFalse(restored.state.value.ready)
    }
}
