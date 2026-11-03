package run.limeai.iot.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import kotlin.test.*

class MediaIntegrationTest {
    @Test fun originalRecoveryPlaybackAndProcessRestart() = runBlocking {
        val env = System.getenv()
        if (env["LIMEIOT_MEDIA_CHECK"] != "1") return@runBlocking
        val phase = env.getValue("LIMEIOT_MEDIA_PHASE"); val space = "space-demo"; val file = File(env.getValue("LIMEIOT_MEDIA_STORE"))
        // 文件存储仅用于宿主恢复夹具；App仍使用系统安全存储。
        val store = object : SessionStore {
            override suspend fun load(origin: String): String? = if (file.isFile) file.readText() else null
            override suspend fun save(origin: String, value: String?) {
                checkNotNull(value)
                if (!file.exists()) Files.createFile(file.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
                FileOutputStream(file).use { it.write(value.toByteArray()); it.fd.sync() }
            }
        }
        val upstream = OkHttpTransport(); var posts = 0
        val wire = GatewayTransport { request ->
            val response = upstream.send(request)
            if (request.method == "POST" && request.url.endsWith("/media-operations")) {
                posts++
                if (phase == "create" && request.headers["Idempotency-Key"] == "native-upload") throw IOException("response lost after actual upload")
            }
            response
        }
        val gateway = GatewayClient(env.getValue("LIMEIOT_ENDPOINT"), wire, allowLoopbackHTTP = true); gateway.login(env.getValue("LIMEIOT_TOKEN"))
        var client = MediaClient(gateway, store); val upload = MediaChanges.upload(File(env.getValue("LIMEIOT_MEDIA_BYTES")).readBytes(), 600)
        if (phase == "create") {
            assertFailsWith<IOException> { client.submit(space, upload, "native-upload") }
            client = MediaClient(gateway, store)
            assertNotNull(client.submit(space, upload, "native-upload").result)
        } else {
            assertEquals(2, client.records(space).size); client.submit(space, upload, "native-upload")
            val old = client.resolve(space, "native-grant")
            assertEquals(JsonPrimitive(false), old.result!!.getValue("result").jsonObject["issued_in_process"])
            assertTrue(client.list(space).grants.none { it.active })
        }
        val media = client.list(space).items.single()
        val grant = MediaChanges.grant(media.id, "device-lamp", env.getValue("LIMEIOT_MEDIA_BINDING"), 300)
        val granted = client.submit(space, grant, if (phase == "create") "native-grant" else "native-new-grant")
        if (phase == "create") {
            val snapshot = gateway.snapshot(); assertTrue(snapshot.commands.items.isEmpty())
            val speaker = snapshot.devices.single { it.deviceId == "device-lamp" }
            val value = buildJsonObject { put("media_id", media.id) }
            var command = gateway.create(space, CommandIntent.create(speaker, "playback.play", value, type = "action.invoke"))
            repeat(50) { if (command.status != "confirmed") { delay(100); command = gateway.command(space, command.commandId) } }
            assertEquals("confirmed", command.status)
        } else {
            val grantId = granted.result!!.getValue("result").jsonObject.getValue("grant_id").jsonPrimitive.content
            client.submit(space, MediaChanges.revoke(grantId), "native-revoke")
            client.submit(space, MediaChanges.delete(media.id), "native-delete")
            client.submit(space, upload, "native-upload"); assertTrue(client.list(space).items.none { it.available })
        }
        val records = client.records(space)
        assertTrue(records.all { it.result != null }); assertEquals(if (phase == "create") 2 else 5, records.size); assertEquals(if (phase == "create") 2 else 3, posts)
        val report = buildJsonObject {
            put("passed", true); put("phase", phase); put("posts", posts)
            put("records", JsonArray(records.map { buildJsonObject { put("original", it.original); put("result", it.result!!) } }))
            put("native_app_runtime", false); put("hardware", false)
        }
        File(env.getValue("LIMEIOT_MEDIA_TRACE")).writeText(report.toString())
    }
}
