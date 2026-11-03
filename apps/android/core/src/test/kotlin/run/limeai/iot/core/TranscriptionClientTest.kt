package run.limeai.iot.core

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File
import java.io.IOException
import kotlin.test.*

private fun transcriptionVector(): JsonObject {
    val file = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/transcription/contract.json") }.first { it.isFile }
    return IntegerJSON.parse(file.readText())
}
private class TranscriptionMemoryStore : SessionStore {
    val data = mutableMapOf<String, String>(); var saves = 0; var failAt = 0
    var afterSave: (() -> Unit)? = null
    override suspend fun load(origin: String) = data[origin]
    override suspend fun save(origin: String, value: String?) {
        saves++; if (saves == failAt) throw IOException("storage fixture")
        if (value == null) data.remove(origin) else data[origin] = value
        afterSave?.invoke()
    }
}
private class TranscriptionFixtureWire(val store: TranscriptionMemoryStore) : GatewayTransport {
    val vector = transcriptionVector(); val requests = mutableListOf<GatewayRequest>()
    var savedBeforePosts = true; var drop = false; var missing = false; var reject = false
    var state = "running"; var corruption = ""; var delayPost = false
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        requests += request
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (request.url.endsWith("/capabilities")) return GatewayResponse(200, buildJsonObject { put("transcription", vector.getValue("capabilities")) }.toString())
        if (request.method == "POST") {
            val saved = IntegerJSON.parse(store.data.getValue("https://nas.local#audio-transcriptions"))["records"]!!.jsonArray.single().jsonObject
            savedBeforePosts = savedBeforePosts && saved["original"] == vector["original"]
            if (request.url.endsWith("/discard")) {
                savedBeforePosts = savedBeforePosts && saved["discard_intents"] == JsonArray(listOf(JsonPrimitive("discard-intent"))); state = "discarded"
            } else savedBeforePosts = savedBeforePosts && request.headers["Idempotency-Key"] == "original" && TranscriptionRequests.parse(request.body!!) == vector["normalized"]
            if (delayPost) delay(100)
            if (reject) return GatewayResponse(422, """{"error":{"code":"transcription_source_unavailable"}}""")
            if (drop) throw IOException("response lost")
        }
        if (missing) return GatewayResponse(404, """{"error":{"code":"transcription_not_found"}}""")
        val task = (vector.getValue("tasks").jsonObject[state] ?: vector.getValue("invalid_tasks").jsonObject.getValue(state)).jsonObject
        val result = when (corruption) {
            "digest" -> JsonObject(task + ("request_digest" to JsonPrimitive("sha256:" + "0".repeat(64))))
            "deployment" -> JsonObject(task + ("deployment" to JsonObject(task.getValue("deployment").jsonObject + ("model" to JsonPrimitive("changed/model")))))
            "identity" -> JsonObject(task + ("transcription_id" to JsonPrimitive("transcription-other")))
            "time" -> JsonObject(task + ("updated_at" to JsonPrimitive("2026-11-02T23:59:59.123Z")))
            "extra" -> JsonObject(task + ("text" to JsonPrimitive("must reject")))
            else -> task
        }
        return GatewayResponse(200, result.toString())
    }
    val posts get() = requests.filter { it.method == "POST" && it.url.contains("/audio-transcriptions") }
}
private suspend fun transcriptionFixture(store: TranscriptionMemoryStore, wire: TranscriptionFixtureWire): TranscriptionClient {
    val gateway = GatewayClient("https://nas.local", wire); gateway.login("owner-input"); return TranscriptionClient(gateway, store)
}
class TranscriptionClientTest {
    private val vector = transcriptionVector()
    private val input get() = vector.getValue("input").jsonObject
    @Test fun sharedUnicodeTimeNormalizationAndBounds() {
        assertEquals(vector["normalized"], TranscriptionRequests.parse(input.toString()))
        for ((key, value) in mapOf("expires_at" to JsonPrimitive("2026-11-03T00:01:25.1234Z"), "language" to JsonPrimitive("fr"), "media_id" to JsonPrimitive("other"), "media_digest" to JsonPrimitive("sha256:bad"))) assertFails { TranscriptionRequests.parse(JsonObject(input + (key to value)).toString()) }
    }
    @Test fun originalSavedBeforePostAndSameKeyOnlyQueries() = runBlocking {
        val store = TranscriptionMemoryStore(); val wire = TranscriptionFixtureWire(store); val client = transcriptionFixture(store, wire)
        val capabilities = client.capabilities("space-demo"); assertTrue(capabilities.configured)
        val record = client.submit("space-demo", input, "original")
        assertEquals(vector["original"], record.original); assertEquals(vector.getValue("tasks").jsonObject["running"], record.observation)
        val saved = store.data.getValue("https://nas.local#audio-transcriptions")
        assertFalse(saved.contains("青柠")); assertFalse(saved.contains("owner-input")); assertFalse(saved.contains("\"text\"")); assertTrue(wire.savedBeforePosts)
        client.submit("space-demo", vector.getValue("normalized").jsonObject, "original")
        assertEquals("transcription_pending", assertFailsWith<TranscriptionException> { client.submit("space-demo", input, "replacement") }.code)
        assertFails { client.submit("space-demo", JsonObject(input + ("language" to JsonPrimitive("auto"))), "original") }
        assertEquals(1, wire.posts.size); assertEquals("GET", wire.requests.last().method)
        assertEquals("csrf", wire.posts.single().headers["X-CSRF-Token"]); assertNull(wire.posts.single().headers["Authorization"])
    }
    @Test fun originalAndReceiptStorageFailuresDoNotRepeatPost() = runBlocking {
        for (failure in listOf(1, 2)) {
            val store = TranscriptionMemoryStore().apply { failAt = failure }; val wire = TranscriptionFixtureWire(store); val client = transcriptionFixture(store, wire)
            assertEquals("transcription_storage_failed", assertFailsWith<TranscriptionException> { client.submit("space-demo", input, "original") }.code)
            assertEquals(failure - 1, wire.posts.size)
            if (failure == 2) { transcriptionFixture(store, wire).resolve("space-demo", "original"); assertEquals(1, wire.posts.size) }
        }
    }
    @Test fun lostResponse404AndUnknownNeverResubmit() = runBlocking {
        val store = TranscriptionMemoryStore(); val wire = TranscriptionFixtureWire(store).apply { drop = true }; val client = transcriptionFixture(store, wire)
        assertFailsWith<IOException> { client.submit("space-demo", input, "original") }
        val restored = transcriptionFixture(store, wire); wire.drop = false; wire.missing = true
        assertEquals("transcription_unknown", assertFailsWith<TranscriptionException> { restored.resolve("space-demo", "original") }.code)
        assertEquals("unresolved", restored.records("space-demo").single().status)
        wire.missing = false; wire.state = "unknown"; restored.resolve("space-demo", "original")
        assertEquals("transcription_pending", assertFailsWith<TranscriptionException> { restored.submit("space-demo", input, "replacement") }.code)
        wire.state = "succeeded"; assertFails { restored.resolve("space-demo", "original") }
        wire.state = "unknown"; wire.corruption = "deployment"; assertFails { restored.resolve("space-demo", "original") }
        wire.corruption = ""; val discarded = restored.discard("space-demo", "original", "discard-intent")
        assertEquals("discarded", discarded.status); assertNull(discarded.text)
        restored.discard("space-demo", "original", "discard-intent")
        assertEquals(2, wire.posts.size); assertTrue(wire.savedBeforePosts)
    }
    @Test fun malformedReceiptDoesNotReplaceOriginal() = runBlocking {
        for (corruption in listOf("digest", "time", "extra")) {
            val store = TranscriptionMemoryStore(); val wire = TranscriptionFixtureWire(store).apply { this.corruption = corruption }; val client = transcriptionFixture(store, wire)
            assertFails { client.submit("space-demo", input, "original") }; assertNull(client.records("space-demo").single().observation)
            wire.corruption = ""; transcriptionFixture(store, wire).resolve("space-demo", "original"); assertEquals(1, wire.posts.size)
        }
    }
    @Test fun successReturnsMediaIdAndRejectsTerminalRollbackOrIdentityDrift() = runBlocking {
        val store = TranscriptionMemoryStore(); val wire = TranscriptionFixtureWire(store); val client = transcriptionFixture(store, wire)
        client.submit("space-demo", input, "original"); wire.state = "succeeded"
        val result = client.resolve("space-demo", "original"); assertEquals("青柠🍋\n你好", result.text); assertFalse(result.pending)
        wire.state = "running"; assertFails { client.resolve("space-demo", "original") }
        wire.state = "succeeded"; wire.corruption = "identity"; assertFails { client.resolve("space-demo", "original") }
        assertEquals(1, wire.posts.size)
    }
    @Test fun explicitRejectionIsRetainedWithoutNewPost() = runBlocking {
        val store = TranscriptionMemoryStore(); val wire = TranscriptionFixtureWire(store).apply { reject = true }; val client = transcriptionFixture(store, wire)
        assertFailsWith<GatewayException> { client.submit("space-demo", input, "original") }
        val record = client.records("space-demo").single()
        assertEquals("rejected", record.status); assertFalse(record.pending); assertEquals("transcription_source_unavailable", record.rejectedCode)
        assertFails { client.submit("space-demo", input, "original") }; assertEquals(1, wire.posts.size)
    }
    @Test fun corruptedOrExternallyRemovedStorageStopsWrites() = runBlocking {
        val store = TranscriptionMemoryStore().apply { data["https://nas.local#audio-transcriptions"] = "{broken" }; val wire = TranscriptionFixtureWire(store)
        assertFails { transcriptionFixture(store, wire).submit("space-demo", input, "original") }
        assertEquals("{broken", store.data["https://nas.local#audio-transcriptions"]); assertEquals(0, store.saves); assertTrue(wire.posts.isEmpty())
        store.data.clear(); val client = transcriptionFixture(store, wire); client.submit("space-demo", input, "original")
        store.data.clear(); assertFails { client.submit("space-demo", input, "removed") }; assertEquals(1, wire.posts.size)
    }
    @Test fun cancellationAfterSaveHasZeroPosts() = runBlocking {
        val store = TranscriptionMemoryStore(); val wire = TranscriptionFixtureWire(store); val client = transcriptionFixture(store, wire)
        val task = async(start = CoroutineStart.LAZY) { client.submit("space-demo", input, "original") }
        store.afterSave = { task.cancel() }; task.start()
        assertFailsWith<CancellationException> { task.await() }; assertTrue(wire.posts.isEmpty())
        assertEquals("unresolved", client.records("space-demo").single().status)
        val changed = TranscriptionMemoryStore(); val otherWire = TranscriptionFixtureWire(changed); val other = transcriptionFixture(changed, otherWire)
        changed.afterSave = { changed.data.replaceAll { _, value -> value.replace("\"media_id\":\"media-source\"", "\"media_id\":\"media-other\"") }; throw IOException("write acknowledgement lost") }
        assertEquals("transcription_storage_failed", assertFailsWith<TranscriptionException> { other.submit("space-demo", input, "original") }.code)
        assertEquals("transcription_storage_failed", assertFailsWith<TranscriptionException> { other.records("space-demo") }.code)
        assertTrue(otherWire.posts.isEmpty())
    }
    @Test fun concurrentInstancesSendOriginalOnlyOnce() = runBlocking {
        val store = TranscriptionMemoryStore(); val wire = TranscriptionFixtureWire(store).apply { delayPost = true }
        val first = transcriptionFixture(store, wire); val second = transcriptionFixture(store, wire)
        val a = async { first.submit("space-demo", input, "original") }; val b = async { second.submit("space-demo", input, "original") }
        assertEquals(a.await().original, b.await().original); assertEquals(1, wire.posts.size)
    }
    @Test fun successfulPlaintextIsNeverPersistedAndClearedOutputCannotResurrect() = runBlocking {
        val store = TranscriptionMemoryStore(); val wire = TranscriptionFixtureWire(store).apply { state = "succeeded" }; val client = transcriptionFixture(store, wire)
        val success = client.submit("space-demo", input, "original"); assertEquals("青柠🍋\n你好", success.text)
        val saved = store.data.getValue("https://nas.local#audio-transcriptions")
        assertFalse(saved.contains("青柠")); assertFalse(saved.contains("\"text\"")); assertTrue(saved.contains("content_digest"))
        val restored = transcriptionFixture(store, wire); assertNull(restored.records("space-demo").single().text)
        wire.state = "cleared"; val cleared = restored.resolve("space-demo", "original"); assertNull(cleared.text); assertEquals("succeeded", cleared.status)
        wire.state = "succeeded"; assertFails { restored.resolve("space-demo", "original") }; assertEquals(1, wire.posts.size)
    }
    @Test fun emptyRecognitionIsValid() = runBlocking {
        val store = TranscriptionMemoryStore(); val wire = TranscriptionFixtureWire(store).apply { state = "empty" }
        assertEquals("", transcriptionFixture(store, wire).submit("space-demo", input, "original").text)
        val timezoneStore = TranscriptionMemoryStore(); val timezoneWire = TranscriptionFixtureWire(timezoneStore).apply { state = "timezone" }
        val client = transcriptionFixture(timezoneStore, timezoneWire)
        assertEquals("青柠🍋\n你好", client.submit("space-demo", input, "original").text); assertNotNull(client.records("space-demo").single().observation)
        Unit
    }

    @Test fun malformedOutputNeverReplacesOriginal() = runBlocking {
        for (name in vector.getValue("invalid_tasks").jsonObject.keys) {
            val store = TranscriptionMemoryStore(); val wire = TranscriptionFixtureWire(store).apply { state = name }; val client = transcriptionFixture(store, wire)
            assertFails { client.submit("space-demo", input, "original") }; assertNull(client.records("space-demo").single().observation)
        }
    }

}
