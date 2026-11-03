package run.limeai.iot.core

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import kotlin.test.*

class VisionIntegrationTest {
    @Test fun actualGatewayOriginalRecoveryAndClearing() = runBlocking {
        val env = System.getenv(); assumeTrue(env["LIMEIOT_VISION_CHECK"] == "1")
        val phase = env.getValue("LIMEIOT_VISION_PHASE"); val space = "space-demo"
        val vault = object : SessionStore {
            val file = File(env.getValue("LIMEIOT_VISION_STORE"))
            override suspend fun load(origin: String): String? { check(origin.endsWith("#vision-observations")); return if (file.isFile) file.readText() else null }
            override suspend fun save(origin: String, value: String?) {
                check(origin.endsWith("#vision-observations")); checkNotNull(value)
                if (!file.exists()) Files.createFile(file.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
                FileOutputStream(file).use { it.write(value.toByteArray()); it.fd.sync() }
            }
        }
        val upstream = OkHttpTransport(); var posts = 0; var otherPosts = 0
        val wire = object : GatewayTransport {
            override suspend fun send(request: GatewayRequest): GatewayResponse {
                val result = upstream.send(request)
                if (request.method == "POST" && !request.url.endsWith("/auth/session")) {
                    if (request.url.contains("/vision-observations")) { posts++; if (phase == "create" && request.url.endsWith("/vision-observations")) throw IOException("actual receipt lost") }
                    else otherPosts++
                }
                return result
            }
        }
        val gateway = GatewayClient(env.getValue("LIMEIOT_ENDPOINT"), wire, allowLoopbackHTTP = true); gateway.login(env.getValue("LIMEIOT_TOKEN"))
        val client = VisionClient(gateway, vault); val bytes = File(env.getValue("LIMEIOT_VISION_IMAGE")).readBytes()
        fun input(record: VisionRecord? = null): JsonObject {
            val expires = record?.original?.get("input")?.jsonObject?.get("expires_at")?.jsonPrimitive?.content
            return if (expires == null) VisionRequests.input(bytes, "image/png", "请观察青柠🍋与é，有什么形状？") else VisionRequests.input(bytes, "image/png", "请观察青柠🍋与é，有什么形状？", expiresAt = expires)
        }
        assertTrue(client.capabilities(space).configured)
        val restored = client.records(space); assertTrue(restored.all { it.text == null })
        when (phase) {
            "create" -> {
                assertFailsWith<IOException> { client.submit(space, input(), "native-first") }
                assertEquals("unresolved", client.records(space).single().status)
                var result = client.resolve(space, "native-first")
                withTimeout(10000) { while (result.status == "running") { delay(50); result = client.resolve(space, "native-first") } }
                assertEquals(env.getValue("LIMEIOT_VISION_TEXT"), result.text); assertEquals("succeeded", result.status)
            }
            "restore" -> {
                assertEquals(1, restored.size); assertEquals("succeeded", restored.single().status)
                val result = client.submit(space, input(restored.single()), "native-first")
                assertEquals(env.getValue("LIMEIOT_VISION_TEXT"), result.text)
            }
            "unknown-start" -> assertEquals("running", client.submit(space, input(), "native-second").status)
            "unknown-restore" -> {
                val unknown = client.resolve(space, "native-second"); assertEquals("unknown", unknown.status); assertTrue(unknown.pending)
                assertEquals("vision_pending", assertFailsWith<VisionException> { client.submit(space, input(), "replacement") }.code)
                val discarded = client.discard(space, "native-second", "native-discard"); assertEquals("discarded", discarded.status); assertNull(discarded.text)
                client.discard(space, "native-second", "native-discard")
            }
            "clear" -> {
                val cleared = client.discard(space, "native-first", "native-clear"); assertEquals("succeeded", cleared.status); assertNull(cleared.text); assertFalse(cleared.canDiscard)
                client.discard(space, "native-first", "native-clear")
            }
            "cleared-restore" -> {
                val result = client.resolve(space, "native-first"); assertEquals("succeeded", result.status); assertNull(result.text); assertFalse(result.canDiscard)
            }
            else -> error("invalid phase")
        }
        assertEquals(if (phase in listOf("create", "unknown-start", "unknown-restore", "clear")) 1 else 0, posts); assertEquals(0, otherPosts)
        val trace = buildJsonObject {
            put("passed", true); put("phase", phase); put("native_host_library", true); put("vision_posts", posts); put("other_posts", otherPosts)
            put("records", JsonArray(client.records(space).map { record -> buildJsonObject { put("original", record.original); put("observation", record.observation ?: JsonNull); put("discard_intents", JsonArray(record.discardIntents.map(::JsonPrimitive))) } }))
        }
        File(env.getValue("LIMEIOT_VISION_TRACE")).writeText(IntegerJSON.canonical(trace))
    }
}
