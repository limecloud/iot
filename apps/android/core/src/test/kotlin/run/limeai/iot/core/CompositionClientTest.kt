package run.limeai.iot.core

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File
import java.io.IOException
import java.time.Instant
import kotlin.test.*

private fun onlineFixture() = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/compositions/online.json") }.first { it.isFile }.let { IntegerJSON.parse(it.readText()) }
private class CompositionMemory : SessionStore {
    var raw: String? = null; var fail = false; var hold = false; var entered = false
    override suspend fun load(origin: String): String? { assertEquals("https://nas.local#composition:space-demo", origin); return raw }
    override suspend fun save(origin: String, value: String?) { if (fail) throw IOException("storage"); raw = value; if (hold) { entered = true; delay(30000) } }
}
private class CompositionWire(val f: JsonObject, val memory: CompositionMemory) : GatewayTransport {
    var mode = ""; var posts = 0; var active: JsonObject? = null
    var modelGate: CompletableDeferred<Unit>? = null; val entered = CompletableDeferred<Unit>()
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        assertEquals(5000L, request.timeoutMillis); assertEquals("https://nas.local", request.headers["Origin"]); assertEquals("csrf", request.headers["X-CSRF-Token"])
        if (request.url.contains("/devices/")) {
            modelGate?.let { entered.complete(Unit); withContext(NonCancellable) { it.await() } }
            val device = f.getValue("devices").jsonArray.map { it.jsonObject }.first { MediaJSON.text(it, "device_id") == request.url.substringAfterLast('/') }
            return GatewayResponse(200, (if (mode == "changed") JsonObject(device + ("model_revision" to JsonPrimitive("sha256:" + "a".repeat(64)))) else device).toString())
        }
        if (request.url.endsWith("/rules:validate")) {
            if (mode == "duplicate") return GatewayResponse(200, """{"valid":true,"valid":false,"revision":"x"}""")
            if (mode == "oversized") return GatewayResponse(200, " ".repeat(65537) + "{}")
            return GatewayResponse(200, f.getValue("validation").toString())
        }
        if (request.url.endsWith("/rules:simulate")) {
            val simulation = f.getValue("simulation").jsonObject
            return GatewayResponse(200, (if (mode == "forged") JsonObject(simulation + ("executed" to JsonPrimitive(true))) else simulation).toString())
        }
        if (request.url.endsWith("/rule-deployments") && request.method == "POST") {
            posts++; assertEquals("*", request.headers["If-None-Match"])
            val record = CompositionRecord.parse(memory.raw!!, "https://nas.local", "space-demo")
            assertEquals("attempted", record.state); assertTrue(RuleProof.equal(record.compiled.rule, Json.parseToJsonElement(request.body!!)), "full original durable before POST")
            if (mode == "reject") return GatewayResponse(403, """{"error":{"code":"forbidden"}}""")
            active = f.getValue("deployment").jsonObject
            if (mode == "drop") throw IOException("receipt lost")
            return GatewayResponse(200, (if (mode == "bad-receipt") JsonObject(active!! + ("revision" to JsonPrimitive("sha256:" + "a".repeat(64)))) else active!!).toString())
        }
        if (request.url.endsWith("/rule-deployments")) return GatewayResponse(200, buildJsonObject { put("items", JsonArray(active?.let { listOf(it) } ?: emptyList())); if (mode != "missing-cursor") put("next_cursor", JsonNull) }.toString())
        error("unexpected endpoint")
    }
}
class CompositionClientTest {
    private val f = onlineFixture()
    private fun compiled() = CompositionPackage.parse(MediaJSON.text(f, "package_text")).compile(mapOf("touch" to "device-button", "light" to "device-lamp"), "native-reading")
    private suspend fun gateway(w: CompositionWire) = GatewayClient("https://nas.local", w).also { it.login("fixture") }
    @Test fun exactSharedRecordConditionalSinglePostAndReadOnlyRestore() = runBlocking {
        val m = CompositionMemory(); val w = CompositionWire(f, m); val c = CompositionClient(gateway(w), m, "space-demo")
        assertEquals(f.getValue("validation").jsonObject["revision"], c.plan(compiled()).compiled.document["rule_revision"])
        val record = c.deploy(); assertEquals("acknowledged", record.state); assertEquals(1, w.posts)
        val contract = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/compositions/contract.json") }.first { it.isFile }.let { IntegerJSON.parse(it.readText()) }
        assertTrue(contract.getValue("records").jsonArray.contains(JsonPrimitive(record.json)), "JS original record parity")
        val restored = CompositionClient(gateway(w), m, "space-demo")
        assertNotNull(restored.resolve().deployment); assertEquals(1, w.posts)
        assertFailsWith<CompositionException> { restored.deploy() }
        restored.prepareAnother(); assertNull(restored.record())
    }
    @Test fun lostOrInvalidReceiptStaysAttemptedAndExplicitRejectionCanBePrepared() = runBlocking {
        for (mode in listOf("drop", "bad-receipt", "reject")) {
            val m = CompositionMemory(); val w = CompositionWire(f, m); val c = CompositionClient(gateway(w), m, "space-demo")
            c.plan(compiled()); w.mode = mode; assertFails { c.deploy() }
            val expected = if (mode == "reject") "rejected" else "attempted"
            assertEquals(expected, c.record()!!.state); assertEquals(expected, c.resolve().record.state); assertEquals(1, w.posts)
            if (mode == "reject") { c.prepareAnother(); assertNull(c.record()) }
            else { assertFailsWith<CompositionException> { c.prepareAnother() }; assertFailsWith<CompositionException> { c.plan(compiled()) } }
        }
    }
    @Test fun storageModelsClockSessionAndBadProofHaveZeroDeployment() = runBlocking {
        for (mode in listOf("storage", "changed", "expired", "clock-back", "session", "invalidate", "forged", "duplicate", "oversized")) {
            val m = CompositionMemory(); val w = CompositionWire(f, m); val g = gateway(w); var now = Instant.parse("2026-11-05T00:00:00Z")
            val c = CompositionClient(g, m, "space-demo") { now }
            if (mode in listOf("forged", "duplicate", "oversized")) { w.mode = mode; assertFails { c.plan(compiled()) } }
            else {
                c.plan(compiled())
                when (mode) { "storage" -> m.fail = true; "changed" -> w.mode = mode; "expired" -> now = now.plusSeconds(60); "clock-back" -> now = now.minusSeconds(1); "session" -> g.login("new-session"); "invalidate" -> c.invalidate() }
                assertFails { c.deploy() }
            }
            assertEquals(0, w.posts, mode)
        }
    }
    @Test fun cancellationAfterDurableSaveAndProcessGatePreventPost(): Unit = runBlocking {
        val m = CompositionMemory(); val w = CompositionWire(f, m); val g = gateway(w); val c = CompositionClient(g, m, "space-demo")
        c.plan(compiled()); m.hold = true
        val job = launch { c.deploy() }; withTimeout(2000) { while (!m.entered) delay(5) }
        assertEquals("composition_busy", assertFailsWith<CompositionException> { CompositionClient(g, m, "space-demo").record() }.code)
        job.cancelAndJoin(); assertEquals("attempted", c.record()!!.state); assertEquals(0, w.posts)
        assertFailsWith<CompositionException> { c.prepareAnother() }
    }
    @Test fun deletionAndCorruptionAfterReadBlockReplacement() = runBlocking {
        for (raw in listOf(null, "{}")) {
            val m = CompositionMemory(); val w = CompositionWire(f, m); val c = CompositionClient(gateway(w), m, "space-demo")
            c.plan(compiled()); c.deploy(); m.raw = raw
            assertEquals("composition_record_unavailable", assertFailsWith<CompositionException> { c.record() }.code)
            assertFailsWith<CompositionException> { c.plan(compiled()) }; assertEquals(1, w.posts)
        }
    }
    @Test fun lateTransportCannotRestoreInvalidatedProof() = runBlocking {
        val m = CompositionMemory(); val w = CompositionWire(f, m); val c = CompositionClient(gateway(w), m, "space-demo")
        val release = CompletableDeferred<Unit>(); w.modelGate = release
        val job = async { c.plan(compiled()) }; withTimeout(2000) { w.entered.await() }; c.invalidate(); release.complete(Unit)
        assertFailsWith<CancellationException> { job.await() }; assertFailsWith<CompositionException> { c.deploy() }; assertEquals(0, w.posts)
    }
    @Test fun currentDeploymentConflictAndMalformedPageDoNotRewriteOriginal() = runBlocking {
        val m = CompositionMemory(); val w = CompositionWire(f, m); val c = CompositionClient(gateway(w), m, "space-demo")
        c.plan(compiled()); val original = c.deploy().json
        w.mode = "missing-cursor"; assertFailsWith<GatewayException> { c.resolve() }; assertEquals(original, c.record()!!.json)
        w.mode = ""; w.active = JsonObject(w.active!! + ("revision" to JsonPrimitive("sha256:" + "a".repeat(64))))
        assertEquals("revision_conflict", assertFailsWith<GatewayException> { c.resolve() }.code); assertEquals(original, c.record()!!.json); assertEquals(1, w.posts)
    }
}
