package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.io.File
import java.io.IOException
import kotlin.test.*

private fun catalogFixture(): JsonObject = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/ai-catalog/contract.json") }.first { it.isFile }.let { Json.parseToJsonElement(it.readText()).jsonObject }
private fun changed(value: JsonElement, path: List<String>, replacement: JsonElement): JsonElement {
    if (path.isEmpty()) return replacement
    val key = path.first(); val tail = path.drop(1)
    return if (value is JsonArray) JsonArray(value.mapIndexed { i, child -> if (i.toString() == key) changed(child, tail, replacement) else child })
    else { val map = value.jsonObject.toMutableMap(); map[key] = changed(map[key] ?: JsonNull, tail, replacement); JsonObject(map) }
}
private class CatalogWire : GatewayTransport {
    var raw = catalogFixture().getValue("configured").toString()
    var status = 200; var gets = 0; var posts = 0; var hold = false
    val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (request.method != "GET") { posts++; error("discovery must not POST") }
        check(request.url == "https://nas.local/api/v1/spaces/space-demo/ai-catalog"); check(request.headers["Cookie"] != null)
        gets++; val response = GatewayResponse(status, raw)
        if (hold) { entered.complete(Unit); withContext(NonCancellable) { release.await() } }
        return response
    }
}
private suspend fun catalogController(scope: CoroutineScope, wire: CatalogWire, auth: (Exception) -> Unit = {}): AiCatalogController {
    val gateway = GatewayClient("https://nas.local", wire); gateway.login("fixture")
    return AiCatalogController({ gateway.aiCatalog("space-demo") }, scope, auth)
}
class AiCatalogControllerTest {
    @Test fun sharedDefinitionsAndConfigurationsMatchFormalContract() {
        val fixture = catalogFixture()
        for (name in listOf("configured", "unconfigured")) {
            val c = AiCatalog.parse(fixture.getValue(name).toString(), "space-demo")
            assertEquals(5, c.entries.size); assertEquals(fixture[name], c.document)
            assertTrue(c.entries.all { it.configured == (name == "configured") })
        }
        val c = AiCatalog.parse(fixture.getValue("configured").toString(), "space-demo")
        assertNull(c.entries.first().revision); assertEquals("fixture:rules", c.entries.first().model)
        assertEquals(AiCapability.entries, c.entries.map { it.capability })
    }
    @Test fun rejectsAllSharedCorruptionsAndBoundedRawJson() {
        val fixture = catalogFixture(); val full = fixture.getValue("configured")
        fixture.getValue("invalid").jsonObject.forEach { (name, raw) ->
            val vector = raw.jsonObject; val path = vector.getValue("path").jsonArray.map { it.jsonPrimitive.content }
            assertFailsWith<AiCatalogException>(name) { AiCatalog.parse(changed(full, path, vector.getValue("value")).toString(), "space-demo") }
        }
        val raw = full.toString()
        assertNotNull(AiCatalog.parse(raw.replace("\"schema_version\":1", "\"schema_version\":1.0"), "space-demo"))
        for (bad in listOf(raw.replace("\"schema_version\":1", "\"schema_version\":1,\"schema_version\":1"), " ".repeat(32769), raw + "{}", raw.replace("\"schema_version\":1", "\"schema_version\":1.5"))) assertFailsWith<AiCatalogException> { AiCatalog.parse(bad, "space-demo") }
        assertFailsWith<AiCatalogException> { AiCatalog.parse(raw, "../space-demo") }
    }
    @Test fun refreshIsReadOnlyAndUnconfiguredRemovesDestinations() = runBlocking {
        val w = CatalogWire(); val c = catalogController(this, w)
        c.refresh(); c.waitForIdle(); assertEquals(5, c.state.value.catalog?.entries?.count { it.configured })
        w.raw = catalogFixture().getValue("unconfigured").toString(); c.refresh(); c.waitForIdle()
        assertEquals(0, c.state.value.catalog?.entries?.count { it.configured }); assertEquals(2, w.gets); assertEquals(0, w.posts)
    }
    @Test fun invalidResponseRemovesPreviousCatalog() = runBlocking {
        val w = CatalogWire(); val c = catalogController(this, w); c.refresh(); c.waitForIdle(); assertNotNull(c.state.value.catalog)
        w.raw = w.raw.replace("space-demo", "foreign"); c.refresh(); c.waitForIdle(); assertNull(c.state.value.catalog)
        assertTrue(c.state.value.message.contains("未通过校验")); assertFalse(c.state.value.busy); assertEquals(0, w.posts)
    }
    @Test fun pauseDropsNonCooperativeLateResultAndAllowsFreshQuery() = runBlocking {
        val w = CatalogWire().apply { hold = true }; val c = catalogController(this, w)
        c.refresh(); w.entered.await(); c.pause(); w.hold = false; w.release.complete(Unit); yield(); delay(5)
        assertNull(c.state.value.catalog); assertFalse(c.state.value.busy)
        c.refresh(); c.waitForIdle(); assertNotNull(c.state.value.catalog); assertEquals(2, w.gets)
    }
    @Test fun offlineAndCloseClearEntriesAndBlockFurtherQueries() = runBlocking {
        val w = CatalogWire(); val c = catalogController(this, w); c.refresh(); c.waitForIdle()
        c.setOnline(false); c.refresh(); assertNull(c.state.value.catalog); assertEquals(1, w.gets)
        c.setOnline(true); c.refresh(); c.waitForIdle(); assertNotNull(c.state.value.catalog)
        c.close(); c.refresh(); assertNull(c.state.value.catalog); assertEquals(2, w.gets)
    }
    @Test fun authenticationFailureIsDelegatedWithoutStoredCatalog() = runBlocking {
        val w = CatalogWire(); var auth = 0; val c = catalogController(this, w) { auth++ }
        c.refresh(); c.waitForIdle(); w.status = 401; w.raw = """{"error":{"code":"unauthenticated"}}"""
        c.refresh(); c.waitForIdle(); assertEquals(1, auth); assertNull(c.state.value.catalog); assertEquals(0, w.posts)
    }
    @Test fun transportFailureClearsCatalogAndRefreshDoesNotOverlap() = runBlocking {
        val full = AiCatalog.parse(catalogFixture().getValue("configured").toString(), "space-demo")
        var reads = 0; var fail = false
        val c = AiCatalogController({ reads++; delay(5); if (fail) throw IOException("offline"); full }, this, {})
        c.refresh(); c.refresh(); c.waitForIdle(); assertEquals(1, reads); assertNotNull(c.state.value.catalog)
        fail = true; c.refresh(); c.waitForIdle(); assertNull(c.state.value.catalog); assertFalse(c.state.value.busy)
    }
}

// 独立JVM入口由真实网关旅程调用，不依赖Android系统或模拟器。
object AiCatalogLive {
    @JvmStatic fun main(args: Array<String>) {
        runBlocking {
        val env = System.getenv(); val requests = mutableListOf<GatewayRequest>(); val upstream = OkHttpTransport()
        val wire = object : GatewayTransport { override suspend fun send(request: GatewayRequest): GatewayResponse {
            check(request.method == "GET" || request.url.endsWith("/auth/session")); requests += request; return upstream.send(request)
        } }
        val gateway = GatewayClient(env.getValue("LIMEIOT_ENDPOINT"), wire, allowLoopbackHTTP = true); gateway.login(env.getValue("LIMEIOT_TOKEN"))
        val c = AiCatalogController({ gateway.aiCatalog("space-demo") }, this, { throw it })
        c.refresh(); c.waitForIdle(); val catalog = c.state.value.catalog ?: error(c.state.value.message)
        assertEquals(5, catalog.entries.size); c.pause(); assertNull(c.state.value.catalog)
        File(env.getValue("LIMEIOT_AI_NATIVE_TRACE")).writeText(buildJsonObject {
            put("passed", true); put("host_ui_state", true); put("catalog", catalog.document); put("cleared_after_pause", c.state.value.catalog == null)
            put("discovery_gets", requests.count { it.url.endsWith("/ai-catalog") && it.method == "GET" }); put("business_posts", requests.count { it.method == "POST" && !it.url.endsWith("/auth/session") })
        }.toString())
        }
        // 宿主一次性检查在全部断言和报告落盘后退出，不等待OkHttp的进程级空闲线程。
        kotlin.system.exitProcess(0)
    }
}
