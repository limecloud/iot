package run.limeai.iot.core

import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import java.io.File
import java.io.IOException
import kotlin.test.*

internal fun mediaVector(): JsonObject {
    val file = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/media/upload.json") }.first { it.isFile }
    return OtaJSON.parse(file.readText(), response = true)
}
private class MediaMemoryStore : SessionStore {
    val data = mutableMapOf<String, String>(); var saves = 0; var failAt = 0
    var afterSave: (() -> Unit)? = null
    override suspend fun load(origin: String) = data[origin]
    override suspend fun save(origin: String, value: String?) { saves++; if (saves == failAt) throw IOException("storage fixture"); if (value == null) data.remove(origin) else data[origin] = value; afterSave?.invoke() }
}
private class MediaFixtureWire : GatewayTransport {
    val vector = mediaVector(); val requests = mutableListOf<GatewayRequest>(); val results = mutableMapOf<String, JsonObject>()
    var drop = false; var missing = false; var issued = true; var corruption = ""; var page: String? = null; var delayPost = false
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        requests += request
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (request.url.endsWith("/media")) return GatewayResponse(200, page ?: """{"space_id":"space-demo","configured":false,"items":[],"grants":[],"next_cursor":null}""")
        val key = request.headers["Idempotency-Key"] ?: request.url.substringAfterLast('/')
        if (request.method == "POST") {
            if (delayPost) delay(100)
            val c = MediaChanges.parse(request.body!!)
            val original = buildJsonObject { put("space_id", "space-demo"); put("idempotency_key", key); put("change", c) }
            val result = when (c["type"]) {
                JsonPrimitive("media.grant") -> buildJsonObject {
                    put("type", "granted"); put("grant_id", "grant-" + key); put("media_id", c.getValue("media_id")); put("device_id", c.getValue("device_id"))
                    put("binding_revision", c.getValue("expected_binding_revision")); put("created_at", "2026-11-03T00:00:00Z"); put("expires_at", "2026-11-03T00:05:00Z"); put("issued_in_process", true)
                }
                JsonPrimitive("media.delete") -> buildJsonObject { put("type", "deleted"); put("media_id", c.getValue("media_id")) }
                JsonPrimitive("media.revoke") -> buildJsonObject { put("type", "revoked"); put("grant_id", c.getValue("grant_id")) }
                else -> vector.getValue("operation").jsonObject.getValue("result")
            }
            results[key] = JsonObject(vector.getValue("operation").jsonObject + mapOf("operation_id" to JsonPrimitive("mediaop-" + key), "idempotency_key" to JsonPrimitive(key), "kind" to c.getValue("type"), "request_digest" to JsonPrimitive(OtaJSON.digest(original)), "result" to result))
            if (drop) throw IOException("response lost")
        }
        if (missing || key !in results) return GatewayResponse(404, """{"error":{"code":"media_operation_not_found"}}""")
        var value = results.getValue(key)
        if (value["kind"] == JsonPrimitive("media.grant")) value = JsonObject(value + ("result" to JsonObject(value.getValue("result").jsonObject + ("issued_in_process" to JsonPrimitive(issued)))))
        value = when (corruption) {
            "space" -> JsonObject(value + ("space_id" to JsonPrimitive("other")))
            "digest" -> JsonObject(value + ("request_digest" to JsonPrimitive("sha256:" + "0".repeat(64))))
            "url" -> JsonObject(value + ("result" to JsonObject(value.getValue("result").jsonObject + ("download_url" to JsonPrimitive("http://invalid.local/token")))))
            "media" -> {
                val result = value.getValue("result").jsonObject; val media = result.getValue("media").jsonObject
                JsonObject(value + ("result" to JsonObject(result + ("media" to JsonObject(media + ("content_digest" to JsonPrimitive("sha256:" + "0".repeat(64))))))))
            }
            else -> value
        }
        val text = value.toString()
        return GatewayResponse(200, if (corruption == "duplicate") text.dropLast(1) + ""","space_id":"space-demo"}""" else text)
    }
    val posts get() = requests.filter { it.method == "POST" && it.url.endsWith("/media-operations") }
}
private suspend fun mediaFixture(store: MediaMemoryStore, wire: MediaFixtureWire): MediaClient {
    val gateway = GatewayClient("https://nas.local", wire); gateway.login("owner-input"); return MediaClient(gateway, store)
}
class MediaClientTest {
    @Test fun inputIsFrozenBeforeStorageSuspension() = runBlocking {
        val vector = mediaVector(); val original = vector.getValue("change").jsonObject; val mutable = original.toMutableMap()
        val input = JsonObject(mutable); val store = MediaMemoryStore().apply {
            afterSave = { mutable.clear(); mutable["type"] = JsonPrimitive("media.delete"); mutable["media_id"] = JsonPrimitive("media-original") }
        }
        val wire = MediaFixtureWire(); val client = mediaFixture(store, wire)
        val result = client.submit("space-demo", input, "original")
        assertEquals(vector["original"], result.original); assertEquals(vector["operation"], result.result)
        assertEquals(original, MediaChanges.parse(wire.posts.single().body!!)); assertEquals(1, wire.posts.size)
    }
    @Test fun strictInputAndWavBounds() {
        val input = mediaVector().getValue("change").toString()
        for (text in listOf(input.dropLast(1) + ""","retain_seconds":600}""", input.replace("600", "59"), """{"type":"media.upload","content_base64":"AAAA","retain_seconds":600}""", """{"type":"media.delete","media_id":"m","url":"http://example.org"}""")) assertFails { MediaChanges.parse(text) }
        assertFailsWith<MediaException> { MediaChanges.upload(ByteArray(MediaChanges.MAX_AUDIO_BYTES + 1), 600) }
    }
    @Test fun storageFailureZeroPost() = runBlocking {
        val store = MediaMemoryStore().apply { failAt = 1 }; val wire = MediaFixtureWire(); val client = mediaFixture(store, wire)
        assertFails { client.submit("space-demo", mediaVector().getValue("change").jsonObject, "original") }; assertEquals(0, wire.posts.size)
    }
    @Test fun responseLossRestorationAnd404OnlyQuery() = runBlocking {
        val vector = mediaVector(); val upload = vector.getValue("change").jsonObject
        val store = MediaMemoryStore(); val wire = MediaFixtureWire().apply { drop = true }; val client = mediaFixture(store, wire)
        assertFailsWith<IOException> { client.submit("space-demo", upload, "original") }
        assertEquals("media_pending_operation", assertFailsWith<MediaException> { client.submit("space-demo", upload, "replacement") }.code)
        val saved = store.data.getValue("https://nas.local#media-operations")
        assertFalse(saved.contains("content_base64")); assertFalse(saved.contains("download_url")); assertFalse(saved.contains("owner-input"))
        val restored = mediaFixture(store, wire); wire.missing = true
        assertEquals("media_unknown", assertFailsWith<MediaException> { restored.resolve("space-demo", "original") }.code)
        assertNull(restored.records("space-demo").single().result); wire.missing = false; wire.drop = false
        val recovered = restored.resolve("space-demo", "original")
        assertEquals(vector["original"], recovered.original); assertEquals(vector["operation"], recovered.result)
        restored.submit("space-demo", upload, "original")
        assertFails { restored.submit("space-demo", JsonObject(upload + ("retain_seconds" to JsonPrimitive(601))), "original") }
        assertEquals(1, wire.posts.size); assertEquals("csrf", wire.posts.single().headers["X-CSRF-Token"]); assertNull(wire.posts.single().headers["Authorization"])
        assertEquals("GET", wire.requests.last().method)
    }
    @Test fun malformedReceiptsNeverReplacePendingOrRepeatPost() = runBlocking {
        for (corruption in listOf("space", "digest", "url", "media", "duplicate")) {
            val store = MediaMemoryStore(); val wire = MediaFixtureWire().apply { this.corruption = corruption }; val client = mediaFixture(store, wire)
            assertFails { client.submit("space-demo", mediaVector().getValue("change").jsonObject, "original") }
            assertNull(client.records("space-demo").single().result)
            wire.corruption = ""; mediaFixture(store, wire).resolve("space-demo", "original"); assertEquals(1, wire.posts.size)
        }
    }
    @Test fun failedResultSaveCorruptOrRemovedStoreStopNewWrites() = runBlocking {
        val upload = mediaVector().getValue("change").jsonObject
        val store = MediaMemoryStore().apply { failAt = 2 }; val wire = MediaFixtureWire(); val client = mediaFixture(store, wire)
        assertFails { client.submit("space-demo", upload, "original") }
        val restored = mediaFixture(store, wire); restored.resolve("space-demo", "original")
        store.data.remove("https://nas.local#media-operations")
        assertFails { restored.submit("space-demo", upload, "removed") }; assertEquals(1, wire.posts.size)
        val corrupted = MediaMemoryStore().apply { data["https://nas.local#media-operations"] = "{broken" }
        assertFails { mediaFixture(corrupted, wire).submit("space-demo", upload, "corrupt") }
        assertEquals("{broken", corrupted.data["https://nas.local#media-operations"]); assertEquals(0, corrupted.saves); assertEquals(1, wire.posts.size)
    }
    @Test fun oldGrantReceiptDoesNotReauthorizeAndRevocationStaysExplicit() = runBlocking {
        val store = MediaMemoryStore(); val wire = MediaFixtureWire(); val client = mediaFixture(store, wire)
        val grant = MediaChanges.grant("media-original", "speaker", "sha256:" + "1".repeat(64), 300)
        client.submit("space-demo", grant, "grant"); wire.issued = false
        assertEquals(JsonPrimitive(false), client.resolve("space-demo", "grant").result!!.getValue("result").jsonObject["issued_in_process"])
        client.submit("space-demo", MediaChanges.revoke("grant-grant"), "revoke"); client.submit("space-demo", MediaChanges.delete("media-original"), "delete")
        assertEquals(3, wire.posts.size)
    }
    @Test fun pagesRejectCrossSpaceAndExtraSecrets() = runBlocking {
        val store = MediaMemoryStore(); val wire = MediaFixtureWire(); val client = mediaFixture(store, wire)
        assertFalse(client.list("space-demo").configured)
        val vector = mediaVector(); wire.page = vector.getValue("page").toString()
        val valid = client.list("space-demo"); assertEquals(1, valid.items.size); assertEquals(1, valid.grants.size)
        for (page in vector.getValue("invalid_pages").jsonArray) { wire.page = page.toString(); assertFails { client.list("space-demo") } }
        for (page in listOf("""{"space_id":"other","configured":false,"items":[],"grants":[],"next_cursor":null}""", """{"space_id":"space-demo","configured":false,"items":[],"grants":[],"next_cursor":null,"token":"unexpected"}""")) {
            wire.page = page; assertFails { client.list("space-demo") }
        }
    }
    @Test fun concurrentInstancesOnlySendOnce() = runBlocking {
        val store = MediaMemoryStore(); val wire = MediaFixtureWire().apply { delayPost = true }
        val first = mediaFixture(store, wire); val second = mediaFixture(store, wire); val upload = mediaVector().getValue("change").jsonObject
        val a = async { first.submit("space-demo", upload, "original") }; val b = async { second.submit("space-demo", upload, "original") }
        assertEquals(a.await().result, b.await().result); assertEquals(1, wire.posts.size)
    }
}
