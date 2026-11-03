package run.limeai.iot.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import java.io.File
import kotlin.test.*

private fun targetVector(): JsonObject {
    val file = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/media/targets.json") }.first { it.isFile }
    return OtaJSON.parse(file.readText(), response = true)
}
private class MediaTargetWire(val page: JsonElement, val bindings: JsonObject) : GatewayTransport {
    val requests = mutableListOf<GatewayRequest>()
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        requests += request
        val document = when {
            request.url.endsWith("/execution-adapters") -> page
            request.url.endsWith("/execution-binding") -> bindings.getValue(request.url.substringBeforeLast('/').substringAfterLast('/'))
            else -> error("unexpected target request")
        }
        return GatewayResponse(200, OtaJSON.canonical(document))
    }
}
private class MediaTargetStore : SessionStore {
    override suspend fun load(origin: String): String? = error("target lookup must not load operation storage")
    override suspend fun save(origin: String, value: String?) { error("target lookup must not save operation storage") }
}
private suspend fun readTargets(page: JsonElement, bindings: JsonObject): Pair<List<MediaTarget>, List<GatewayRequest>> {
    val wire = MediaTargetWire(page, bindings)
    val gateway = GatewayClient("https://nas.local", wire); gateway.login("target-fixture")
    val client = MediaClient(gateway, MediaTargetStore())
    return client.targets("space-demo") to wire.requests
}
class MediaTargetTest {
    @Test fun onlyCurrentMatchingBoundOrComposedTargets() = runBlocking {
        val vector = targetVector(); val (targets, _) = readTargets(vector.getValue("page"), vector.getValue("bindings").jsonObject)
        assertEquals(vector.getValue("expected"), JsonArray(targets.map { JsonPrimitive(it.deviceId) }))
        for (target in targets) {
            assertEquals("sha256:" + "3".repeat(64), target.bindingRevision); assertEquals("sha256:" + "2".repeat(64), target.modelRevision)
            assertEquals("192.168.50.20:1400", target.target); assertEquals("uuid:" + target.deviceId, target.udn)
        }
    }
    @Test fun readsCurrentBindingWithoutMutationOrStorage() = runBlocking {
        val vector = targetVector(); val (_, requests) = readTargets(vector.getValue("page"), vector.getValue("bindings").jsonObject)
        val base = "https://nas.local/api/v1/spaces/space-demo"
        assertEquals(listOf(base + "/execution-adapters") + listOf("speaker-bound", "speaker-composed", "speaker-unbound", "speaker-mismatch").map { base + "/devices/" + it + "/execution-binding" }, requests.map { it.url })
        assertTrue(requests.all { it.method == "GET" && it.body == null })
    }
    @Test fun malformedCandidatePagesRejected() = runBlocking {
        val vector = targetVector()
        for (item in vector.getValue("invalid_pages").jsonArray) {
            assertFailsWith<MediaException>(item.jsonObject.getValue("name").jsonPrimitive.content) { readTargets(item.jsonObject.getValue("page"), vector.getValue("bindings").jsonObject) }
        }
    }
    @Test fun malformedOrCrossDeviceBindingsRejected() = runBlocking {
        val vector = targetVector(); val bindings = vector.getValue("bindings").jsonObject
        for (item in vector.getValue("invalid_bindings").jsonArray) {
            val changed = JsonObject(bindings + ("speaker-bound" to item.jsonObject.getValue("binding")))
            assertFailsWith<MediaException>(item.jsonObject.getValue("name").jsonPrimitive.content) { readTargets(vector.getValue("page"), changed) }
        }
    }
}
