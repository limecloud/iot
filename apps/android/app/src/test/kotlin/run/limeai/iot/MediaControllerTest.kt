package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assume.assumeTrue
import run.limeai.iot.core.*
import java.io.*
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import java.util.Base64
import kotlin.test.*

private fun vector(name: String): JsonObject = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/media/$name.json") }.first { it.isFile }.let { OtaJSON.parse(it.readText(), response = true) }
private class MediaMemory : SessionStore {
    val data = mutableMapOf<String, String>(); var hold = false
    override suspend fun load(origin: String) = data[origin]
    override suspend fun save(origin: String, value: String?) { if (value == null) data.remove(origin) else data[origin] = value; while (hold) delay(10) }
}
private class MediaStateWire : GatewayTransport {
    val media = vector("upload"); val targets = vector("targets"); var posts = 0; var status = 200
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        if (request.url.endsWith("/auth/session")) return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
        if (request.method == "POST") { posts++; error("unexpected write") }
        if (status != 200) return GatewayResponse(status, """{"error":{"code":"fixture_failure"}}""")
        val value = when {
            request.url.endsWith("/media") -> media.getValue("page")
            request.url.endsWith("/execution-adapters") -> targets.getValue("page")
            request.url.endsWith("/execution-binding") -> targets.getValue("bindings").jsonObject.getValue(request.url.substringBeforeLast('/').substringAfterLast('/'))
            else -> return GatewayResponse(404, """{"error":{"code":"media_operation_not_found"}}""")
        }
        return GatewayResponse(200, OtaJSON.canonical(value))
    }
}
private suspend fun mediaController(scope: CoroutineScope, memory: MediaMemory, wire: MediaStateWire, auth: (Exception) -> Unit = {}): MediaController {
    val gateway = GatewayClient("https://nas.local", wire); gateway.login("fixture")
    return MediaController(MediaClient(gateway, memory), "space-demo", scope, auth).also { it.refresh(); it.waitForIdle(); assertTrue(it.state.value.ready) }
}
class MediaControllerTest {
    @Test fun localSelectionApprovalAndCancelledDeletionNeverWrite() = runBlocking {
        val wire = MediaStateWire(); val controller = mediaController(this, MediaMemory(), wire)
        val bytes = Base64.getDecoder().decode(wire.media.getValue("change").jsonObject.getValue("content_base64").jsonPrimitive.content)
        controller.selectFile("sample.wav", bytes); assertEquals("sample.wav", controller.state.value.fileName); assertEquals(2, controller.state.value.targets.size)
        controller.grant(); controller.approve(true); controller.setGrantDuration(30); assertFalse(controller.state.value.approved)
        controller.approve(true); controller.selectTarget("speaker-composed"); assertFalse(controller.state.value.approved)
        controller.approve(true); controller.selectMedia("media-original"); assertFalse(controller.state.value.approved)
        controller.approve(true); controller.refresh(); controller.waitForIdle(); assertFalse(controller.state.value.approved)
        controller.requestDelete("media-original"); controller.cancelDelete(); controller.confirmDelete(); assertEquals(0, wire.posts)
    }
    @Test fun invalidLocalFilePreservesManagementAndOfflineClearsTransientState() = runBlocking {
        val wire = MediaStateWire(); val controller = mediaController(this, MediaMemory(), wire)
        val bytes = Base64.getDecoder().decode(wire.media.getValue("change").jsonObject.getValue("content_base64").jsonPrimitive.content)
        controller.selectFile("invalid.wav", byteArrayOf(0)); assertTrue(controller.state.value.ready); assertEquals("", controller.state.value.fileName)
        controller.selectFile("sample.wav", bytes); controller.approve(true); controller.requestDelete("media-original"); controller.setOnline(false)
        controller.upload(); controller.grant(); controller.confirmDelete()
        assertFalse(controller.state.value.ready); assertFalse(controller.state.value.approved); assertNull(controller.state.value.deletion); assertEquals("", controller.state.value.fileName); assertEquals(0, wire.posts)
        controller.setOnline(true); controller.refresh(); controller.waitForIdle(); controller.close(); controller.refresh(); controller.selectFile("ignored.wav", bytes); controller.upload()
        assertFalse(controller.state.value.ready); assertEquals("", controller.state.value.fileName); assertEquals(0, wire.posts)
    }
    @Test fun readFailureKeepsLastObservationAnd401ReachesHome() = runBlocking {
        val wire = MediaStateWire(); var auth = 0; val controller = mediaController(this, MediaMemory(), wire) { auth++ }
        val observed = controller.state.value.page!!.items.single().id
        wire.status = 500; controller.refresh(); controller.waitForIdle(); assertFalse(controller.state.value.ready); assertEquals(observed, controller.state.value.page!!.items.single().id)
        wire.status = 401; controller.refresh(); controller.waitForIdle(); assertEquals(1, auth); assertEquals(0, wire.posts)
    }
    @Test fun cancelledSavedIntentRemainsUnknownAndNeverPosts() = runBlocking {
        val memory = MediaMemory(); val wire = MediaStateWire(); val controller = mediaController(this, memory, wire)
        val bytes = Base64.getDecoder().decode(wire.media.getValue("change").jsonObject.getValue("content_base64").jsonPrimitive.content)
        controller.selectFile("sample.wav", bytes); memory.hold = true; controller.upload()
        withTimeout(5000) { while (memory.data.isEmpty()) delay(5) }
        controller.pause(); controller.waitForIdle(); memory.hold = false
        assertEquals(0, wire.posts); assertFalse(controller.state.value.ready)
        assertFalse(memory.data.values.single().contains("content_base64"))
        val restored = mediaController(this, memory, wire); val original = restored.state.value.records.single(); assertNull(original.result)
        restored.recover(original.key); restored.waitForIdle(); assertFalse(restored.state.value.ready); assertEquals(0, wire.posts)
    }
    @Test fun boundedReaderStopsAtLimitAndHonorsCancellation() = runBlocking {
        val bytes = ByteArray(46) { it.toByte() }; assertContentEquals(bytes, MediaFile.read(ByteArrayInputStream(bytes)))
        var read = 0
        val endless = object : InputStream() {
            override fun read(): Int = 0
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int { read += length; return length }
        }
        assertFailsWith<IOException> { MediaFile.read(endless) }; assertEquals(MediaChanges.MAX_AUDIO_BYTES + 1, read)
        val cancellation = Job(); var cancelledRead = 0
        val interrupting = object : InputStream() {
            override fun read(): Int = 0
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int { cancelledRead += length; cancellation.cancel(); return length }
        }
        assertFailsWith<CancellationException> { withContext(cancellation) { MediaFile.read(interrupting) } }
        assertEquals(65536, cancelledRead)
    }
    @Test fun originalRecoveryPlaybackAndProcessRestart() = runBlocking {
        val env = System.getenv(); assumeTrue(env["LIMEIOT_MEDIA_STATE_CHECK"] == "1")
        val phase = env.getValue("LIMEIOT_MEDIA_PHASE"); val space = "space-demo"; val file = File(env.getValue("LIMEIOT_MEDIA_STORE"))
        val vault = object : SessionStore {
            override suspend fun load(origin: String) = if (file.isFile) file.readText() else null
            override suspend fun save(origin: String, value: String?) {
                checkNotNull(value); if (!file.exists()) Files.createFile(file.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
                FileOutputStream(file).use { it.write(value.toByteArray()); it.fd.sync() }
            }
        }
        val upstream = OkHttpTransport(); var posts = 0
        val wire = GatewayTransport { request ->
            val response = upstream.send(request)
            if (request.method == "POST" && request.url.endsWith("/media-operations")) {
                posts++
                if (phase == "create" && OtaJSON.parse(request.body!!)["type"] == JsonPrimitive("media.upload")) throw IOException("upload receipt lost")
            }
            response
        }
        val gateway = GatewayClient(env.getValue("LIMEIOT_ENDPOINT"), wire, allowLoopbackHTTP = true); gateway.login(env.getValue("LIMEIOT_TOKEN"))
        val controller = MediaController(MediaClient(gateway, vault), space, this) { throw it }
        controller.refresh(); controller.waitForIdle(); assertTrue(controller.state.value.ready)
        assertEquals(env.getValue("LIMEIOT_MEDIA_BINDING"), controller.state.value.targets.single().bindingRevision)
        if (phase == "create") {
            val bytes = File(env.getValue("LIMEIOT_MEDIA_BYTES")).inputStream().use { MediaFile.read(it) }
            controller.setRetention(600); controller.selectFile("chime.wav", bytes); assertEquals(0, posts)
            controller.upload(); controller.waitForIdle(); assertFalse(controller.state.value.ready); assertNull(controller.state.value.records.single().result)
            controller.recover(controller.state.value.records.single().key); controller.waitForIdle(); assertTrue(controller.state.value.ready); assertEquals(1, posts)
        } else {
            assertEquals(2, controller.state.value.records.size); assertTrue(controller.state.value.page!!.grants.none { it.active })
            for (record in controller.state.value.records) { controller.recover(record.key); controller.waitForIdle() }
            val old = controller.state.value.records.single { it.type == "media.grant" }
            assertEquals(JsonPrimitive(false), old.result!!.getValue("result").jsonObject["issued_in_process"])
        }
        val media = controller.state.value.page!!.items.single()
        controller.requestDelete(media.id); controller.cancelDelete(); controller.confirmDelete(); controller.grant(); assertEquals(if (phase == "create") 1 else 0, posts)
        controller.approve(true); controller.setGrantDuration(300); assertFalse(controller.state.value.canGrant)
        controller.approve(true); controller.grant(); controller.waitForIdle(); assertTrue(controller.state.value.ready); assertFalse(controller.state.value.approved)
        if (phase == "create") {
            val snapshot = gateway.snapshot(); assertTrue(snapshot.commands.items.isEmpty())
            val speaker = snapshot.devices.single { it.deviceId == "device-lamp" }
            var command = gateway.create(space, CommandIntent.create(speaker, "playback.play", buildJsonObject { put("media_id", media.id) }, type = "action.invoke"))
            repeat(50) { if (command.status != "confirmed") { delay(100); command = gateway.command(space, command.commandId) } }
            assertEquals("confirmed", command.status)
        } else {
            controller.revoke(controller.state.value.page!!.grants.single { it.active }.id); controller.waitForIdle()
            controller.requestDelete(media.id); controller.confirmDelete(); controller.waitForIdle()
            controller.recover(controller.state.value.records.single { it.type == "media.upload" }.key); controller.waitForIdle()
            assertTrue(controller.state.value.page!!.items.none { it.available })
        }
        val records = controller.state.value.records
        assertEquals(if (phase == "create") 2 else 5, records.size); assertTrue(records.all { it.result != null }); assertEquals(if (phase == "create") 2 else 3, posts)
        controller.close(); controller.upload(); controller.grant()
        File(env.getValue("LIMEIOT_MEDIA_TRACE")).writeText(buildJsonObject {
            put("passed", true); put("phase", phase); put("posts", posts); put("host_ui_state", true)
            put("records", JsonArray(records.map { buildJsonObject { put("original", it.original); put("result", it.result!!) } }))
            put("native_app_runtime", false); put("hardware", false)
        }.toString())
    }
}
