package run.limeai.iot.core

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File
import java.io.IOException
import kotlin.test.*

private fun observationFixture() = ObservationJSON.parse(File(System.getenv("LIMEIOT_OBSERVATION_FIXTURE") ?: "../../../tests/fixtures/zigbee/observation-native.json").readText(), response = true)
private class ObservationMemory : SessionStore {
    val values = mutableMapOf<String, String>()
    var fail = false; var mismatch = false; var hold: CompletableDeferred<Unit>? = null; var waiting = false
    override suspend fun load(origin: String) = values[origin]
    override suspend fun save(origin: String, value: String?) {
        if (fail) throw IOException("storage fixture")
        if (!mismatch) { if (value == null) values.remove(origin) else values[origin] = value }
        hold?.let { waiting = true; withContext(NonCancellable) { it.await() }; waiting = false }
    }
}
private class ObservationWire : GatewayTransport {
    val vector = observationFixture(); val requests = mutableListOf<GatewayRequest>(); val results = mutableMapOf<String, JsonObject>()
    var drop = false; var missing = false; var corrupt = false; var changed = false; var queryMismatch = false
    var discoveryMismatch = false
    val posts get() = requests.count { it.url.endsWith("/observation-operations") && it.method == "POST" }
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        requests += request
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (request.url.endsWith("/observation-discoveries") || request.url.endsWith("/observation-endpoints")) {
            val result = vector.getValue(if (request.url.endsWith("/observation-discoveries")) "discovery" else "endpoints").jsonObject
            return GatewayResponse(200, (if (discoveryMismatch) JsonObject(result + ("coordinator_ieee" to JsonPrimitive("8877665544332211"))) else result).toString())
        }
        if (request.url.endsWith("/observation-candidates")) {
            if (request.method == "POST") {
                val c = vector.getValue("candidate").jsonObject
                return GatewayResponse(200, (if (queryMismatch) JsonObject(c + ("target" to JsonObject(c.getValue("target").jsonObject + ("endpoint" to JsonPrimitive(2))))) else c).toString())
            }
            return GatewayResponse(200, vector.getValue("page").toString())
        }
        val key = request.headers["Idempotency-Key"] ?: request.url.substringAfterLast('/')
        if (request.url.endsWith("/observation-operations") && request.method == "POST") {
            val change = ObservationJSON.parse(request.body!!); val device = change.getValue("device_id")
            val original = buildJsonObject { put("space_id", "space-demo"); put("idempotency_key", key); put("change", change) }
            val created = "2030-01-01T00:00:01Z"; val op = "observationop-$key"
            val base = vector.getValue("current").jsonObject.getValue("binding").jsonObject
            val b = JsonObject(base + mapOf("policy" to JsonObject(base.getValue("policy").jsonObject + ("device_id" to device)), "active" to JsonPrimitive(change["type"] == JsonPrimitive("sources.bind")), "generation" to JsonPrimitive(op), "changed_at" to JsonPrimitive(created)))
            val view = buildJsonObject { put("device_id", device); put("revision", ObservationJSON.digest(buildJsonArray { add("observation-binding-v1"); add(device); add(b) })); put("binding", b) }
            results[key] = buildJsonObject { put("operation_id", op); put("sequence", 1); put("request", original); put("request_digest", ObservationJSON.digest(original)); put("status", "applied"); put("reason", JsonNull); put("result", view); put("created_at", created) }
            if (drop) throw IOException("response lost")
        }
        val result = results[key]
        if (missing || result == null) return GatewayResponse(404, """{"error":{"code":"not_found"}}""")
        val output = when { corrupt -> JsonObject(result + ("request_digest" to JsonPrimitive("sha256:" + "0".repeat(64)))); changed -> JsonObject(result + mapOf("status" to JsonPrimitive("conflict"), "reason" to JsonPrimitive("revision_conflict"), "result" to JsonNull)); else -> result }
        return GatewayResponse(200, output.toString())
    }
}
private suspend fun observationClient(store: ObservationMemory, wire: ObservationWire): ObservationClient {
    val gateway = GatewayClient("https://nas.local", wire); gateway.login("owner-input"); return ObservationClient(gateway, store)
}
class ObservationClientTest {
    @Test fun sharedDiscoveryVectorsAndEndpointCapabilities() {
        val v = observationFixture(); val coordinator = ObservationJSON.candidates(v.getValue("page").jsonObject).coordinators.single()
        val found = ObservationDiscoveryJSON.discovery(v.getValue("discovery").jsonObject, coordinator)
        val endpoints = ObservationDiscoveryJSON.endpoints(v.getValue("endpoints").jsonObject, coordinator, "1122334455667788")
        assertEquals(1, found.items.size); assertTrue(endpoints.items[0].supportsEnvironment); assertFalse(endpoints.items[1].supportsEnvironment)
        for (item in v.getValue("invalidDiscovery").jsonArray) assertFailsWith<ObservationException>(item.jsonObject.getValue("name").jsonPrimitive.content) { ObservationDiscoveryJSON.discovery(item.jsonObject.getValue("document").jsonObject, coordinator) }
        for (item in v.getValue("invalidEndpoints").jsonArray) assertFailsWith<ObservationException>(item.jsonObject.getValue("name").jsonPrimitive.content) { ObservationDiscoveryJSON.endpoints(item.jsonObject.getValue("document").jsonObject, coordinator, "1122334455667788") }
        for (invalid in listOf("1122334455667788\n", "ffffffffffffffff")) assertFailsWith<ObservationException> { ObservationDiscoveryJSON.query("home-znp", invalid) }
    }
    @Test fun discoveryUsesSharedSessionAndNeverPersistsOrBinds() = runBlocking {
        val memory = ObservationMemory(); val wire = ObservationWire(); val client = observationClient(memory, wire)
        client.discover("space-demo", "home-znp"); client.endpoints("space-demo", "home-znp", "1122334455667788")
        val requests = wire.requests.filter { it.url.endsWith("/observation-discoveries") || it.url.endsWith("/observation-endpoints") }
        assertEquals(2, requests.size); assertTrue(requests.all { it.timeoutMillis == 35000L && it.method == "POST" && it.headers["X-CSRF-Token"] == "csrf" && "Authorization" !in it.headers })
        assertTrue(memory.values.isEmpty()); assertTrue(client.records("space-demo").isEmpty())
        wire.discoveryMismatch = true
        assertFailsWith<ObservationException> { client.discover("space-demo", "home-znp") }
        assertFailsWith<ObservationException> { client.endpoints("space-demo", "home-znp", "1122334455667788") }; assertEquals(0, wire.posts)
    }
    @Test fun sharedContractVectorsAndStrictInputs() {
        val v = observationFixture(); ObservationJSON.candidate(v.getValue("candidate").jsonObject); ObservationJSON.candidates(v.getValue("page").jsonObject)
        for (key in listOf("empty", "current", "revoked")) ObservationJSON.binding(v.getValue(key).jsonObject, "sensor")
        for (key in listOf("operation", "revokeOperation", "rejected", "conflict")) ObservationJSON.operation(v.getValue(key).jsonObject)
        for (text in listOf("""{"a":1,"\u0061":2}""", """{"n":0.5}""", """{"n":9007199254740992}""", """{"s":"\ud800"}""")) assertFailsWith<ObservationException> { ObservationJSON.parse(text) }
        assertFailsWith<ObservationException> { ObservationJSON.change(JsonObject(v.getValue("bind").jsonObject + ("device_id" to JsonPrimitive("sensor\n")))) }
        assertFailsWith<ObservationException> { ObservationJSON.candidate(JsonObject(v.getValue("candidate").jsonObject + ("expires_at" to JsonPrimitive("2030-01-01T00:01:01Z")))) }
        assertFailsWith<ObservationException> { ObservationJSON.operation(JsonObject(v.getValue("operation").jsonObject + ("sequence" to JsonPrimitive(257)))) }
    }
    @Test fun storageAndReadbackFailureNeverPost() = runBlocking {
        for (mismatch in listOf(false, true)) {
            val store = ObservationMemory().apply { fail = !mismatch; this.mismatch = mismatch }; val wire = ObservationWire(); val client = observationClient(store, wire)
            assertFailsWith<ObservationException> { client.submit("space-demo", wire.vector.getValue("bind").jsonObject, "original") }; assertEquals(0, wire.posts)
        }
    }
    @Test fun responseLossBlocksDeviceAndSourceAndOnlyResolvesOriginal() = runBlocking {
        val store = ObservationMemory(); val wire = ObservationWire().apply { drop = true }; val client = observationClient(store, wire); val change = wire.vector.getValue("bind").jsonObject
        assertFailsWith<IOException> { client.submit("space-demo", change, "original") }
        assertEquals("observation_pending_operation", assertFailsWith<ObservationException> { client.submit("space-demo", change, "replacement") }.code)
        assertEquals("observation_pending_operation", assertFailsWith<ObservationException> { client.submit("space-demo", JsonObject(change + ("device_id" to JsonPrimitive("renamed"))), "renamed") }.code)
        val restored = observationClient(store, wire)
        wire.drop = false; wire.missing = true; assertFailsWith<GatewayException> { restored.submit("space-demo", change, "original") }
        wire.missing = false; wire.corrupt = true; assertFailsWith<ObservationException> { restored.resolve("space-demo", "original") }
        assertTrue(restored.records("space-demo").single().pending)
        wire.corrupt = false; assertEquals("applied", restored.submit("space-demo", change, "original").status); assertEquals(1, wire.posts)
        wire.changed = true; assertFailsWith<ObservationException> { restored.resolve("space-demo", "original") }; assertEquals("applied", restored.records("space-demo").single().status)
        assertTrue(wire.requests.filter { it.url.endsWith("/observation-operations") }.all { "Authorization" !in it.headers && it.headers["X-CSRF-Token"] == "csrf" })
    }
    @Test fun cancelledSaveRetainsOriginalWithoutSending() = runBlocking {
        val store = ObservationMemory().apply { hold = CompletableDeferred() }; val wire = ObservationWire(); val client = observationClient(store, wire)
        val pending = async { client.submit("space-demo", wire.vector.getValue("bind").jsonObject, "original") }
        withTimeout(2000) { while (!store.waiting) delay(5) }; pending.cancel(); store.hold!!.complete(Unit)
        assertFailsWith<CancellationException> { pending.await() }; assertEquals(0, wire.posts)
        val restored = observationClient(store, wire); assertTrue(restored.records("space-demo").single().pending)
        store.values.clear(); assertEquals("observation_record_changed", assertFailsWith<ObservationException> { restored.submit("space-demo", wire.vector.getValue("bind").jsonObject, "new-key") }.code); assertEquals(0, wire.posts)
    }
    @Test fun crossInstanceWritesDoNotOverwritePendingRecord() = runBlocking {
        val store = ObservationMemory().apply { hold = CompletableDeferred() }; val wire = ObservationWire().apply { drop = true }; val first = observationClient(store, wire); val second = observationClient(store, wire)
        val a = async { runCatching { first.submit("space-demo", wire.vector.getValue("bind").jsonObject, "first") } }
        withTimeout(2000) { while (!store.waiting) delay(5) }
        val b = async { runCatching { second.submit("space-demo", wire.vector.getValue("bind").jsonObject, "second") } }
        store.hold!!.complete(Unit); assertIs<IOException>(a.await().exceptionOrNull()); assertIs<ObservationException>(b.await().exceptionOrNull()); assertEquals(1, wire.posts); assertEquals("first", second.records("space-demo").single().key)
    }
    @Test fun queryValidatesTargetAndUsesSeparateTimeout() = runBlocking {
        val wire = ObservationWire(); val client = observationClient(ObservationMemory(), wire)
        client.query("space-demo", "home-znp", "1122334455667788", 1)
        assertEquals(35000, wire.requests.last().timeoutMillis); assertEquals(12000, wire.requests.first().timeoutMillis)
        wire.queryMismatch = true; assertFailsWith<ObservationException> { client.query("space-demo", "home-znp", "1122334455667788", 1) }; assertEquals(0, wire.posts)
    }
}
