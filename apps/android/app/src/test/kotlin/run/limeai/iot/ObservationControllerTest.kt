package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.io.File
import java.io.IOException
import java.time.Instant
import kotlin.test.*

private fun vector(): JsonObject = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/zigbee/observation-native.json") }.first { it.isFile }.let { ObservationJSON.parse(it.readText(), response = true) }
private class SourceMemory : SessionStore {
    val values = mutableMapOf<String, String>(); var fail = false; var hold: CompletableDeferred<Unit>? = null; var waiting = false
    override suspend fun load(origin: String) = values[origin]
    override suspend fun save(origin: String, value: String?) {
        if (fail) throw IOException("storage fixture"); if (value == null) values.remove(origin) else values[origin] = value
        hold?.let { waiting = true; withContext(NonCancellable) { it.await() }; waiting = false }
    }
}
private class SourceWire : GatewayTransport {
    val v = vector(); var current = v.getValue("empty"); var posts = 0; var drop = false; var queryHold: CompletableDeferred<Unit>? = null; var waiting = false
    val results = mutableMapOf<String, JsonObject>()
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (request.url.endsWith("/observation-discoveries") || request.url.endsWith("/observation-endpoints")) {
            queryHold?.let { waiting = true; withContext(NonCancellable) { it.await() }; waiting = false }
            return GatewayResponse(200, v.getValue(if (request.url.endsWith("/observation-discoveries")) "discovery" else "endpoints").toString())
        }
        if (request.url.endsWith("/observation-candidates")) {
            if (request.method == "POST") queryHold?.let { waiting = true; withContext(NonCancellable) { it.await() }; waiting = false }
            return GatewayResponse(200, v.getValue(if (request.method == "POST") "candidate" else "page").toString())
        }
        if (request.url.endsWith("/observation-binding")) return GatewayResponse(200, current.toString())
        val key = request.headers["Idempotency-Key"] ?: request.url.substringAfterLast('/')
        if (request.url.endsWith("/observation-operations") && request.method == "POST") {
            posts++; val change = ObservationJSON.parse(request.body!!); val device = change.getValue("device_id"); val original = buildJsonObject { put("space_id", "space-demo"); put("idempotency_key", key); put("change", change) }
            val base = v.getValue("current").jsonObject.getValue("binding").jsonObject; val created = "2030-01-01T00:00:01Z"; val op = "observationop-$key"
            val binding = JsonObject(base + mapOf("policy" to JsonObject(base.getValue("policy").jsonObject + ("device_id" to device)), "active" to JsonPrimitive(change["type"] == JsonPrimitive("sources.bind")), "generation" to JsonPrimitive(op), "changed_at" to JsonPrimitive(created)))
            current = buildJsonObject { put("device_id", device); put("revision", ObservationJSON.digest(buildJsonArray { add("observation-binding-v1"); add(device); add(binding) })); put("binding", binding) }
            results[key] = buildJsonObject { put("operation_id", op); put("sequence", 1); put("request", original); put("request_digest", ObservationJSON.digest(original)); put("status", "applied"); put("reason", JsonNull); put("result", current); put("created_at", created) }
            if (drop) throw IOException("response lost")
        }
        return results[key]?.let { GatewayResponse(200, it.toString()) } ?: GatewayResponse(404, """{"error":{"code":"not_found"}}""")
    }
}
private suspend fun controller(scope: CoroutineScope, memory: SourceMemory, wire: SourceWire, now: () -> Instant = { Instant.parse("2030-01-01T00:00:10Z") }): ObservationController {
    val gateway = GatewayClient("https://nas.local", wire); gateway.login("owner-input")
    return ObservationController(ObservationClient(gateway, memory), "space-demo", scope, {}, now).also { it.refresh(); it.waitForIdle(); assertTrue(it.state.value.ready); it.setIEEE("1122334455667788"); it.setDevice("sensor") }
}
class ObservationControllerTest {
    @Test fun discoveryAndSupportedEndpointStillRequireExplicitBind() = runBlocking {
        val wire = SourceWire(); val c = controller(this, SourceMemory(), wire)
        c.discover(); c.waitForIdle(); assertEquals(1, c.state.value.discovery?.items?.size); assertNull(c.state.value.review)
        c.readEndpoints("1122334455667788"); c.waitForIdle(); assertEquals(2, c.state.value.endpoints?.items?.size); assertEquals("sensor", c.state.value.device)
        c.queryEndpoint(2); c.waitForIdle(); assertNull(c.state.value.review); assertNotNull(c.state.value.endpoints)
        c.queryEndpoint(1); c.waitForIdle(); assertNotNull(c.state.value.review); assertNull(c.state.value.discovery); assertNull(c.state.value.endpoints); assertEquals(0, wire.posts)
        c.confirm(); c.waitForIdle(); assertEquals(1, wire.posts)
    }
    @Test fun discoveryExpirationInputAndFutureObservations() = runBlocking {
        val wire = SourceWire(); var now = Instant.parse("2030-01-01T00:00:10Z"); val c = controller(this, SourceMemory(), wire) { now }
        c.discover(); c.waitForIdle(); c.readEndpoints("1122334455667788"); c.waitForIdle()
        now = now.plusSeconds(60); c.poll(); c.queryEndpoint(1); assertNull(c.state.value.discovery); assertNull(c.state.value.endpoints); assertNull(c.state.value.review)
        now = now.minusSeconds(60); c.discover(); c.waitForIdle(); c.setDevice("changed"); assertNull(c.state.value.discovery); assertNull(c.state.value.endpoints)
        now = now.minusSeconds(20); c.discover(); c.waitForIdle(); assertNull(c.state.value.discovery); assertFalse(c.state.value.ready)
    }
    @Test fun lateDiscoveryAndEndpointsCannotReviveOfflineState() = runBlocking {
        for (endpoints in listOf(false, true)) {
            val wire = SourceWire(); val c = controller(this, SourceMemory(), wire)
            if (endpoints) { c.discover(); c.waitForIdle() }
            wire.queryHold = CompletableDeferred()
            if (endpoints) c.readEndpoints("1122334455667788") else c.discover()
            withTimeout(2000) { while (!wire.waiting) delay(5) }; c.setOnline(false); wire.queryHold!!.complete(Unit); c.waitForIdle()
            assertNull(c.state.value.discovery); assertNull(c.state.value.endpoints); assertFalse(c.state.value.ready)
        }
    }
    @Test fun contextChangeAndReturnCannotReviveDiscovery() = runBlocking {
        val wire = SourceWire(); val c = controller(this, SourceMemory(), wire); wire.queryHold = CompletableDeferred(); c.discover()
        withTimeout(2000) { while (!wire.waiting) delay(5) }
        val device = Device("other", "sha256:fixture", false, null, emptyMap())
        c.updateDevices(listOf(device)); c.updateDevices(emptyList()); wire.queryHold!!.complete(Unit); c.waitForIdle()
        assertNull(c.state.value.discovery); assertNull(c.state.value.endpoints)
    }
    @Test fun explicitQueryBindRevokeAndHistoryDoNotReplay() = runBlocking {
        val wire = SourceWire(); val c = controller(this, SourceMemory(), wire)
        c.query(); c.waitForIdle(); assertNotNull(c.state.value.review); assertEquals(0, wire.posts)
        c.setEndpoint("2"); assertNull(c.state.value.review); c.setEndpoint("1"); c.query(); c.waitForIdle(); c.confirm(); c.waitForIdle()
        assertTrue(c.state.value.bindings.single().active); val original = c.state.value.records.single().key
        c.reviewRevoke("sensor"); c.waitForIdle(); assertEquals(1, wire.posts); assertNull(c.state.value.review!!.candidate)
        c.confirm(); c.waitForIdle(); assertFalse(c.state.value.bindings.single().active)
        c.recover(original); c.waitForIdle(); assertFalse(c.state.value.bindings.single().active); assertEquals(2, wire.posts)
    }
    @Test fun expirationAndInputChangesInvalidateReview() = runBlocking {
        val wire = SourceWire(); var now = Instant.parse("2030-01-01T00:00:10Z"); val c = controller(this, SourceMemory(), wire) { now }
        c.query(); c.waitForIdle(); now = now.plusSeconds(60); c.poll(); c.confirm(); assertNull(c.state.value.review); assertEquals(0, wire.posts)
    }
    @Test fun lateQueryCannotRevivePausedState() = runBlocking {
        val wire = SourceWire().apply { queryHold = CompletableDeferred() }; val c = controller(this, SourceMemory(), wire)
        c.query(); withTimeout(2000) { while (!wire.waiting) delay(5) }; c.pause(); wire.queryHold!!.complete(Unit); c.waitForIdle()
        assertNull(c.state.value.review); assertFalse(c.state.value.ready); assertFalse(c.state.value.busy); assertEquals(0, wire.posts)
    }
    @Test fun pausingDuringDurableSavePreventsSend() = runBlocking {
        val memory = SourceMemory(); val wire = SourceWire(); val c = controller(this, memory, wire)
        c.query(); c.waitForIdle(); memory.hold = CompletableDeferred(); c.confirm(); withTimeout(2000) { while (!memory.waiting) delay(5) }
        c.pause(); memory.hold!!.complete(Unit); c.waitForIdle(); assertEquals(0, wire.posts); assertFalse(c.state.value.ready)
        val restored = controller(this, memory, wire); assertTrue(restored.state.value.records.single().pending)
    }
    @Test fun lostResponseSurvivesRecreationAndOnlyQueriesOriginal() = runBlocking {
        val memory = SourceMemory(); val wire = SourceWire(); val c = controller(this, memory, wire)
        wire.drop = true; c.query(); c.waitForIdle(); c.confirm(); c.waitForIdle(); assertTrue(c.state.value.records.single().pending); assertFalse(c.state.value.ready)
        wire.drop = false; val restored = controller(this, memory, wire); assertTrue(restored.state.value.records.single().pending)
        restored.recover(restored.state.value.records.single().key); restored.waitForIdle(); assertEquals("applied", restored.state.value.records.single().status); assertEquals(1, wire.posts)
    }
    @Test fun changedBindingPreventsStaleConfirmation() = runBlocking {
        val wire = SourceWire(); val c = controller(this, SourceMemory(), wire); c.query(); c.waitForIdle(); wire.current = wire.v.getValue("revoked"); c.confirm(); c.waitForIdle()
        assertEquals(0, wire.posts); assertNull(c.state.value.review)
    }
    @Test fun storageFailureAndClosedStateCannotSend() = runBlocking {
        val memory = SourceMemory(); val wire = SourceWire(); val c = controller(this, memory, wire); c.query(); c.waitForIdle(); memory.fail = true; c.confirm(); c.waitForIdle()
        assertEquals(0, wire.posts); assertFalse(c.state.value.ready)
        c.close(); c.setOnline(true); c.refresh(); c.query(); c.confirm(); assertFalse(c.state.value.ready); assertNull(c.state.value.review)
    }
}
