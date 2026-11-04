package run.limeai.iot.core

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File
import java.io.IOException
import java.time.Instant
import kotlin.test.*

private fun companionFixture() = System.getenv("LIMEIOT_COMPANION_FIXTURE")?.let(::File)?.let { IntegerJSON.parse(it.readText()) }
    ?: generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/companions/contract.json") }.first { it.isFile }.let { IntegerJSON.parse(it.readText()) }
private fun companionHistory(f: JsonObject): List<TextGenerationMessage> {
    val tasks = f.getValue("tasks").jsonObject.getValue("1").jsonObject
    return listOf(TextGenerationMessage("user", MediaJSON.text(tasks.getValue("transcription").jsonObject.getValue("output").jsonObject, "text")), TextGenerationMessage("assistant", MediaJSON.text(tasks.getValue("text").jsonObject.getValue("output").jsonObject, "text")))
}
private class CompanionMemory : SessionStore {
    var raw: String? = null; var saves = 0; var failAt = 0; var holdAt = 0; var readback = false
    override suspend fun load(origin: String) = if (readback && saves > 0) null else raw
    override suspend fun save(origin: String, value: String?) {
        assertEquals("https://nas.local#companion:space-demo", origin); saves++; if (saves == failAt) throw IOException("storage"); raw = value
        if (saves == holdAt) delay(30000)
    }
}
private class CompanionWire(val f: JsonObject, val memory: CompanionMemory) : GatewayTransport {
    val posts = mutableListOf<String>(); val cleared = mutableSetOf<Int>(); var drop = false; var changed = false; var unknown = false
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (request.url.endsWith("/capabilities")) {
            val caps = f.getValue("capabilities").jsonObject; val text = caps.getValue("text").jsonObject; val deployment = text.getValue("deployment").jsonObject
            return GatewayResponse(200, (if (!changed) caps else JsonObject(caps + ("text" to JsonObject(text + ("deployment" to JsonObject(deployment + ("revision" to JsonPrimitive("sha256:" + "a".repeat(64))))))))).toString())
        }
        if (request.url.endsWith("/media")) return GatewayResponse(200, f.getValue("media").toString())
        val kind = mapOf("transcription" to "audio-transcriptions", "text" to "text-generations", "speech" to "speech-syntheses").entries.firstOrNull { request.url.contains("/" + it.value) }?.key ?: error("unexpected effect: ${request.url}")
        val key = request.headers.entries.firstOrNull { it.key.equals("Idempotency-Key", true) }?.value ?: request.url.substringAfter("/by-key/")
        val index = if (key.contains("_t2-")) 2 else 1
        if (request.method == "POST") {
            val raw = memory.raw!!; val saved = IntegerJSON.parse(raw); val nested = saved.getValue("turns").jsonArray[index - 1].jsonObject.getValue("record").jsonObject; val entry = nested.getValue("jobs").jsonObject.getValue(kind).jsonObject
            for (text in companionHistory(f).map { it.content } + MediaJSON.text(f.getValue("policy").jsonObject, "instructions")) assertFalse(raw.contains(text), "summary only")
            val expected = f.getValue("second").jsonObject.getValue("turns").jsonArray[index - 1].jsonObject.getValue("record").jsonObject
            assertEquals(expected.getValue("jobs").jsonObject.getValue(kind).jsonObject["original"], entry["original"], "original durable before POST")
            if (request.url.endsWith("/discard")) { assertEquals(JsonPrimitive(true), saved["stopped"]); assertEquals(JsonPrimitive(true), nested["stopped"]); assertEquals(JsonPrimitive(true), entry["discard_attempted"]); cleared += index }
            else if (kind == "text") {
                val input = IntegerJSON.parse(request.body!!); val history = if (index == 1) emptyList() else companionHistory(f)
                assertEquals(f.getValue("policy").jsonObject["instructions"], input["instructions"])
                assertEquals(CompanionJSON.messages(history + companionHistory(f)[0]), input["messages"], "role and second round history")
            }
            posts += if (request.url.endsWith("/discard")) "discard$index" else kind
            if (drop) throw IOException("receipt lost")
        }
        var task = f.getValue("tasks").jsonObject.getValue(index.toString()).jsonObject.getValue(kind).jsonObject
        if (unknown && kind == "transcription") task = JsonObject(task + buildJsonObject { put("status", "unknown"); put("error_code", "transcription_interrupted"); put("output", JsonNull) })
        return GatewayResponse(200, (if (index in cleared && kind == "text") f.getValue("cleared").jsonObject.getValue(index.toString()) else task).toString())
    }
}
private suspend fun companionClient(f: JsonObject, memory: CompanionMemory, wire: CompanionWire, policy: JsonObject? = f.getValue("policy").jsonObject, history: List<TextGenerationMessage>? = null, at: Instant = Instant.ofEpochMilli(f.getValue("now").jsonPrimitive.long)): CompanionClient {
    val gateway = GatewayClient("https://nas.local", wire); gateway.login("fixture")
    return CompanionClient(gateway, memory, "space-demo", policy?.let { CompanionPolicy.parse(it.toString()) }, history) { at }
}
class CompanionClientTest {
    private val f = companionFixture()
    private val mediaId get() = MediaJSON.text(f.getValue("prepared_slot").jsonObject.getValue("turns").jsonArray[0].jsonObject, "media_id")
    @Test fun sharedTwoTurnsRecoveryStopAndIdBudget() = runBlocking {
        val m = CompanionMemory(); val w = CompanionWire(f, m); val c = companionClient(f, m, w)
        assertEquals(f["started"], c.start("native-companion").record.document); assertTrue(w.posts.isEmpty())
        val first = c.reply(mediaId); assertEquals(f["first"], first.record.document); assertTrue(first.canReply)
        val second = c.reply(mediaId); assertEquals(f["second"], second.record.document); assertFalse(second.canReply); assertEquals(0, second.turnsRemaining)
        assertEquals("companion_turn_budget_exceeded", assertFailsWith<CompanionException> { c.reply(mediaId) }.code)
        val reader = companionClient(f, m, w, policy = null); assertFalse(reader.resolve().historyAvailable); assertEquals(6, w.posts.size)
        val stopped = reader.stop(); assertTrue(stopped.stopSettled); assertNull(stopped.turn); assertEquals(f["stopped"], stopped.record.document)
        assertEquals(listOf("transcription", "text", "speech", "transcription", "text", "speech", "discard1", "discard2"), w.posts)
        val policy = CompanionPolicy.parse(f.getValue("policy").toString()); reader.start("new-session", policy); reader.stop()
        assertEquals("companion_session_id_unavailable", assertFailsWith<CompanionException> { reader.start("native-companion", policy) }.code)
    }
    @Test fun persistenceAndPreparedCancellationHaveZeroPost() = runBlocking {
        for (n in 1..3) {
            val m = CompanionMemory().apply { failAt = n }; val w = CompanionWire(f, m); val c = companionClient(f, m, w)
            if (n == 1) assertFailsWith<CompanionException> { c.start("native-companion") }
            else { c.start("native-companion"); assertFails { c.reply(mediaId) } }
            assertTrue(w.posts.isEmpty())
        }
        val m = CompanionMemory(); val w = CompanionWire(f, m); val c = companionClient(f, m, w); c.start("native-companion"); m.holdAt = 2
        val task = launch { c.reply(mediaId) }; withTimeout(5000) { while (m.saves < 2) delay(2) }; task.cancelAndJoin()
        val restored = companionClient(f, m, w, history = emptyList()); assertEquals("prepared", restored.resolve().phase)
        assertEquals("companion_preparation_incomplete", assertFailsWith<CompanionException> { restored.continueSession() }.code)
        assertEquals("companion_turn_pending", assertFailsWith<CompanionException> { restored.reply(mediaId) }.code)
        assertTrue(restored.stop().stopSettled); assertTrue(w.posts.isEmpty())
    }
    @Test fun policyHistoryModelAndExpiryBlockNewInference() = runBlocking {
        for (mode in listOf("history", "policy", "configuration", "expiry")) {
            val m = CompanionMemory().apply { raw = f.getValue("first").toString() }; val w = CompanionWire(f, m).apply { changed = mode == "configuration" }
            val policy = f.getValue("policy").jsonObject.let { if (mode == "policy") JsonObject(it + ("instructions" to JsonPrimitive("另一个角色"))) else it }
            val c = companionClient(f, m, w, policy, if (mode == "history") null else companionHistory(f), Instant.ofEpochMilli(f.getValue("now").jsonPrimitive.long).plusSeconds(if (mode == "expiry") 300 else 0))
            val code = mapOf("history" to "companion_history_unavailable", "policy" to "companion_policy_changed", "configuration" to "companion_configuration_changed", "expiry" to "companion_expired").getValue(mode)
            assertEquals(code, assertFailsWith<CompanionException> { c.reply(mediaId) }.code); assertTrue(w.posts.isEmpty())
        }
    }
    @Test fun lostReceiptAndUnknownUseOriginalKeysOnly() = runBlocking {
        val m = CompanionMemory(); val w = CompanionWire(f, m); val c = companionClient(f, m, w); c.start("native-companion"); w.drop = true
        assertFailsWith<IOException> { c.reply(mediaId) }; w.drop = false
        assertEquals("ready", c.resolve().phase); assertEquals(listOf("transcription"), w.posts)
        assertEquals(f["first"], c.continueSession().record.document)
        val n = CompanionMemory().apply { raw = f.getValue("prepared").toString() }; val x = CompanionWire(f, n).apply { unknown = true }; val d = companionClient(f, n, x, history = emptyList())
        assertEquals("unknown", d.resolve().phase); assertEquals("unknown", d.continueSession().phase)
        assertEquals("companion_turn_pending", assertFailsWith<CompanionException> { d.reply(mediaId) }.code)
        assertEquals("companion_session_pending", assertFailsWith<CompanionException> { d.start("replacement") }.code); assertTrue(x.posts.isEmpty())
    }
    @Test fun strictPolicyAndV1Isolation() {
        assertFails { CompanionRecord.parse(f.getValue("second").toString(), "https://other.local", "space-demo") }
        assertFails { CompanionRecord.parse(JsonObject(f.getValue("second").jsonObject + ("stopped" to JsonPrimitive(true))).toString(), "https://nas.local", "space-demo") }
        assertFails { CompanionRecord.parse("{\"version\":1," + f.getValue("second").toString().drop(1), "https://nas.local", "space-demo") }
        val nested = f.getValue("second").jsonObject.getValue("turns").jsonArray[0].jsonObject.getValue("record").toString()
        assertFails { VoiceTurnRecord.parse(nested, "https://nas.local", "space-demo") }; VoiceTurnRecord.parse(nested, "https://nas.local", "space-demo", true)
        for ((key, value) in mapOf("max_turns" to JsonPrimitive(9), "max_seconds" to JsonPrimitive(29), "instructions" to JsonPrimitive(""))) assertFails { CompanionPolicy.parse(JsonObject(f.getValue("policy").jsonObject + (key to value)).toString()) }
        assertFails { CompanionPolicy.parse(JsonObject(f.getValue("policy").jsonObject + ("instructions" to JsonPrimitive("\uFEFF"))).toString()) }
    }
}
