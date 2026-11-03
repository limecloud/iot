package run.limeai.iot

import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import run.limeai.iot.core.*
import java.io.IOException
import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import kotlin.test.*

private class CloudMemoryStore : SessionStore {
    val records = mutableMapOf<String, String>()
    var preparedGate: CompletableDeferred<Unit>? = null
    var preparedWaiting = false
    override suspend fun load(origin: String) = records[origin]
    override suspend fun save(origin: String, value: String?) {
        if (value == null) records.remove(origin) else records[origin] = value
        val gate = preparedGate
        if (gate != null && value != null && Json.parseToJsonElement(value).jsonObject["operations"]?.jsonArray?.isNotEmpty() == true) {
            preparedGate = null; preparedWaiting = true
            withContext(NonCancellable) { gate.await() }
        }
    }
}
private class CloudTransport : GatewayTransport {
    val origin = "https://control.example"
    val requests = mutableListOf<GatewayRequest>()
    val model = "sha256:" + "a".repeat(64)
    val token = "c".repeat(64)
    val expiry = Instant.now().plusSeconds(300).toString()
    val sessionExpiry = Instant.now().plusSeconds(3500).toString()
    var blockPoll: CompletableDeferred<Unit>? = null
    var devicesGate: CompletableDeferred<Unit>? = null
    var devicesWaiting = false
    var loseCommand = true
    var offline = false
    var badRevision = false
    var command: JsonObject? = null
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        requests += request
        val path = URI(request.url).path
        val body = when {
            path == "/api/native/v1/authorizations" -> """{"authorization_id":"na-${"b".repeat(64)}","user_code":"ABCDEF12","verification_uri":"$origin/console/?native=na-${"b".repeat(64)}","expires_at":"$expiry","interval_seconds":3,"status":"pending"}"""
            path.endsWith("/authorizations/poll") -> {
                blockPoll?.await()
                """{"status":"approved","expires_at":"$expiry","material":{"version":1,"origin":"$origin","audience":"console","session":"$token","principal_id":"owner","expires_at":"$sessionExpiry"}}"""
            }
            path.endsWith("/auth/session") -> {
                val csrf = MessageDigest.getInstance("SHA-256").digest("limeiot-csrf:console:$token".toByteArray()).joinToString("") { "%02x".format(it) }
                """{"audience":"console","principal":{"principal_id":"owner","name":"测试账号"},"csrf_token":"$csrf","expires_at":"$sessionExpiry"}"""
            }
            path.endsWith("/auth/logout") -> """{"logged_out":true}"""
            path == "/api/console/v1/spaces" -> """{"spaces":[{"space_id":"space-a","name":"家庭"},{"space_id":"space-b","name":"教室"}]}"""
            path.endsWith("/space-b/gateways") -> """{"gateways":[]}"""
            path.endsWith("/gateways") -> """{"gateways":[{"gateway_id":"gateway-a","space_id":"space-a","local_space_id":"local-a","principal_id":"owner","scopes":["devices.read","commands.write"],"revision":"revision-a","active":true}]}"""
            path.endsWith("/devices") -> {
                devicesGate?.let { gate -> devicesGate = null; devicesWaiting = true; withContext(NonCancellable) { gate.await() } }
                if (offline) return GatewayResponse(503, """{"error":{"code":"gateway_offline"}}""")
                """{"items":[{"device_id":"lamp","model_revision":"$model","ready":true,"reported":{"light.power":{"value":false,"observed_at":"2026-11-02T00:00:00Z","quality":"current","source":"device"}}}],"next":null,"binding_revision":"${if (badRevision) "other" else "revision-a"}"}"""
            }
            path.contains("/model-releases/") -> """{"revision":"$model","model":{"model_id":"light","services":[{"id":"light","properties":[{"id":"power","schema":{"type":"boolean"},"access":["read","write"]}],"events":[]}]}}"""
            path.endsWith("/remote-commands") && request.method == "POST" -> {
                command = Json.parseToJsonElement(requireNotNull(request.body)).jsonObject
                if (loseCommand) throw IOException("response_lost")
                remote("unknown")
            }
            path.contains("/remote-commands/by-key/") -> remote("unknown")
            path.endsWith("/reconcile") -> remote("accepted")
            else -> error("unexpected endpoint: $path")
        }
        return GatewayResponse(200, body)
    }
    private fun remote(status: String) = buildJsonObject {
        put("remote_id", "remote-" + "d".repeat(64)); put("space_id", "space-a"); put("principal_id", "owner"); put("local_space_id", "local-a")
        put("request_digest", "a".repeat(64)); put("request", requireNotNull(command)); put("status", status); put("local_result", JsonNull)
    }.toString()
    fun creates() = requests.count { URI(it.url).path.endsWith("/remote-commands") && it.method == "POST" }
}

@OptIn(ExperimentalCoroutinesApi::class)
class CloudViewModelTest {
    private val dispatcher = UnconfinedTestDispatcher()
    @Before fun setup() { Dispatchers.setMain(dispatcher) }
    @After fun cleanup() { Dispatchers.resetMain() }

    @Test fun backgroundDoesNotPollAndInterruptedAuthorizationResumesOriginalRequest() = runTest(dispatcher) {
        val transport = CloudTransport(); val store = CloudMemoryStore(); val vm = CloudViewModel(store, transport = transport)
        try {
            vm.begin(transport.origin); advanceUntilIdle(); assertNotNull(vm.state.value.login)
            val before = transport.requests.size; vm.tick(); assertEquals(before, transport.requests.size)
            transport.blockPoll = CompletableDeferred(); vm.enterForeground()
            val poll = launch { vm.tick() }; runCurrent(); vm.leaveForeground(); poll.cancelAndJoin()
            assertNull(vm.state.value.principal); assertTrue(vm.state.value.pendingAuthorization)
            transport.blockPoll = null; vm.enterForeground(); vm.tick()
            assertEquals("owner", vm.state.value.principal?.principalId); assertTrue(vm.state.value.online)
            assertEquals(1, transport.requests.count { URI(it.url).path == "/api/native/v1/authorizations" })
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun lostCommandSurvivesRecreationAndOfflineQueryNeverCreatesAgain() = runTest(dispatcher) {
        val store = CloudMemoryStore(); val transport = CloudTransport(); val first = CloudViewModel(store, transport = transport)
        val restored = CloudViewModel(store, transport.origin, transport = transport)
        try {
            first.begin(transport.origin); first.enterForeground(); first.tick()
            val device = first.state.value.devices.single()
            first.control(device, "light.power", JsonPrimitive(true)); advanceUntilIdle()
            assertEquals(1, transport.creates()); assertTrue(first.state.value.records.single().attempted)
            assertTrue(first.state.value.blocked(device)); assertFalse(first.state.value.online)
            transport.offline = true; restored.enterForeground(); restored.tick()
            assertEquals(1, restored.state.value.records.size); assertFalse(restored.state.value.online)
            restored.control(device, "light.power", JsonPrimitive(true)); advanceUntilIdle(); assertEquals(1, transport.creates())
            restored.resolve(restored.state.value.records.single()); advanceUntilIdle()
            assertEquals(ControlCommandStatus.ACCEPTED, restored.state.value.records.single().result?.status)
            restored.forget(restored.state.value.records.single()); advanceUntilIdle()
            assertEquals(1, restored.state.value.records.size); assertEquals(1, transport.creates())
            restored.logout(); advanceUntilIdle(); assertNull(restored.state.value.principal)
            val persisted = Json.parseToJsonElement(store.records.values.single()).jsonObject
            assertEquals(1, persisted.getValue("operations").jsonArray.size); assertEquals(JsonNull, persisted["material"])
        } finally { first.viewModelScope.cancel(); restored.viewModelScope.cancel() }
    }

    @Test fun bindingRevisionMismatchDisablesControlAndSpaceSwitchClearsOldProjection() = runTest(dispatcher) {
        val transport = CloudTransport(); val vm = CloudViewModel(CloudMemoryStore(), transport = transport)
        try {
            vm.begin(transport.origin); vm.enterForeground(); vm.tick(); assertEquals(1, vm.state.value.devices.size)
            transport.badRevision = true; vm.refresh(); advanceUntilIdle(); assertFalse(vm.state.value.online)
            vm.selectSpace("space-b"); advanceUntilIdle()
            assertEquals("space-b", vm.state.value.space); assertTrue(vm.state.value.devices.isEmpty())
            assertTrue(vm.state.value.models.isEmpty()); assertTrue(vm.state.value.records.isEmpty()); assertNull(vm.state.value.gateway)
            assertEquals(0, transport.creates())
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun backgroundDuringPreparedStorageNeverSubmitsAndRestoresOriginalOnly() = runTest(dispatcher) {
        val transport = CloudTransport(); val store = CloudMemoryStore(); val vm = CloudViewModel(store, transport = transport)
        try {
            vm.begin(transport.origin); vm.enterForeground(); vm.tick()
            val device = vm.state.value.devices.single(); val gate = CompletableDeferred<Unit>(); store.preparedGate = gate
            vm.control(device, "light.power", JsonPrimitive(true)); runCurrent(); assertTrue(store.preparedWaiting)
            vm.leaveForeground(); gate.complete(Unit); advanceUntilIdle()
            assertEquals(0, transport.creates()); assertFalse(vm.state.value.online); assertFalse(vm.state.value.busy)
            vm.enterForeground(); vm.tick()
            assertEquals(1, vm.state.value.records.size); assertFalse(vm.state.value.records.single().attempted)
            assertEquals(0, transport.creates())
            vm.forget(vm.state.value.records.single()); advanceUntilIdle()
            assertTrue(vm.state.value.records.isEmpty()); assertFalse(vm.state.value.blocked(device)); assertEquals(0, transport.creates())
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun lateRefreshCannotRestoreOnlineStateAfterBackground() = runTest(dispatcher) {
        val transport = CloudTransport(); val vm = CloudViewModel(CloudMemoryStore(), transport = transport)
        try {
            vm.begin(transport.origin); vm.enterForeground(); vm.tick()
            val gate = CompletableDeferred<Unit>(); transport.devicesGate = gate
            vm.refresh(); runCurrent(); assertTrue(transport.devicesWaiting)
            vm.leaveForeground(); gate.complete(Unit); advanceUntilIdle()
            assertFalse(vm.state.value.foreground); assertFalse(vm.state.value.online); assertFalse(vm.state.value.busy)
            assertEquals(0, transport.creates())
        } finally { vm.viewModelScope.cancel() }
    }
}
