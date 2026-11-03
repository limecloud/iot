package run.limeai.iot.core

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File
import java.io.IOException
import kotlin.test.*

private fun visionVector(): JsonObject {
    val file = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/vision/contract.json") }.first { it.isFile }
    return IntegerJSON.parse(file.readText())
}
private class VisionMemoryStore : SessionStore {
    val data = mutableMapOf<String, String>(); var saves = 0; var failAt = 0
    var afterSave: (() -> Unit)? = null
    override suspend fun load(origin: String) = data[origin]
    override suspend fun save(origin: String, value: String?) {
        saves++; if (saves == failAt) throw IOException("storage fixture")
        if (value == null) data.remove(origin) else data[origin] = value
        afterSave?.invoke()
    }
}
private class VisionFixtureWire(val store: VisionMemoryStore) : GatewayTransport {
    val vector = visionVector(); val requests = mutableListOf<GatewayRequest>()
    var savedBeforePosts = true; var drop = false; var missing = false; var reject = false
    var state = "running"; var corruption = ""; var delayPost = false
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        requests += request
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (request.url.endsWith("/capabilities")) return GatewayResponse(200, buildJsonObject { put("vision", vector.getValue("capabilities")) }.toString())
        if (request.method == "POST") {
            val saved = IntegerJSON.parse(store.data.getValue("https://nas.local#vision-observations"))["records"]!!.jsonArray.single().jsonObject
            savedBeforePosts = savedBeforePosts && saved["original"] == vector["original"]
            if (request.url.endsWith("/discard")) {
                savedBeforePosts = savedBeforePosts && saved["discard_intents"] == JsonArray(listOf(JsonPrimitive("discard-intent"))); state = if (state == "succeeded") "cleared" else "discarded"
            } else savedBeforePosts = savedBeforePosts && request.headers["Idempotency-Key"] == "original" && VisionRequests.parse(request.body!!) == vector["normalized"]
            if (delayPost) delay(100)
            if (reject) return GatewayResponse(422, """{"error":{"code":"vision_provider_rejected"}}""")
            if (drop) throw IOException("response lost")
        }
        if (missing) return GatewayResponse(404, """{"error":{"code":"vision_not_found"}}""")
        val task = (vector.getValue("tasks").jsonObject[state] ?: vector.getValue("invalid_tasks").jsonObject.getValue(state)).jsonObject
        val result = when (corruption) {
            "digest" -> JsonObject(task + ("request_digest" to JsonPrimitive("sha256:" + "0".repeat(64))))
            "deployment" -> JsonObject(task + ("deployment" to JsonObject(task.getValue("deployment").jsonObject + ("model" to JsonPrimitive("changed/model")))))
            "identity" -> JsonObject(task + ("vision_id" to JsonPrimitive("vision-other")))
            "time" -> JsonObject(task + ("updated_at" to JsonPrimitive("2026-11-02T23:59:59.123Z")))
            "extra" -> JsonObject(task + ("text" to JsonPrimitive("must reject")))
            else -> task
        }
        return GatewayResponse(200, result.toString())
    }
    val posts get() = requests.filter { it.method == "POST" && it.url.contains("/vision-observations") }
}
private suspend fun visionFixture(store: VisionMemoryStore, wire: VisionFixtureWire): VisionClient {
    val gateway = GatewayClient("https://nas.local", wire); gateway.login("owner-input"); return VisionClient(gateway, store)
}
class VisionClientTest {
    private val vector = visionVector()
    private val input get() = vector.getValue("input").jsonObject
    @Test fun sharedUnicodeTimeNormalizationAndBounds() {
        assertEquals(vector["normalized"], VisionRequests.parse(input.toString()))
        for ((key, value) in mapOf("expires_at" to JsonPrimitive("2026-11-03T00:01:25.1234Z"), "prompt" to JsonPrimitive(" "), "content_type" to JsonPrimitive("image/gif"), "image_base64" to JsonPrimitive("bad!"))) assertFails { VisionRequests.parse(JsonObject(input + (key to value)).toString()) }
    }
    @Test fun originalSavedBeforePostAndSameKeyOnlyQueries() = runBlocking {
        val store = VisionMemoryStore(); val wire = VisionFixtureWire(store); val client = visionFixture(store, wire)
        val capabilities = client.capabilities("space-demo"); assertTrue(capabilities.configured)
        val record = client.submit("space-demo", input, "original")
        assertEquals(vector["original"], record.original); assertEquals(vector.getValue("tasks").jsonObject["running"], record.observation)
        val saved = store.data.getValue("https://nas.local#vision-observations")
        assertFalse(saved.contains("青柠")); assertFalse(saved.contains("owner-input")); assertFalse(saved.contains("\"text\"")); assertTrue(wire.savedBeforePosts)
        client.submit("space-demo", vector.getValue("normalized").jsonObject, "original")
        assertEquals("vision_pending", assertFailsWith<VisionException> { client.submit("space-demo", input, "replacement") }.code)
        assertFails { client.submit("space-demo", JsonObject(input + ("prompt" to JsonPrimitive("另一个问题"))), "original") }
        assertEquals(1, wire.posts.size); assertEquals("GET", wire.requests.last().method)
        assertEquals("csrf", wire.posts.single().headers["X-CSRF-Token"]); assertNull(wire.posts.single().headers["Authorization"])
    }
    @Test fun originalAndReceiptStorageFailuresDoNotRepeatPost() = runBlocking {
        for (failure in listOf(1, 2)) {
            val store = VisionMemoryStore().apply { failAt = failure }; val wire = VisionFixtureWire(store); val client = visionFixture(store, wire)
            assertEquals("vision_storage_failed", assertFailsWith<VisionException> { client.submit("space-demo", input, "original") }.code)
            assertEquals(failure - 1, wire.posts.size)
            if (failure == 2) { visionFixture(store, wire).resolve("space-demo", "original"); assertEquals(1, wire.posts.size) }
        }
    }
    @Test fun lostResponse404AndUnknownNeverResubmit() = runBlocking {
        val store = VisionMemoryStore(); val wire = VisionFixtureWire(store).apply { drop = true }; val client = visionFixture(store, wire)
        assertFailsWith<IOException> { client.submit("space-demo", input, "original") }
        val restored = visionFixture(store, wire); wire.drop = false; wire.missing = true
        assertEquals("vision_unknown", assertFailsWith<VisionException> { restored.resolve("space-demo", "original") }.code)
        assertEquals("unresolved", restored.records("space-demo").single().status)
        wire.missing = false; wire.state = "unknown"; restored.resolve("space-demo", "original")
        assertEquals("vision_pending", assertFailsWith<VisionException> { restored.submit("space-demo", input, "replacement") }.code)
        wire.state = "succeeded"; assertFails { restored.resolve("space-demo", "original") }
        wire.state = "unknown"; wire.corruption = "deployment"; assertFails { restored.resolve("space-demo", "original") }
        wire.corruption = ""; val discarded = restored.discard("space-demo", "original", "discard-intent")
        assertEquals("discarded", discarded.status); assertNull(discarded.text)
        restored.discard("space-demo", "original", "discard-intent")
        assertEquals(2, wire.posts.size); assertTrue(wire.savedBeforePosts)
    }
    @Test fun malformedReceiptDoesNotReplaceOriginal() = runBlocking {
        for (corruption in listOf("digest", "time", "extra")) {
            val store = VisionMemoryStore(); val wire = VisionFixtureWire(store).apply { this.corruption = corruption }; val client = visionFixture(store, wire)
            assertFails { client.submit("space-demo", input, "original") }; assertNull(client.records("space-demo").single().observation)
            wire.corruption = ""; visionFixture(store, wire).resolve("space-demo", "original"); assertEquals(1, wire.posts.size)
        }
    }
    @Test fun successReturnsMediaIdAndRejectsTerminalRollbackOrIdentityDrift() = runBlocking {
        val store = VisionMemoryStore(); val wire = VisionFixtureWire(store); val client = visionFixture(store, wire)
        client.submit("space-demo", input, "original"); wire.state = "succeeded"
        val result = client.resolve("space-demo", "original"); assertEquals("青柠🍋\n你好", result.text); assertFalse(result.pending)
        wire.state = "running"; assertFails { client.resolve("space-demo", "original") }
        wire.state = "succeeded"; wire.corruption = "identity"; assertFails { client.resolve("space-demo", "original") }
        assertEquals(1, wire.posts.size)
    }
    @Test fun explicitRejectionIsRetainedWithoutNewPost() = runBlocking {
        val store = VisionMemoryStore(); val wire = VisionFixtureWire(store).apply { reject = true }; val client = visionFixture(store, wire)
        assertFailsWith<GatewayException> { client.submit("space-demo", input, "original") }
        val record = client.records("space-demo").single()
        assertEquals("rejected", record.status); assertFalse(record.pending); assertEquals("vision_provider_rejected", record.rejectedCode)
        assertFails { client.submit("space-demo", input, "original") }; assertEquals(1, wire.posts.size)
    }
    @Test fun corruptedOrExternallyRemovedStorageStopsWrites() = runBlocking {
        val store = VisionMemoryStore().apply { data["https://nas.local#vision-observations"] = "{broken" }; val wire = VisionFixtureWire(store)
        assertFails { visionFixture(store, wire).submit("space-demo", input, "original") }
        assertEquals("{broken", store.data["https://nas.local#vision-observations"]); assertEquals(0, store.saves); assertTrue(wire.posts.isEmpty())
        store.data.clear(); val client = visionFixture(store, wire); client.submit("space-demo", input, "original")
        store.data.clear(); assertFails { client.submit("space-demo", input, "removed") }; assertEquals(1, wire.posts.size)
    }
    @Test fun cancellationAfterSaveHasZeroPosts() = runBlocking {
        val store = VisionMemoryStore(); val wire = VisionFixtureWire(store); val client = visionFixture(store, wire)
        val task = async(start = CoroutineStart.LAZY) { client.submit("space-demo", input, "original") }
        store.afterSave = { task.cancel() }; task.start()
        assertFailsWith<CancellationException> { task.await() }; assertTrue(wire.posts.isEmpty())
        assertEquals("unresolved", client.records("space-demo").single().status)
        val changed = VisionMemoryStore(); val otherWire = VisionFixtureWire(changed); val other = visionFixture(changed, otherWire)
        changed.afterSave = { changed.data.replaceAll { _, value -> value.replace("\"image_bytes\":68", "\"image_bytes\":69") }; throw IOException("write acknowledgement lost") }
        assertEquals("vision_storage_failed", assertFailsWith<VisionException> { other.submit("space-demo", input, "original") }.code)
        assertEquals("vision_storage_failed", assertFailsWith<VisionException> { other.records("space-demo") }.code)
        assertTrue(otherWire.posts.isEmpty())
    }
    @Test fun concurrentInstancesSendOriginalOnlyOnce() = runBlocking {
        val store = VisionMemoryStore(); val wire = VisionFixtureWire(store).apply { delayPost = true }
        val first = visionFixture(store, wire); val second = visionFixture(store, wire)
        val a = async { first.submit("space-demo", input, "original") }; val b = async { second.submit("space-demo", input, "original") }
        assertEquals(a.await().original, b.await().original); assertEquals(1, wire.posts.size)
    }
    @Test fun successfulPlaintextIsNeverPersistedAndClearedOutputCannotResurrect() = runBlocking {
        val store = VisionMemoryStore(); val wire = VisionFixtureWire(store).apply { state = "succeeded" }; val client = visionFixture(store, wire)
        val success = client.submit("space-demo", input, "original"); assertEquals("青柠🍋\n你好", success.text)
        val saved = store.data.getValue("https://nas.local#vision-observations")
        assertFalse(saved.contains("青柠")); assertFalse(saved.contains("\"text\"")); assertTrue(saved.contains("content_digest"))
        val restored = visionFixture(store, wire); assertNull(restored.records("space-demo").single().text)
        wire.state = "succeeded"; val cleared = restored.discard("space-demo", "original", "discard-intent"); assertNull(cleared.text); assertEquals("succeeded", cleared.status)
        wire.state = "succeeded"; assertFails { restored.resolve("space-demo", "original") }; assertEquals(2, wire.posts.size)
        assertFalse(cleared.canDiscard); wire.state = "cleared"; restored.discard("space-demo", "original", "discard-intent"); assertEquals(2, wire.posts.size)
    }
    @Test fun jpegUnicodeAndMaximumImageBounds() = runBlocking {
        val expiry = "2026-11-03T00:01:25.123Z"; val jpeg = byteArrayOf(-1,-40,-1,-39)
        VisionRequests.input(jpeg, "image/jpeg", "🍋".repeat(512), expiresAt = expiry)
        assertFails { VisionRequests.input(jpeg, "image/jpeg", "🍋".repeat(513), expiresAt = expiry) }
        val maximum = ByteArray(VisionRequests.MAX_IMAGE_BYTES); byteArrayOf(-119,80,78,71,13,10,26,10).copyInto(maximum)
        VisionRequests.input(maximum, "image/png", "尺寸检查", expiresAt = expiry)
        assertFails { VisionRequests.input(maximum + byteArrayOf(0), "image/png", "尺寸检查", expiresAt = expiry) }
        assertFails { VisionRequests.parse("""{"prompt":"a","prompt":"b"}""") }
        // 原生库只检查格式标记与输入边界，完整静态图片解码仍由网关执行。
        val timezoneStore = VisionMemoryStore(); val timezoneWire = VisionFixtureWire(timezoneStore).apply { state = "timezone" }
        val client = visionFixture(timezoneStore, timezoneWire)
        assertEquals("青柠🍋\n你好", client.submit("space-demo", input, "original").text); assertNotNull(client.records("space-demo").single().observation)
        Unit
    }

    @Test fun malformedOutputNeverReplacesOriginal() = runBlocking {
        for (name in vector.getValue("invalid_tasks").jsonObject.keys) {
            val store = VisionMemoryStore(); val wire = VisionFixtureWire(store).apply { state = name }; val client = visionFixture(store, wire)
            assertFails { client.submit("space-demo", input, "original") }; assertNull(client.records("space-demo").single().observation)
        }
    }

}
