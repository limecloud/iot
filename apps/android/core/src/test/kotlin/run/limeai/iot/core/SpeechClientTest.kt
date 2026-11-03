package run.limeai.iot.core

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File
import java.io.IOException
import kotlin.test.*

private fun speechVector(): JsonObject {
    val file = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/speech/contract.json") }.first { it.isFile }
    return IntegerJSON.parse(file.readText())
}
private class SpeechMemoryStore : SessionStore {
    val data = mutableMapOf<String, String>(); var saves = 0; var failAt = 0
    var afterSave: (() -> Unit)? = null
    override suspend fun load(origin: String) = data[origin]
    override suspend fun save(origin: String, value: String?) {
        saves++; if (saves == failAt) throw IOException("storage fixture")
        if (value == null) data.remove(origin) else data[origin] = value
        afterSave?.invoke()
    }
}
private class SpeechFixtureWire(val store: SpeechMemoryStore) : GatewayTransport {
    val vector = speechVector(); val requests = mutableListOf<GatewayRequest>()
    var savedBeforePosts = true; var drop = false; var missing = false; var reject = false
    var state = "running"; var corruption = ""; var delayPost = false
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        requests += request
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (request.url.endsWith("/capabilities")) return GatewayResponse(200, buildJsonObject { put("speech", vector.getValue("capabilities")) }.toString())
        if (request.method == "POST") {
            val saved = IntegerJSON.parse(store.data.getValue("https://nas.local#speech-syntheses"))["records"]!!.jsonArray.single().jsonObject
            savedBeforePosts = savedBeforePosts && saved["original"] == vector["original"]
            if (request.url.endsWith("/discard")) {
                savedBeforePosts = savedBeforePosts && saved["discard_intents"] == JsonArray(listOf(JsonPrimitive("discard-intent"))); state = "discarded"
            } else savedBeforePosts = savedBeforePosts && request.headers["Idempotency-Key"] == "original" && SpeechRequests.parse(request.body!!) == vector["normalized"]
            if (delayPost) delay(100)
            if (reject) return GatewayResponse(422, """{"error":{"code":"speech_voice_unavailable"}}""")
            if (drop) throw IOException("response lost")
        }
        if (missing) return GatewayResponse(404, """{"error":{"code":"speech_synthesis_not_found"}}""")
        val task = vector.getValue("tasks").jsonObject.getValue(state).jsonObject
        val result = when (corruption) {
            "digest" -> JsonObject(task + ("request_digest" to JsonPrimitive("sha256:" + "0".repeat(64))))
            "deployment" -> JsonObject(task + ("deployment" to JsonObject(task.getValue("deployment").jsonObject + ("model" to JsonPrimitive("changed/model")))))
            "identity" -> JsonObject(task + ("synthesis_id" to JsonPrimitive("speech-other")))
            "time" -> JsonObject(task + ("updated_at" to JsonPrimitive("2026-11-02T23:59:59.123Z")))
            "extra" -> JsonObject(task + ("text" to JsonPrimitive("must reject")))
            else -> task
        }
        return GatewayResponse(200, result.toString())
    }
    val posts get() = requests.filter { it.method == "POST" && it.url.contains("/speech-syntheses") }
}
private suspend fun speechFixture(store: SpeechMemoryStore, wire: SpeechFixtureWire): SpeechClient {
    val gateway = GatewayClient("https://nas.local", wire); gateway.login("owner-input"); return SpeechClient(gateway, store)
}
class SpeechClientTest {
    private val vector = speechVector()
    private val input get() = vector.getValue("input").jsonObject
    @Test fun sharedUnicodeTimeNormalizationAndBounds() {
        assertEquals(vector["normalized"], SpeechRequests.parse(input.toString()))
        for (text in listOf("", " \t\n\uFEFF", "🍋".repeat(1001), "bad\u0000", "bad\u0085", "bad\rtext", "\uD800")) assertFails { SpeechRequests.input(text, "local") }
        for ((key, value) in mapOf("expires_at" to JsonPrimitive("2026-11-03T00:01:25.1234Z"), "voice" to JsonPrimitive("bad voice"), "retain_seconds" to JsonPrimitive(59))) assertFails { SpeechRequests.parse(JsonObject(input + (key to value)).toString()) }
    }
    @Test fun originalSavedBeforePostAndSameKeyOnlyQueries() = runBlocking {
        val store = SpeechMemoryStore(); val wire = SpeechFixtureWire(store); val client = speechFixture(store, wire)
        val capabilities = client.capabilities("space-demo"); assertTrue(capabilities.configured); assertEquals(listOf("local", "other"), capabilities.voices)
        val record = client.submit("space-demo", input, "original")
        assertEquals(vector["original"], record.original); assertEquals(vector.getValue("tasks").jsonObject["running"], record.result)
        val saved = store.data.getValue("https://nas.local#speech-syntheses")
        assertFalse(saved.contains("青柠")); assertFalse(saved.contains("owner-input")); assertFalse(saved.contains("\"text\"")); assertTrue(wire.savedBeforePosts)
        client.submit("space-demo", vector.getValue("normalized").jsonObject, "original")
        assertEquals("speech_pending", assertFailsWith<SpeechException> { client.submit("space-demo", input, "replacement") }.code)
        assertFails { client.submit("space-demo", JsonObject(input + ("retain_seconds" to JsonPrimitive(601))), "original") }
        assertEquals(1, wire.posts.size); assertEquals("GET", wire.requests.last().method)
        assertEquals("csrf", wire.posts.single().headers["X-CSRF-Token"]); assertNull(wire.posts.single().headers["Authorization"])
    }
    @Test fun originalAndReceiptStorageFailuresDoNotRepeatPost() = runBlocking {
        for (failure in listOf(1, 2)) {
            val store = SpeechMemoryStore().apply { failAt = failure }; val wire = SpeechFixtureWire(store); val client = speechFixture(store, wire)
            assertEquals("speech_storage_failed", assertFailsWith<SpeechException> { client.submit("space-demo", input, "original") }.code)
            assertEquals(failure - 1, wire.posts.size)
            if (failure == 2) { speechFixture(store, wire).resolve("space-demo", "original"); assertEquals(1, wire.posts.size) }
        }
    }
    @Test fun lostResponse404AndUnknownNeverResubmit() = runBlocking {
        val store = SpeechMemoryStore(); val wire = SpeechFixtureWire(store).apply { drop = true }; val client = speechFixture(store, wire)
        assertFailsWith<IOException> { client.submit("space-demo", input, "original") }
        val restored = speechFixture(store, wire); wire.drop = false; wire.missing = true
        assertEquals("speech_unknown", assertFailsWith<SpeechException> { restored.resolve("space-demo", "original") }.code)
        assertEquals("unresolved", restored.records("space-demo").single().status)
        wire.missing = false; wire.state = "unknown"; restored.resolve("space-demo", "original")
        assertEquals("speech_pending", assertFailsWith<SpeechException> { restored.submit("space-demo", input, "replacement") }.code)
        wire.state = "succeeded"; assertFails { restored.resolve("space-demo", "original") }
        wire.state = "unknown"; wire.corruption = "deployment"; assertFails { restored.resolve("space-demo", "original") }
        wire.corruption = ""; val discarded = restored.discard("space-demo", "original", "discard-intent")
        assertEquals("discarded", discarded.status); assertNull(discarded.mediaId)
        restored.discard("space-demo", "original", "discard-intent")
        assertEquals(2, wire.posts.size); assertTrue(wire.savedBeforePosts)
    }
    @Test fun malformedReceiptDoesNotReplaceOriginal() = runBlocking {
        for (corruption in listOf("digest", "time", "extra")) {
            val store = SpeechMemoryStore(); val wire = SpeechFixtureWire(store).apply { this.corruption = corruption }; val client = speechFixture(store, wire)
            assertFails { client.submit("space-demo", input, "original") }; assertNull(client.records("space-demo").single().result)
            wire.corruption = ""; speechFixture(store, wire).resolve("space-demo", "original"); assertEquals(1, wire.posts.size)
        }
    }
    @Test fun successReturnsMediaIdAndRejectsTerminalRollbackOrIdentityDrift() = runBlocking {
        val store = SpeechMemoryStore(); val wire = SpeechFixtureWire(store); val client = speechFixture(store, wire)
        client.submit("space-demo", input, "original"); wire.state = "succeeded"
        val result = client.resolve("space-demo", "original"); assertEquals("media-original", result.mediaId); assertFalse(result.pending)
        wire.state = "running"; assertFails { client.resolve("space-demo", "original") }
        wire.state = "succeeded"; wire.corruption = "identity"; assertFails { client.resolve("space-demo", "original") }
        assertEquals(1, wire.posts.size)
    }
    @Test fun explicitRejectionIsRetainedWithoutNewPost() = runBlocking {
        val store = SpeechMemoryStore(); val wire = SpeechFixtureWire(store).apply { reject = true }; val client = speechFixture(store, wire)
        assertFailsWith<GatewayException> { client.submit("space-demo", input, "original") }
        val record = client.records("space-demo").single()
        assertEquals("rejected", record.status); assertFalse(record.pending); assertEquals("speech_voice_unavailable", record.rejectedCode)
        assertFails { client.submit("space-demo", input, "original") }; assertEquals(1, wire.posts.size)
    }
    @Test fun corruptedOrExternallyRemovedStorageStopsWrites() = runBlocking {
        val store = SpeechMemoryStore().apply { data["https://nas.local#speech-syntheses"] = "{broken" }; val wire = SpeechFixtureWire(store)
        assertFails { speechFixture(store, wire).submit("space-demo", input, "original") }
        assertEquals("{broken", store.data["https://nas.local#speech-syntheses"]); assertEquals(0, store.saves); assertTrue(wire.posts.isEmpty())
        store.data.clear(); val client = speechFixture(store, wire); client.submit("space-demo", input, "original")
        store.data.clear(); assertFails { client.submit("space-demo", input, "removed") }; assertEquals(1, wire.posts.size)
    }
    @Test fun cancellationAfterSaveHasZeroPosts() = runBlocking {
        val store = SpeechMemoryStore(); val wire = SpeechFixtureWire(store); val client = speechFixture(store, wire)
        val task = async(start = CoroutineStart.LAZY) { client.submit("space-demo", input, "original") }
        store.afterSave = { task.cancel() }; task.start()
        assertFailsWith<CancellationException> { task.await() }; assertTrue(wire.posts.isEmpty())
        assertEquals("unresolved", client.records("space-demo").single().status)
        val changed = SpeechMemoryStore(); val otherWire = SpeechFixtureWire(changed); val other = speechFixture(changed, otherWire)
        changed.afterSave = { changed.data.replaceAll { _, value -> value.replace("\"voice\":\"local\"", "\"voice\":\"other\"") }; throw IOException("write acknowledgement lost") }
        assertEquals("speech_storage_failed", assertFailsWith<SpeechException> { other.submit("space-demo", input, "original") }.code)
        assertEquals("speech_storage_failed", assertFailsWith<SpeechException> { other.records("space-demo") }.code)
        assertTrue(otherWire.posts.isEmpty())
    }
    @Test fun concurrentInstancesSendOriginalOnlyOnce() = runBlocking {
        val store = SpeechMemoryStore(); val wire = SpeechFixtureWire(store).apply { delayPost = true }
        val first = speechFixture(store, wire); val second = speechFixture(store, wire)
        val a = async { first.submit("space-demo", input, "original") }; val b = async { second.submit("space-demo", input, "original") }
        assertEquals(a.await().original, b.await().original); assertEquals(1, wire.posts.size)
    }
}
