package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import run.limeai.iot.core.*
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import kotlin.test.*

private class TextFileStore(private val file: File) : SessionStore {
    override suspend fun load(origin: String): String? { check(origin.endsWith("#text-generations")); return if (file.isFile) file.readText() else null }
    override suspend fun save(origin: String, value: String?) {
        check(origin.endsWith("#text-generations") && value != null)
        if (!file.exists()) Files.createFile(file.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
        FileChannel.open(file.toPath(), StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING).use { channel -> val bytes = ByteBuffer.wrap(value.toByteArray()); while (bytes.hasRemaining()) channel.write(bytes); channel.force(true) }
    }
}
private class TextLiveWire(private val drop: Boolean) : GatewayTransport {
    val upstream = OkHttpTransport(); var posts = 0; var otherPosts = 0
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        val result = upstream.send(request)
        if (request.method == "POST" && !request.url.endsWith("/auth/session")) {
            if (request.url.contains("/text-generations")) { posts++; if (drop && request.url.endsWith("/text-generations")) throw IOException("actual receipt lost") } else otherPosts++
        }
        return result
    }
}
class TextGenerationJourneyTest {
    @Test fun realGatewayTextRecovery() = runBlocking {
        val env = System.getenv(); org.junit.Assume.assumeNotNull(env["LIMEIOT_TEXT_NATIVE_PHASE"])
        val phase = env.getValue("LIMEIOT_TEXT_NATIVE_PHASE"); val space = "space-demo"
        val file = TextFileStore(File(env.getValue("LIMEIOT_TEXT_NATIVE_STORE"))); val wire = TextLiveWire(phase == "create")
        val gateway = GatewayClient(env.getValue("LIMEIOT_ENDPOINT"), wire, allowLoopbackHTTP = true); gateway.login(env.getValue("LIMEIOT_TOKEN"))
        val c = TextGenerationController(TextGenerationClient(gateway, file), space, this, {})
        c.refresh(); c.waitForIdle(); assertTrue(c.state.value.ready, c.state.value.message); assertTrue(c.state.value.outputs.isEmpty()); assertTrue(c.state.value.messages.isEmpty())
        when (phase) {
            "create" -> {
                c.setPrompt("请记住青柠🍋与 é"); c.generate(); c.waitForIdle(); assertFalse(c.state.value.ready); assertEquals(1, c.state.value.records.size); assertTrue(c.state.value.pending)
                val key = c.state.value.records.single().key; c.recover(key); c.waitForIdle()
                withTimeout(15000) { while (c.state.value.records.single().status == "running") { delay(50); c.poll(); c.waitForIdle() } }
                assertEquals(env.getValue("LIMEIOT_TEXT_NATIVE_TEXT"), c.state.value.text(key), c.state.value.message); assertTrue(c.state.value.messages.isEmpty())
            }
            "restore" -> {
                assertEquals(1, c.state.value.records.size); assertEquals("succeeded", c.state.value.records.single().status)
                val key = c.state.value.records.single().key; c.recover(key); c.waitForIdle(); assertEquals(env.getValue("LIMEIOT_TEXT_NATIVE_TEXT"), c.state.value.text(key))
            }
            "unknown-start" -> {
                c.setPrompt("请记住青柠🍋与 é"); c.generate(); c.waitForIdle(); assertEquals(2, c.state.value.records.size); assertEquals("running", c.state.value.records.last().status); assertFalse(c.state.value.canGenerate)
            }
            "unknown-restore" -> {
                assertEquals("unknown", c.state.value.records.last().status); assertTrue(c.state.value.pending)
                c.setPrompt("不可替换"); c.generate(); assertEquals(0, wire.posts)
                val key = c.state.value.records.last().key; c.requestDiscard(key); c.cancelDiscard(); c.confirmDiscard(); assertEquals(0, wire.posts)
                c.requestDiscard(key); c.confirmDiscard(); c.waitForIdle(); assertEquals("discarded", c.state.value.records.last().status)
            }
            "clear" -> {
                val key = c.state.value.records.first().key; c.recover(key); c.waitForIdle()
                c.requestDiscard(key); c.cancelDiscard(); c.confirmDiscard(); assertEquals(0, wire.posts)
                c.requestDiscard(key); c.confirmDiscard(); c.waitForIdle(); assertTrue(c.state.value.outputs.isEmpty()); assertTrue(c.state.value.messages.isEmpty()); assertFalse(c.state.value.records.first().canDiscard); assertEquals("succeeded", c.state.value.records.first().status)
            }
            "cleared-restore" -> {
                c.recover(c.state.value.records.first().key); c.waitForIdle(); assertTrue(c.state.value.outputs.isEmpty()); assertFalse(c.state.value.records.first().canDiscard)
            }
            else -> fail("invalid phase")
        }
        assertEquals(if (phase in listOf("create", "unknown-start", "unknown-restore", "clear")) 1 else 0, wire.posts); assertEquals(0, wire.otherPosts)
        val trace = buildJsonObject { put("passed", true); put("phase", phase); put("host_ui_state", true); put("text_posts", wire.posts); put("other_posts", wire.otherPosts); put("records", JsonArray(c.state.value.records.map { buildJsonObject { put("original", it.original); put("observation", it.observation ?: JsonNull) } })) }
        File(env.getValue("LIMEIOT_TEXT_NATIVE_TRACE")).writeText(OtaJSON.canonical(trace)); c.close()
    }
}
