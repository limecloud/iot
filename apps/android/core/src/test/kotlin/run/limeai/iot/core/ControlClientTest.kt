package run.limeai.iot.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import java.io.IOException
import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import kotlin.test.*

private class MemoryControlStore : SessionStore {
    val records = mutableMapOf<String, String>()
    var fail = false
    override suspend fun load(origin: String) = records[origin]
    override suspend fun save(origin: String, value: String?) { if (fail) throw IOException("storage_failure"); if (value == null) records.remove(origin) else records[origin] = value }
}
private fun digest(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
private class ControlFixture : GatewayTransport {
    val requests = mutableListOf<GatewayRequest>()
    var loseStart = false
    var unavailable = false
    var revoked = false
    var poison: String? = null
    var loseCommand = false
    var missingCommand = false
    var rejectCommand = false
    var remotePoison: String? = null
    var commandInput: JsonObject? = null
    var commandStatus = "unknown"
    val origin = "https://control.example"
    val id = "na-" + "b".repeat(64)
    val token = "c".repeat(64)
    val expiry = Instant.now().plusSeconds(300).toString()
    val sessionExpiry = Instant.now().plusSeconds(3500).toString()
    private fun remoteBody(): JsonObject {
        var input = requireNotNull(commandInput)
        if (remotePoison == "request") input = JsonObject(input + ("device_id" to JsonPrimitive("other")))
        val id = "remote-" + "d".repeat(64)
        return buildJsonObject {
            put("remote_id", id); put("space_id", "space-a"); put("principal_id", if (remotePoison == "principal") "other" else "owner"); put("local_space_id", "local-space")
            put("request_digest", "a".repeat(64)); put("request", input); put("status", commandStatus)
            put("local_result", if (commandStatus == "confirmed") buildJsonObject {
                val operation = input.getValue("operation").jsonObject
                put("command_id", "cmd-original"); put("request_digest", "sha256:" + "b".repeat(64)); put("status", "confirmed"); put("error", JsonNull)
                put("request", if (remotePoison == "local_request") JsonNull else buildJsonObject {
                    put("space_id", "local-space"); put("idempotency_key", id)
                    for (key in listOf("device_id", "model_revision", "expires_at", "operation")) put(key, input.getValue(key))
                })
                val evidence = if (operation["type"] == JsonPrimitive("action.invoke")) buildJsonObject {
                    put("type", "action_result"); put("path", operation.getValue("path")); put("input_digest", "sha256:" + "b".repeat(64)); put("output", buildJsonObject {}); put("completion", if (remotePoison == "action_observed") "observed" else "submitted"); put("observed_at", Instant.now().toString())
                } else buildJsonObject { put("type", "device_result"); put("reported", buildJsonObject { put(operation.getValue("path").jsonPrimitive.content, operation.getValue("value")) }) }
                val modified = evidence.toMutableMap()
                when (remotePoison) {
                    "action_type" -> modified["type"] = JsonPrimitive("device_result")
                    "action_path" -> modified["path"] = JsonPrimitive("other.press")
                    "action_digest" -> modified["input_digest"] = JsonPrimitive("invalid")
                    "action_scope" -> modified["completion"] = JsonPrimitive("completed")
                    "action_output" -> modified["output"] = JsonNull
                    "action_missing" -> modified.remove("output")
                    "action_time" -> modified["observed_at"] = JsonPrimitive(Instant.now().minusSeconds(60).toString())
                    "action_future" -> modified["observed_at"] = JsonPrimitive(Instant.now().plusSeconds(60).toString())
                    "action_extra" -> modified["extra"] = JsonPrimitive(true)
                    "action_error" -> put("error", "execution_failed")
                }
                put("evidence", if (remotePoison == "evidence") JsonNull else JsonObject(modified))
            } else JsonNull)
        }
    }
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        requests += request
        var status = 200
        val body = when (URI(request.url).path) {
            "/api/native/v1/authorizations" -> {
                if (loseStart) { loseStart = false; throw IOException("response_lost") }
                buildJsonObject {
                    put("authorization_id", id); put("user_code", "ABCDEF12"); put("verification_uri", (if (poison == "redirect") "https://other.invalid" else origin) + "/console/?native=$id")
                    put("expires_at", expiry); put("interval_seconds", 3); put("status", "pending")
                }
            }
            "/api/native/v1/authorizations/poll" -> buildJsonObject {
                put("status", if (poison == "pending") "pending" else "approved"); put("expires_at", expiry)
                put("material", buildJsonObject {
                    put("version", 1); put("origin", if (poison == "origin") "https://other.invalid" else origin); put("audience", if (poison == "audience") "admin" else "console")
                    put("session", token); put("principal_id", "owner"); put("expires_at", sessionExpiry)
                })
            }
            "/api/native/v1/authorizations/cancel" -> { revoked = true; buildJsonObject { put("status", "cancelled") } }
            "/api/console/v1/auth/logout" -> { revoked = true; buildJsonObject { put("logged_out", true) } }
            "/api/console/v1/auth/session" -> when {
                unavailable -> { status = 503; buildJsonObject { put("error", buildJsonObject { put("code", "identity_unavailable") }) } }
                revoked -> { status = 401; buildJsonObject { put("error", buildJsonObject { put("code", "identity_rejected") }) } }
                else -> buildJsonObject {
                    put("audience", "console"); put("principal", buildJsonObject { put("principal_id", if (poison == "principal") "other" else "owner"); put("name", "测试账号") })
                    put("csrf_token", digest("limeiot-csrf:console:$token")); put("expires_at", sessionExpiry)
                }
            }
            "/api/console/v1/spaces" -> buildJsonObject { put("spaces", buildJsonArray { add(buildJsonObject { put("space_id", "space-a"); put("name", "测试家庭") }) }) }
            else -> when {
                request.url.endsWith("/remote-commands") && request.method == "POST" -> {
                    if (rejectCommand) { status = 403; buildJsonObject { put("error", buildJsonObject { put("code", "forbidden") }) } }
                    else {
                        commandInput = Json.parseToJsonElement(request.body!!).jsonObject
                        if (loseCommand) { loseCommand = false; throw IOException("response_lost") }
                        remoteBody()
                    }
                }
                request.url.contains("/remote-commands/by-key/") -> if (missingCommand) { status = 404; buildJsonObject { put("error", buildJsonObject { put("code", "not_found") }) } } else remoteBody()
                request.url.endsWith("/reconcile") -> { commandStatus = "confirmed"; remoteBody() }
                else -> error("unexpected_request")
            }
        }
        return GatewayResponse(status, body.toString())
    }
}

class ControlClientTest {
    private val gateway = ControlGateway("gw-a", "space-a", "local-space", "owner", listOf("commands.write"), "revision-a", true)
    private val device = Device("device-lamp", "sha256:fixture", true)
    @Test fun exactOriginAndDurableProofBeforeNetwork() = runBlocking {
        for (origin in listOf("http://control.example", "https://user@control.example", "https://control.example/", "https://control.example/path", "https://control.example?key=x", "http://localhost")) {
            assertFailsWith<ControlException> { ControlClient(origin, MemoryControlStore(), allowLoopbackHTTP = true) }
        }
        val store = MemoryControlStore(); val fixture = ControlFixture()
        val client = ControlClient(fixture.origin, store, fixture)
        store.fail = true; assertFailsWith<IOException> { client.beginAuthorization() }; assertTrue(fixture.requests.isEmpty())
        store.fail = false; fixture.loseStart = true
        assertFailsWith<IOException> { client.beginAuthorization() }
        val recovered = ControlClient(fixture.origin, store, fixture); val login = recovered.beginAuthorization()
        assertEquals(2, fixture.requests.size); assertTrue(fixture.requests[0].body == fixture.requests[1].body, "original initiation restored")
        val persisted = Json.parseToJsonElement(store.records.values.single()).jsonObject
        val proof = persisted.getValue("pending").jsonObject.getValue("proof").jsonObject
        val verifier = proof.getValue("code_verifier").jsonPrimitive.content
        val expected = Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))
        val input = Json.parseToJsonElement(fixture.requests.first().body!!).jsonObject
        assertEquals(expected, input.getValue("code_challenge").jsonPrimitive.content)
        assertTrue(input.getValue("request_key").jsonPrimitive.content.matches(Regex("[a-f0-9]{64}")))
        assertFalse(login.toString().contains(login.userCode)); assertTrue(store.records.keys.all { it.startsWith("limeiot.control:v1:") })
    }
    @Test fun durableIdentityProviderOutageAndIndependentLogout() = runBlocking {
        val store = MemoryControlStore(); val fixture = ControlFixture()
        val client = ControlClient(fixture.origin, store, fixture)
        client.beginAuthorization(); val result = client.pollAuthorization()
        assertEquals(NativeAuthorizationStatus.APPROVED, result.status); assertEquals("owner", result.session?.principal?.principalId)
        val restored = ControlClient(fixture.origin, store, fixture)
        assertEquals("owner", restored.restoreSession().principal.principalId); assertEquals("space-a", restored.spaces().single().spaceId)
        fixture.unavailable = true; assertEquals(503, assertFailsWith<ControlException> { restored.restoreSession() }.status)
        fixture.unavailable = false; assertEquals("owner", restored.restoreSession().principal.principalId)
        // 退出不先调用提供方userinfo，使用当前本站Token派生的CSRF。
        fixture.unavailable = true; restored.logout(); fixture.unavailable = false
        assertEquals("unauthenticated", assertFailsWith<ControlException> { restored.restoreSession() }.code)
        assertEquals("unauthenticated", assertFailsWith<ControlException> { client.restoreSession() }.code)
        for (request in fixture.requests.filter { URI(it.url).path.startsWith("/api/native/") }) {
            for (header in listOf("Cookie", "Origin", "Authorization")) assertNull(request.headers[header])
        }
        val logout = fixture.requests.first { it.url.endsWith("/auth/logout") }
        assertEquals(digest("limeiot-csrf:console:${fixture.token}"), logout.headers["X-CSRF-Token"])
    }
    @Test fun invalidMaterialsAndCrossOriginVerificationAreRejected() = runBlocking {
        for (poison in listOf("redirect", "origin", "audience", "principal", "pending")) {
            val fixture = ControlFixture().apply { this.poison = poison }; val client = ControlClient(fixture.origin, MemoryControlStore(), fixture)
            val error = assertFailsWith<ControlException> { client.beginAuthorization(); client.pollAuthorization() }
            assertEquals("invalid_response", error.code)
            if (poison in listOf("origin", "audience", "pending")) assertTrue(fixture.requests.all { it.headers["Cookie"] == null })
        }
    }
    @Test fun cancellationRevokesAndClearsCurrentCloudIdentity() = runBlocking {
        val fixture = ControlFixture(); val client = ControlClient(fixture.origin, MemoryControlStore(), fixture)
        client.beginAuthorization(); client.pollAuthorization(); client.cancelAuthorization()
        assertEquals("unauthenticated", assertFailsWith<ControlException> { client.restoreSession() }.code)
        assertEquals("authorization_required", assertFailsWith<ControlException> { client.pollAuthorization() }.code)
    }
    @Test fun durableRemoteIntentionResponseLossRestartAndMissingOriginalNeverReplays() = runBlocking {
        val store = MemoryControlStore(); val fixture = ControlFixture(); val client = ControlClient(fixture.origin, store, fixture)
        client.beginAuthorization(); client.pollAuthorization(); store.fail = true
        assertFailsWith<IOException> { client.prepareCommand("space-a", gateway, device, "light.brightness", JsonPrimitive(37)) }
        store.fail = false; assertTrue(client.commandRecords("space-a").isEmpty())
        val record = client.prepareCommand("space-a", gateway, device, "light.brightness", JsonPrimitive(37))
        store.fail = true; assertFailsWith<IOException> { client.submitCommand(record.id) }
        assertTrue(fixture.requests.none { it.url.endsWith("/remote-commands") })
        store.fail = false; fixture.loseCommand = true
        assertFailsWith<IOException> { client.submitCommand(record.id) }
        val restored = ControlClient(fixture.origin, store, fixture); fixture.missingCommand = true
        assertEquals(404, assertFailsWith<ControlException> { restored.submitCommand(record.id) }.status)
        assertEquals("operation_not_terminal", assertFailsWith<ControlException> { restored.forgetCommand(record.id) }.code)
        fixture.missingCommand = false
        val unknown = restored.submitCommand(record.id); assertEquals(ControlCommandStatus.UNKNOWN, unknown.result?.status); assertTrue(unknown.attempted)
        assertEquals(ControlCommandStatus.CONFIRMED, restored.resolveCommand(record.id, true).result?.status)
        assertEquals(1, fixture.requests.count { it.method == "POST" && it.url.endsWith("/remote-commands") })
        assertTrue(fixture.requests.any { it.method == "POST" && it.url.endsWith("/reconcile") })
        restored.logout()
        val next = ControlClient(fixture.origin, store, fixture)
        assertEquals("unauthenticated", assertFailsWith<ControlException> { next.commandRecords("space-a") }.code)
        val state = Json.parseToJsonElement(store.records.values.single()).jsonObject
        assertEquals(1, state.getValue("operations").jsonArray.size); assertEquals(JsonNull, state["material"])
    }
    @Test fun remoteOriginalScopeAndDeviceEvidenceAreRequiredForConfirmation() = runBlocking {
        for (poison in listOf("principal", "request", "evidence", "local_request")) {
            val store = MemoryControlStore(); val fixture = ControlFixture(); val client = ControlClient(fixture.origin, store, fixture)
            client.beginAuthorization(); client.pollAuthorization()
            val record = client.prepareCommand("space-a", gateway, device, "light.brightness", JsonPrimitive(37))
            client.submitCommand(record.id); fixture.remotePoison = poison
            assertEquals("invalid_response", assertFailsWith<ControlException> { client.resolveCommand(record.id, true) }.code)
            assertEquals(ControlCommandStatus.UNKNOWN, client.commandRecords("space-a").single().result?.status)
        }
    }
    @Test fun definitiveRemoteRejectionIsSavedAndOnlyTerminalOperationsCanBeRemoved() = runBlocking {
        val store = MemoryControlStore(); val fixture = ControlFixture(); val client = ControlClient(fixture.origin, store, fixture)
        client.beginAuthorization(); client.pollAuthorization()
        val record = client.prepareCommand("space-a", gateway, device, "light.power", JsonPrimitive(true))
        fixture.rejectCommand = true
        assertEquals(403, assertFailsWith<ControlException> { client.submitCommand(record.id) }.status)
        assertEquals("forbidden", client.submitCommand(record.id).rejection)
        assertEquals(1, fixture.requests.count { it.method == "POST" && it.url.endsWith("/remote-commands") })
        client.forgetCommand(record.id); assertTrue(client.commandRecords("space-a").isEmpty())
    }
    @Test fun preparedOriginalCanBeExplicitlyDiscardedAfterRecreationWithoutSubmission() = runBlocking {
        val store = MemoryControlStore(); val fixture = ControlFixture(); val client = ControlClient(fixture.origin, store, fixture)
        client.beginAuthorization(); client.pollAuthorization()
        val record = client.prepareCommand("space-a", gateway, device, "light.power", JsonPrimitive(true))
        assertTrue(record.isPrepared); assertTrue(record.canForget)
        val restored = ControlClient(fixture.origin, store, fixture)
        restored.forgetCommand(record.id); assertTrue(restored.commandRecords("space-a").isEmpty())
        assertTrue(fixture.requests.none { it.method == "POST" && it.url.endsWith("/remote-commands") })
    }
    @Test fun actionScopeAndOriginalKeySurviveLostResponse() = runBlocking {
        for (scope in listOf("submitted", "observed")) {
            val store = MemoryControlStore(); val fixture = ControlFixture(); val client = ControlClient(fixture.origin, store, fixture)
            client.beginAuthorization(); client.pollAuthorization(); store.fail = true
            val value = buildJsonObject { put("key", "home") }
            assertFailsWith<IOException> { client.prepareCommand("space-a", gateway, device, "remote.press", value, "action.invoke") }
            store.fail = false
            val record = client.prepareCommand("space-a", gateway, device, "remote.press", value, "action.invoke")
            fixture.loseCommand = true; assertFailsWith<IOException> { client.submitCommand(record.id) }
            val restored = ControlClient(fixture.origin, store, fixture); restored.submitCommand(record.id)
            if (scope == "observed") fixture.remotePoison = "action_observed"
            val result = restored.resolveCommand(record.id, true)
            assertEquals(if (scope == "submitted") "输入已提交" else "效果已观测", Command.actionStatus(result.result?.localResult?.jsonObject?.get("evidence")))
            assertEquals("遥控：主页", record.reference.request.operation.summary)
            assertEquals(1, fixture.requests.count { it.method == "POST" && it.url.endsWith("/remote-commands") })
        }
    }
    @Test fun invalidActionEvidenceCannotConfirmOriginal() = runBlocking {
        for (poison in listOf("request", "local_request", "evidence", "action_type", "action_path", "action_digest", "action_scope", "action_output", "action_missing", "action_time", "action_future", "action_extra", "action_error")) {
            val fixture = ControlFixture(); val client = ControlClient(fixture.origin, MemoryControlStore(), fixture)
            client.beginAuthorization(); client.pollAuthorization()
            val record = client.prepareCommand("space-a", gateway, device, "remote.press", buildJsonObject { put("key", "home") }, "action.invoke")
            client.submitCommand(record.id); fixture.remotePoison = poison
            assertEquals("invalid_response", assertFailsWith<ControlException> { client.resolveCommand(record.id, true) }.code, poison)
            assertEquals(ControlCommandStatus.UNKNOWN, client.commandRecords("space-a").single().result?.status)
        }
    }
    @Test fun actionPathAndTypeMatchFormalContract() = runBlocking {
        val fixture = ControlFixture(); val client = ControlClient(fixture.origin, MemoryControlStore(), fixture)
        client.beginAuthorization(); client.pollAuthorization()
        client.prepareCommand("space-a", gateway, device, "a".repeat(64) + "." + "b".repeat(64), buildJsonObject {}, "action.invoke")
        for (path in listOf("a".repeat(65) + ".b", "a." + "b".repeat(65), "remote", "Remote.press", "remote.press.more", "remote.press\n")) assertFailsWith<ControlException> { client.prepareCommand("space-a", gateway, device, path, buildJsonObject {}, "action.invoke") }
        assertFailsWith<ControlException> { client.prepareCommand("space-a", gateway, device, "remote.press", buildJsonObject {}, "shell") }
        assertTrue(fixture.requests.none { it.url.endsWith("/remote-commands") })
    }
    @Test fun actualControlBrowserApprovalStoredIdentityAndLogout() = runBlocking {
        if (System.getenv("LIMEIOT_NATIVE_CONTROL_CHECK") != "1") return@runBlocking
        val origin = requireNotNull(System.getenv("LIMEIOT_TEST_CONTROL_ORIGIN"))
        val directory = java.nio.file.Path.of(requireNotNull(System.getenv("LIMEIOT_NATIVE_CHECK_DIRECTORY")))
        val store = object : SessionStore {
            override suspend fun load(origin: String): String? {
                val file = directory.resolve(digest(origin) + ".json")
                return if (java.nio.file.Files.exists(file)) java.nio.file.Files.readString(file) else null
            }
            override suspend fun save(origin: String, value: String?) {
                val file = directory.resolve(digest(origin) + ".json")
                val mode = java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")
                if (!java.nio.file.Files.exists(file)) java.nio.file.Files.createFile(file, java.nio.file.attribute.PosixFilePermissions.asFileAttribute(mode))
                java.nio.channels.FileChannel.open(file, java.nio.file.StandardOpenOption.WRITE, java.nio.file.StandardOpenOption.TRUNCATE_EXISTING).use { channel ->
                    val bytes = java.nio.ByteBuffer.wrap(value.orEmpty().toByteArray())
                    while (bytes.hasRemaining()) channel.write(bytes)
                    channel.force(true)
                }
            }
        }
        val ca = System.getenv("LIMEIOT_TEST_CONTROL_CA_FILE")
        if (ca != null) {
            val untrusted = ControlClient(origin, store)
            assertFailsWith<javax.net.ssl.SSLException> { untrusted.beginAuthorization() }
        }
        val transport = if (ca != null) controlTLSTransport(ca) else OkHttpTransport()
        val client = ControlClient(origin, store, transport, allowLoopbackHTTP = true)
        val login = client.beginAuthorization()
        val request = directory.resolve("login.json")
        java.nio.file.Files.createFile(request, java.nio.file.attribute.PosixFilePermissions.asFileAttribute(java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")))
        java.nio.file.Files.writeString(request, Json.encodeToString(NativeLogin.serializer(), login))
        var result = client.pollAuthorization()
        repeat(30) { if (result.status == NativeAuthorizationStatus.PENDING) { kotlinx.coroutines.delay(3000); result = client.pollAuthorization() } }
        assertEquals(NativeAuthorizationStatus.APPROVED, result.status); assertNotNull(result.session)
        val restored = ControlClient(origin, store, transport, allowLoopbackHTTP = true)
        assertEquals(result.session?.principal?.principalId, restored.restoreSession().principal.principalId)
        val spaces = restored.spaces(); assertTrue(spaces.isNotEmpty())
        val space = requireNotNull(System.getenv("LIMEIOT_NATIVE_CHECK_SPACE")); assertTrue(spaces.any { it.spaceId == space })
        val gateway = restored.gateways(space).first { it.active }
        val page = restored.devices(space); val lamp = page.items.first { it.deviceId == "device-lamp" }
        val action = System.getenv("LIMEIOT_NATIVE_CHECK_ACTION") == "1"
        assertEquals(gateway.revision, page.bindingRevision); assertTrue(restored.model(space, lamp.modelRevision).services.any { it.id == if (action) "remote" else "light" })
        val record = restored.prepareCommand(space, gateway, lamp, if (action) "remote.press" else "light.brightness", if (action) buildJsonObject { put("key", "home") } else JsonPrimitive(37), if (action) "action.invoke" else "property.set")
        java.nio.file.Files.writeString(directory.resolve("operation.json"), Json.encodeToString(ControlCommandRecord.serializer(), record), java.nio.file.StandardOpenOption.CREATE_NEW)
        suspend fun wait(marker: String) {
            repeat(300) { if (java.nio.file.Files.exists(directory.resolve(marker))) return; kotlinx.coroutines.delay(100) }
            error("fixture_marker_timeout")
        }
        wait("send"); assertFailsWith<IOException> { restored.submitCommand(record.id) }
        java.nio.file.Files.writeString(directory.resolve("unknown"), "unknown")
        wait("recover")
        val recovered = ControlClient(origin, store, transport, allowLoopbackHTTP = true)
        var outcome = recovered.submitCommand(record.id)
        repeat(20) { if (outcome.result?.status?.terminal != true) { kotlinx.coroutines.delay(200); outcome = recovered.resolveCommand(record.id, true) } }
        assertEquals(ControlCommandStatus.CONFIRMED, outcome.result?.status); assertEquals(record.reference, outcome.reference)
        if (action) assertEquals("输入已提交", Command.actionStatus(outcome.result?.localResult?.jsonObject?.get("evidence")))
        recovered.logout(); assertEquals("unauthenticated", assertFailsWith<ControlException> { client.restoreSession() }.code)
        val after = ControlClient(origin, store, transport, allowLoopbackHTTP = true)
        assertEquals("unauthenticated", assertFailsWith<ControlException> { after.commandRecords(space) }.code)
    }
}
