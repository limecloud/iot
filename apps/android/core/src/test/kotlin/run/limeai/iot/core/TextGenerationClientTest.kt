package run.limeai.iot.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import java.io.File
import java.io.IOException
import kotlin.test.*

private fun vector() = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/text/contract.json") }.first { it.isFile }.let { IntegerJSON.parse(it.readText()) }
private class TextMemory : SessionStore {
    val data = mutableMapOf<String, String>(); var saves = 0; var failAt = 0; var loseReadback = false
    override suspend fun load(origin: String): String? = if (loseReadback && saves > 0) null else data[origin]
    override suspend fun save(origin: String, value: String?) { saves++; if (saves == failAt) throw IOException("storage"); if (value == null) data.remove(origin) else data[origin] = value }
}
private class TextWire(private val memory: TextMemory) : GatewayTransport {
    val fixture = vector(); var state = "running"; var posts = 0; var missing = false; var drop = false
    var savedBeforePost = false
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (request.url.endsWith("/capabilities")) return GatewayResponse(200, buildJsonObject { put("text", fixture.getValue("capabilities")) }.toString())
        check(request.url.contains("/text-generations"))
        if (request.method == "POST") {
            posts++
            val saved = IntegerJSON.parse(memory.data.getValue("https://nas.local#text-generations"))["records"]!!.jsonArray.single().jsonObject
            savedBeforePost = saved["original"] == fixture["original"]
            if (request.url.endsWith("/discard")) { check(saved["discard_intents"]!!.jsonArray.isNotEmpty()); state = if (state == "succeeded") "cleared" else "discarded" }
            if (drop) throw IOException("lost receipt")
        }
        if (missing) return GatewayResponse(404, """{"error":{"code":"text_not_found"}}""")
        fixture.getValue("invalid_task_json").jsonObject[state]?.let { return GatewayResponse(200, it.jsonPrimitive.content) }
        val task = fixture.getValue("tasks").jsonObject[state] ?: fixture.getValue("invalid_tasks").jsonObject.getValue(state)
        return GatewayResponse(200, task.toString())
    }
}
private suspend fun client(memory: TextMemory, wire: TextWire): TextGenerationClient {
    val gateway = GatewayClient("https://nas.local", wire); gateway.login("owner-input"); return TextGenerationClient(gateway, memory)
}
class TextGenerationClientTest {
    private val fixture = vector()
    private val input get() = fixture.getValue("input").jsonObject
    @Test fun sharedInputContractAndUnicodeBounds() {
        assertEquals(fixture["normalized"], TextGenerationRequests.parse(input.toString()))
        fixture.getValue("invalid_inputs").jsonObject.forEach { (name, value) -> assertFails(name) { TextGenerationRequests.parse(value.toString()) } }
        fixture.getValue("invalid_input_json").jsonObject.forEach { (name, raw) -> assertFails(name) { TextGenerationRequests.parse(raw.jsonPrimitive.content) } }
        assertFails { TextGenerationRequests.parse("{\"instructions\":\"a\",\"instructions\":\"b\"}") }
    }
    @Test fun durableOriginalAndSameKeyGetOnly() = runBlocking {
        val memory = TextMemory(); val wire = TextWire(memory); val c = client(memory, wire)
        assertTrue(c.capabilities("space-demo").configured)
        assertEquals(fixture["original"], c.submit("space-demo", input, "original").original)
        assertTrue(wire.savedBeforePost); c.submit("space-demo", input, "original"); assertEquals(1, wire.posts)
        val raw = memory.data.values.single(); for (secret in listOf("青柠", "owner-input", "\"messages\"", "\"text\"")) assertFalse(raw.contains(secret))
    }
    @Test fun writeAndReadbackFailuresHaveZeroPost() = runBlocking {
        for (readback in listOf(false, true)) {
            val memory = TextMemory().apply { if (readback) loseReadback = true else failAt = 1 }; val wire = TextWire(memory)
            assertFails { client(memory, wire).submit("space-demo", input, "original") }; assertEquals(0, wire.posts)
        }
    }
    @Test fun receiptPersistenceFailureKeepsOriginalForGet() = runBlocking {
        val memory = TextMemory().apply { failAt = 2 }; val wire = TextWire(memory)
        assertFails { client(memory, wire).submit("space-demo", input, "original") }; client(memory, wire).resolve("space-demo", "original"); assertEquals(1, wire.posts)
    }
    @Test fun lostReceipt404AndUnknownNeverResubmit() = runBlocking {
        val memory = TextMemory(); val wire = TextWire(memory).apply { drop = true }; val c = client(memory, wire)
        assertFails { c.submit("space-demo", input, "original") }; wire.drop = false; wire.missing = true
        assertFails { c.resolve("space-demo", "original") }; assertEquals("unresolved", c.records("space-demo").single().status)
        wire.missing = false; wire.state = "unknown"; c.resolve("space-demo", "original")
        assertFails { c.submit("space-demo", input, "replacement") }; wire.state = "succeeded"; assertFails { c.resolve("space-demo", "original") }; assertEquals(1, wire.posts)
        wire.state = "unknown"; c.discard("space-demo", "original", "discard-intent"); assertEquals(2, wire.posts)
    }
    @Test fun allInvalidTasksRejectedAndValidUsageTransitionAccepted() = runBlocking {
        for (name in fixture.getValue("invalid_tasks").jsonObject.keys + fixture.getValue("invalid_task_json").jsonObject.keys) {
            val memory = TextMemory(); val wire = TextWire(memory).apply { state = name }
            assertFails(name) { client(memory, wire).submit("space-demo", input, "original") }
        }
        val memory = TextMemory(); val wire = TextWire(memory); val c = client(memory, wire); c.submit("space-demo", input, "original")
        wire.state = "succeeded"; assertNotNull(c.resolve("space-demo", "original").text)
        wire.state = "running"; assertFails { c.resolve("space-demo", "original") }
        Unit
    }
    @Test fun clearPreservesIdentityAndCannotResurrectPlaintext() = runBlocking {
        val memory = TextMemory(); val wire = TextWire(memory).apply { state = "succeeded" }; val c = client(memory, wire)
        val original = c.submit("space-demo", input, "original"); assertNotNull(original.text)
        assertNull(client(memory, wire).records("space-demo").single().text)
        val cleared = c.discard("space-demo", "original", "discard-intent"); assertEquals(original.original, cleared.original); assertFalse(cleared.canDiscard)
        wire.state = "succeeded"; assertFails { c.resolve("space-demo", "original") }; assertEquals(2, wire.posts)
    }
}
