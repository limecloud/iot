package run.limeai.iot.core

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.serialization.json.*
import java.io.IOException
import kotlin.test.*

private class OtaMemoryStore : SessionStore {
    val data = mutableMapOf<String, String>(); var saves = 0; var failAt = 0
    override suspend fun load(origin: String) = data[origin]
    override suspend fun save(origin: String, value: String?) { saves++; if (saves == failAt) throw IOException("storage fixture"); if (value == null) data.remove(origin) else data[origin] = value }
}
private class OtaFixtureTransport : GatewayTransport {
    val requests = mutableListOf<GatewayRequest>(); val results = mutableMapOf<String, JsonObject>()
    var drop = false; var misbind = false; var missing = false; var delayPost = false
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        requests += request
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (request.method == "POST") {
            if (delayPost) delay(100)
            val key = request.headers.getValue("Idempotency-Key"); val change = OtaJSON.change(request.body!!)
            val original = buildJsonObject { put("space_id", "space-demo"); put("idempotency_key", key); put("change", change) }
            val resource = buildJsonObject { put("kind", if (change["type"] == JsonPrimitive("trust.revoke")) "firmware_trust" else "ota_task"); put("id", if (change["type"] == JsonPrimitive("trust.revoke")) change.getValue("trust_id") else change["task_id"] ?: JsonPrimitive("ota-fixture")); put("revision", "revision-current") }
            val result = buildJsonObject {
                put("operation_id", "otaop-$key"); put("request", original); put("request_digest", OtaJSON.digest(original)); put("status", "applied"); put("reason", JsonNull); put("resource", resource); put("created_at", "2026-11-02T00:00:00Z")
            }; results[key] = result
            if (drop) throw IOException("response lost")
            val response = if (misbind) JsonObject(result + ("request_digest" to JsonPrimitive("sha256:" + "0".repeat(64)))) else result
            return GatewayResponse(200, response.toString())
        }
        val key = request.url.substringAfterLast('/')
        return if (missing || key !in results) GatewayResponse(404, """{"error":{"code":"not_found"}}""") else GatewayResponse(200, results.getValue(key).toString())
    }
    val posts get() = requests.filter { it.method == "POST" && it.url.endsWith("/ota-operations") }
}
private val nativePlan = """{"type":"tasks.plan","device_id":"device-lamp","trust_id":"fwtrust-${"1".repeat(64)}","manifest":{},"expires_at":"2030-01-01T00:00:00Z"}"""
private suspend fun otaFixture(store: OtaMemoryStore, transport: OtaFixtureTransport): OtaClient {
    val gateway = GatewayClient("https://nas.local", transport)
    gateway.login("owner-input")
    return OtaClient(gateway, store)
}
class OtaClientTest {
    @Test fun strictJSONAndCanonicalDigest() {
        for (text in listOf("""{"a":1,"\u0061":2}""", """{"n":9007199254740992}""", """{"n":0.5}""", """{"n":1e99999999}""", """{"n":01}""", """{"s":"\ud800"}""", """{"a":[1,]}""")) assertFailsWith<OtaException> { OtaJSON.parse(text) }
        assertEquals("{\"a\":1,\"b\":0,\"中文\":\"/\\n\"}", OtaJSON.canonical(OtaJSON.parse("""{"中文":"/\n","b":-0,"a":1e0}""")))
        assertEquals("sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862", OtaJSON.digest(OtaJSON.parse("""{"a":1}""")))
    }
    @Test fun storageFailureNeverSends() = runBlocking {
        val store = OtaMemoryStore().apply { failAt = 1 }; val wire = OtaFixtureTransport(); val client = otaFixture(store, wire)
        assertFailsWith<OtaException> { client.submit("space-demo", OtaJSON.change(nativePlan), "first") }
        assertEquals(0, wire.posts.size)
    }
    @Test fun responseLossAndRecreationOnlyResolveOriginal() = runBlocking {
        val store = OtaMemoryStore(); val wire = OtaFixtureTransport().apply { drop = true }; val client = otaFixture(store, wire)
        assertFailsWith<IOException> { client.submit("space-demo", OtaJSON.change(nativePlan), "original") }
        assertEquals(1, wire.posts.size); assertNull(client.records("space-demo").single().result)
        assertEquals("ota_pending_operation", assertFailsWith<OtaException> { client.submit("space-demo", OtaJSON.change(nativePlan), "replacement") }.code)
        assertEquals(1, wire.posts.size)
        val restored = otaFixture(store, wire)
        wire.missing = true; assertFailsWith<GatewayException> { restored.resolve("space-demo", "original") }; assertNull(restored.records("space-demo").single().result)
        wire.missing = false
        assertNotNull(restored.resolve("space-demo", "original").result)
        assertNotNull(restored.submit("space-demo", OtaJSON.change(nativePlan), "original").result)
        assertEquals(1, wire.posts.size)
        val post = wire.posts.single(); assertEquals("csrf", post.headers["X-CSRF-Token"]); assertEquals("https://nas.local", post.headers["Origin"]); assertNull(post.headers["Authorization"])
        assertEquals(OtaJSON.change(nativePlan), OtaJSON.parse(post.body!!))
        assertTrue(wire.requests.last().url.endsWith("/ota-operations/by-key/original")); assertEquals("GET", wire.requests.last().method)
    }
    @Test fun misboundResponseAndLostResultSaveStayUnknown() = runBlocking {
        for (badResponse in listOf(true, false)) {
            val store = OtaMemoryStore().apply { if (!badResponse) failAt = 2 }; val wire = OtaFixtureTransport().apply { misbind = badResponse }; val client = otaFixture(store, wire)
            assertFailsWith<OtaException> { client.submit("space-demo", OtaJSON.change(nativePlan), "original") }
            assertNull(client.records("space-demo").single().result)
            assertNotNull(otaFixture(store, wire).resolve("space-demo", "original").result)
            assertEquals(1, wire.posts.size)
        }
    }
    @Test fun corruptedOrRemovedRecordsRemainAndBlockWrites() = runBlocking {
        val key = "https://nas.local#ota-operations"
        val store = OtaMemoryStore().apply { data[key] = "{broken" }; val wire = OtaFixtureTransport(); val client = otaFixture(store, wire)
        assertFailsWith<OtaException> { client.submit("space-demo", OtaJSON.change(nativePlan), "first") }; assertEquals("{broken", store.data[key]); assertEquals(0, store.saves); assertEquals(0, wire.posts.size)
        val secondStore = OtaMemoryStore(); val second = otaFixture(secondStore, wire)
        second.submit("space-demo", OtaJSON.change(nativePlan), "saved"); secondStore.data.remove(key)
        assertEquals("ota_record_changed", assertFailsWith<OtaException> { second.submit("space-demo", OtaJSON.change(nativePlan), "new") }.code)
        assertEquals(1, wire.posts.size)
    }
    @Test fun pendingPlanStillAllowsExplicitRevocation() = runBlocking {
        val store = OtaMemoryStore(); val wire = OtaFixtureTransport().apply { drop = true }; val client = otaFixture(store, wire)
        assertFailsWith<IOException> { client.submit("space-demo", OtaJSON.change(nativePlan), "plan") }; wire.drop = false
        val revoke = OtaJSON.change("""{"type":"trust.revoke","trust_id":"fwtrust-${"1".repeat(64)}","expected_revision":"current"}""")
        assertNotNull(client.submit("space-demo", revoke, "revoke").result); assertEquals(2, wire.posts.size)
    }
    @Test fun concurrentInstancesCannotOverwriteOriginalRecords() = runBlocking {
        val store = OtaMemoryStore(); val wire = OtaFixtureTransport().apply { delayPost = true }
        val first = otaFixture(store, wire); val second = otaFixture(store, wire)
        val a = async { first.submit("space-demo", OtaJSON.change(nativePlan), "shared") }
        val b = async { second.submit("space-demo", OtaJSON.change(nativePlan), "shared") }
        assertEquals(a.await().result, b.await().result)
        assertEquals(1, wire.posts.size); assertEquals(1, second.records("space-demo").size)
    }
}
