package run.limeai.iot.core

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File
import java.io.IOException
import java.time.Instant
import kotlin.test.*

private fun voiceFixture(): JsonObject = System.getenv("LIMEIOT_VOICE_TURN_FIXTURE")?.let(::File)
    ?.let { IntegerJSON.parse(it.readText()) } ?: generateSequence(File("").absoluteFile) { it.parentFile }
    .map { File(it, "tests/fixtures/voice-turns/contract.json") }.first { it.isFile }.let { IntegerJSON.parse(it.readText()) }
private class VoiceMemory : SessionStore {
    var raw: String? = null; var saves = 0; var failAt = 0; var readback = false; var holdAt = 0
    override suspend fun load(origin: String) = if (readback && saves > 0) null else raw
    override suspend fun save(origin: String, value: String?) { saves++; if (saves == failAt) throw IOException("storage"); raw = value; if (saves == holdAt) delay(30000) }
}
private class VoiceWire(val f: JsonObject, val memory: VoiceMemory) : GatewayTransport {
    val posts = mutableListOf<String>(); val tasks = f.getValue("tasks").jsonObject.toMutableMap()
    var cleared = false; var drop = false; var missing = false; var changed = false; var sourceMissing = false
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (request.url.endsWith("/capabilities")) {
            val caps = f.getValue("capabilities").jsonObject
            val text = caps.getValue("text").jsonObject
            val deployment = text.getValue("deployment").jsonObject
            return GatewayResponse(200, (if (!changed) caps else JsonObject(caps + ("text" to JsonObject(text + ("deployment" to JsonObject(deployment + ("revision" to JsonPrimitive("sha256:" + "a".repeat(64))))))))).toString())
        }
        if (request.url.endsWith("/media")) return GatewayResponse(200, (if (sourceMissing) JsonObject(f.getValue("media").jsonObject + ("items" to JsonArray(emptyList()))) else f.getValue("media")).toString())
        val kind = mapOf("transcription" to "audio-transcriptions", "text" to "text-generations", "speech" to "speech-syntheses").entries.firstOrNull { request.url.contains("/" + it.value) }?.key ?: error("unexpected effect: ${request.url}")
        if (request.method == "POST") {
            val raw = memory.raw!!; val saved = IntegerJSON.parse(raw); val entry = saved.getValue("jobs").jsonObject.getValue(kind).jsonObject
            assertFalse(raw.contains("我想搭")); assertFalse(raw.contains("稳固的底座"))
            assertEquals(f.getValue("succeeded").jsonObject.getValue("jobs").jsonObject.getValue(kind).jsonObject["original"], entry["original"], "durable original")
            if (request.url.endsWith("/discard")) { assertEquals(JsonPrimitive(true), saved["stopped"]); assertEquals(JsonPrimitive(true), entry["discard_attempted"]); cleared = true }
            posts += if (request.url.endsWith("/discard")) "discard" else kind
            if (drop) throw IOException("receipt lost")
        }
        if (missing) return GatewayResponse(404, """{"error":{"code":"transcription_not_found"}}""")
        return GatewayResponse(200, (if (cleared && kind == "text") f.getValue("cleared_text") else tasks.getValue(kind)).toString())
    }
}
private suspend fun voiceClient(f: JsonObject, memory: VoiceMemory, wire: VoiceWire): VoiceTurnClient {
    val g = GatewayClient("https://nas.local", wire); g.login("fixture")
    return VoiceTurnClient(g, memory, "space-demo") { Instant.ofEpochMilli(f.getValue("now").jsonPrimitive.long) }
}

class VoiceTurnClientTest {
    private val f = voiceFixture()
    private val input get() = f.getValue("input").jsonObject
    @Test fun sharedJsLedgerAndDurableStageBudget() = runBlocking {
        val m = VoiceMemory(); val w = VoiceWire(f, m); val c = voiceClient(f, m, w)
        val v = c.start(input); assertEquals("succeeded", v.phase); assertEquals(f["succeeded"], v.record.document)
        assertEquals(listOf("transcription", "text", "speech"), w.posts)
        voiceClient(f, m, w).resolve(); assertEquals(3, w.posts.size)
        w.drop = true; assertFailsWith<IOException> { c.stopTurn() }; w.drop = false
        c.stopTurn(); assertEquals(listOf("transcription", "text", "speech", "discard"), w.posts)
        assertEquals(f["stopped"], c.record()?.document)
        w.cleared = false; assertFails { c.resolve() }; Unit
    }
    @Test fun persistenceFailuresAndPostSaveCancellationHaveZeroPost() = runBlocking {
        for (readback in listOf(false, true)) {
            val m = VoiceMemory().apply { if (readback) this.readback = true else failAt = 1 }; val w = VoiceWire(f, m)
            assertFails { voiceClient(f, m, w).start(input) }; assertTrue(w.posts.isEmpty())
        }
        val m = VoiceMemory().apply { holdAt = 2 }; val w = VoiceWire(f, m); val c = voiceClient(f, m, w)
        val task = launch { c.start(input) }; withTimeout(5000) { while (m.saves < 2) delay(2) }; task.cancelAndJoin(); assertTrue(w.posts.isEmpty())
    }
    @Test fun lostReceipt404AndUnknownNeverCreateAnotherStage() = runBlocking {
        val m = VoiceMemory(); val w = VoiceWire(f, m).apply { drop = true }; val c = voiceClient(f, m, w)
        assertFailsWith<IOException> { c.start(input) }; w.drop = false; w.missing = true
        assertFails { c.resolve() }; assertFails { c.start(input) }; w.missing = false
        assertEquals("ready", c.resolve().phase); assertEquals(listOf("transcription"), w.posts)
        val n = VoiceMemory().apply { raw = f.getValue("prepared").toString() }; val x = VoiceWire(f, n); val d = voiceClient(f, n, x)
        x.tasks["transcription"] = JsonObject(x.tasks.getValue("transcription").jsonObject + buildJsonObject { put("status", "unknown"); put("error_code", "transcription_interrupted"); put("output", JsonNull) })
        assertEquals("unknown", d.resolve().phase); assertEquals("unknown", d.continueTurn().phase)
        x.tasks["transcription"] = f.getValue("tasks").jsonObject.getValue("transcription"); assertFails { d.resolve() }; assertTrue(x.posts.isEmpty())
    }
    @Test fun identityUsageConfigurationAndSourceDriftStopProgress() = runBlocking {
        for (field in listOf("identity", "usage", "configuration", "source")) {
            val m = VoiceMemory().apply { raw = f.getValue(if (field in listOf("configuration", "source")) "ready" else "succeeded").toString() }; val w = VoiceWire(f, m); val c = voiceClient(f, m, w)
            if (field == "identity") w.tasks["text"] = JsonObject(w.tasks.getValue("text").jsonObject + ("text_id" to JsonPrimitive("text-drift")))
            if (field == "usage") w.tasks["text"] = JsonObject(w.tasks.getValue("text").jsonObject + ("usage" to JsonObject(w.tasks.getValue("text").jsonObject.getValue("usage").jsonObject + ("output_tokens" to JsonPrimitive(999)))))
            w.changed = field == "configuration"; w.sourceMissing = field == "source"
            val error = assertFailsWith<VoiceTurnException>(field) { if (field in listOf("configuration", "source")) c.continueTurn() else c.resolve() }
            assertEquals(when (field) { "configuration" -> "voice_turn_configuration_changed"; "source" -> "voice_turn_source_unavailable"; else -> "invalid_voice_turn_response" }, error.code)
            assertTrue(w.posts.isEmpty())
        }
    }
    @Test fun checksumOriginAndInputValidation() {
        val raw = f.getValue("succeeded").toString(); VoiceTurnRecord.parse(raw, "https://nas.local", "space-demo")
        assertFails { VoiceTurnRecord.parse(raw, "https://other.local", "space-demo") }
        assertFails { VoiceTurnRecord.parse(raw.replace("native-shared", "tampered"), "https://nas.local", "space-demo") }
        assertFails { VoiceTurnRequests.input("bad/id", "media-ok", voice = "local") }
    }
}
