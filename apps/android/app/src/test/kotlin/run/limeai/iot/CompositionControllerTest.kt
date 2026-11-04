package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.io.File
import java.time.Instant
import kotlin.test.*

private class CompositionStateMemory : SessionStore {
    var raw: String? = null
    override suspend fun load(origin: String) = raw
    override suspend fun save(origin: String, value: String?) { raw = value }
}
private class CompositionStateWire(val f: JsonObject) : GatewayTransport {
    var posts = 0; var compiled: CompositionCompiled? = null; var deployment: JsonObject? = null
    var hold: CompletableDeferred<Unit>? = null; val entered = CompletableDeferred<Unit>()
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        fun response(value: JsonElement) = GatewayResponse(200, value.toString())
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (request.url.contains("/devices/")) {
            hold?.let { entered.complete(Unit); withContext(NonCancellable) { it.await() } }
            return response(f.getValue("devices").jsonArray.first { it.jsonObject.getValue("device_id").jsonPrimitive.content == request.url.substringAfterLast('/') })
        }
        if (request.url.endsWith("/rules:validate")) {
            val rule = Json.parseToJsonElement(request.body!!).jsonObject
            compiled = CompositionPackage.parse(f.getValue("package_text").jsonPrimitive.content).compile(mapOf("touch" to "device-button", "light" to "device-lamp"), rule.getValue("id").jsonPrimitive.content)
            return response(buildJsonObject { put("valid", true); put("revision", compiled!!.revision) })
        }
        if (request.url.endsWith("/rules:simulate")) return response(JsonObject(f.getValue("simulation").jsonObject + mapOf("revision" to JsonPrimitive(compiled!!.revision), "proposed_actions" to compiled!!.rule.getValue("actions"))))
        if (request.url.endsWith("/rule-deployments") && request.method == "POST") {
            posts++; assertEquals("*", request.headers["If-None-Match"])
            deployment = buildJsonObject { put("revision", compiled!!.revision); put("rule", compiled!!.rule); put("last_run", JsonNull) }; return response(deployment!!)
        }
        if (request.url.endsWith("/rule-deployments")) return response(buildJsonObject { put("items", JsonArray(deployment?.let { listOf(it) } ?: emptyList())); put("next_cursor", JsonNull) })
        error("unexpected effect")
    }
}
class CompositionControllerTest {
    private val f = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/compositions/online.json") }.first { it.isFile }.let { Json.parseToJsonElement(it.readText()).jsonObject }
    private val devices get() = Json { ignoreUnknownKeys = true }.decodeFromJsonElement<List<Device>>(f.getValue("devices"))
    @Test fun bindingExpiryBackgroundAndReadOnlyRestore() = runBlocking {
        val m = CompositionStateMemory(); val w = CompositionStateWire(f); val g = GatewayClient("https://nas.local", w); g.login("fixture")
        var now = Instant.parse("2026-11-05T00:00:00Z")
        val controller = CompositionController(CompositionClient(g, m, "space-demo") { now }, this, {}, { now })
        controller.updateDevices(devices); controller.refresh(); controller.waitForIdle()
        assertFalse(controller.canPlan()); controller.bind("touch", "device-button"); controller.bind("light", "device-lamp"); assertTrue(controller.canPlan())
        controller.plan(); controller.waitForIdle(); assertTrue(controller.canDeploy())
        now = now.plusSeconds(60); controller.poll(); assertFalse(controller.canDeploy())
        controller.plan(); controller.waitForIdle(); controller.pause(); controller.waitForIdle(); assertFalse(controller.canDeploy()); assertFalse(controller.state.value.ready)
        controller.refresh(); controller.waitForIdle(); controller.plan(); controller.waitForIdle(); controller.deploy(); controller.waitForIdle()
        assertEquals("acknowledged", controller.state.value.record?.state, controller.state.value.message); assertEquals(1, w.posts)
        controller.pause(); controller.waitForIdle(); controller.refresh(); controller.waitForIdle(); controller.query(); controller.waitForIdle()
        assertEquals("acknowledged", controller.state.value.record?.state); assertEquals(1, w.posts)
        controller.close(); controller.waitForIdle()
    }
    @Test fun lateModelResponseAndInputOrDeviceChangesCannotRestoreProof() = runBlocking {
        val m = CompositionStateMemory(); val w = CompositionStateWire(f); val g = GatewayClient("https://nas.local", w); g.login("fixture")
        val c = CompositionController(CompositionClient(g, m, "space-demo"), this, {})
        c.updateDevices(devices); c.refresh(); c.waitForIdle(); c.bind("touch", "device-button"); c.bind("light", "device-lamp")
        val release = CompletableDeferred<Unit>(); w.hold = release; c.plan(); withTimeout(2000) { w.entered.await() }; c.pause(); release.complete(Unit); c.waitForIdle(); w.hold = null
        assertFalse(c.canDeploy()); assertFalse(c.state.value.ready); assertEquals(0, w.posts)
        c.refresh(); c.waitForIdle(); c.plan(); c.waitForIdle(); assertTrue(c.canDeploy())
        c.bind("light", ""); assertFalse(c.canDeploy()); c.deploy(); c.waitForIdle(); assertEquals(0, w.posts)
        c.bind("light", "device-lamp"); c.plan(); c.waitForIdle(); assertTrue(c.canDeploy())
        c.updateDevices(devices.map { it.copy(ready = false) }); c.waitForIdle(); assertFalse(c.canDeploy()); assertFalse(c.canPlan())
        c.close(); c.waitForIdle()
    }
    @Test fun damagedOriginalBlocksNewWritesInActualState() = runBlocking {
        val m = CompositionStateMemory(); val w = CompositionStateWire(f); val g = GatewayClient("https://nas.local", w); g.login("fixture")
        val c = CompositionController(CompositionClient(g, m, "space-demo"), this, {})
        c.updateDevices(devices); c.refresh(); c.waitForIdle(); c.bind("touch", "device-button"); c.bind("light", "device-lamp"); c.plan(); c.waitForIdle(); c.deploy(); c.waitForIdle()
        m.raw = "{}"; c.refresh(); c.waitForIdle(); assertTrue(c.state.value.blocked); assertFalse(c.canPlan()); assertFalse(c.canDeploy()); assertEquals(1, w.posts)
        c.close(); c.waitForIdle()
    }
}
