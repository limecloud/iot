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
import kotlin.test.*

private const val homeOrigin = "https://nas.local"
private class HomeMemory : SessionStore {
    val values = mutableMapOf<String, String>()
    var pendingMode = "normal"
    override suspend fun load(origin: String) = values[origin]
    override suspend fun save(origin: String, value: String?) {
        if (origin.endsWith("#pending")) {
            if (pendingMode == "throw") throw IOException("storage fixture")
            if (pendingMode == "ignore" || (pendingMode == "ignore-clear" && value == "{}")) return
        }
        if (value == null) values.remove(origin) else values[origin] = value
    }
    fun pending() = values["$homeOrigin#pending"]
}
private class HomeWire : GatewayTransport {
    val requests = mutableListOf<GatewayRequest>()
    var lose = false; var wrong = false; var missing = false; var offline = false
    private var original: JsonObject? = null
    private fun receipt(): String {
        val request = requireNotNull(original).let { if (wrong) JsonObject(it + ("device_id" to JsonPrimitive("another-device"))) else it }
        val operation = request.getValue("operation").jsonObject
        return buildJsonObject {
            put("command_id", "command-original"); put("status", "confirmed"); put("request", request)
            put("request_digest", ObservationJSON.digest(request)); put("error", JsonNull); put("run_id", JsonNull)
            putJsonObject("evidence") { put("type", "device_result"); putJsonObject("reported") { put(operation.getValue("path").jsonPrimitive.content, operation.getValue("value")) } }
        }.toString()
    }
    override suspend fun send(request: GatewayRequest): GatewayResponse {
        requests += request
        val path = URI(request.url).path
        val body = when {
            path.endsWith("/auth/session") -> return GatewayResponse(200, """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}""", "__Host-limeiot_session=fixture; Secure")
            path.endsWith("/auth/logout") -> "{}"
            path == "/api/v1/spaces" -> """{"items":[{"space_id":"space-demo"}]}"""
            path.endsWith("/devices") -> {
                if (offline) return GatewayResponse(503, """{"error":{"code":"unavailable"}}""")
                """{"items":[{"device_id":"device-lamp","model_revision":"sha256:${"a".repeat(64)}","ready":true,"reported":{}}]}"""
            }
            path.endsWith("/capabilities") -> """{"models":{}}"""
            path.endsWith("/commands") && request.method == "POST" -> {
                val input = Json.parseToJsonElement(requireNotNull(request.body)).jsonObject
                original = JsonObject(input + mapOf("space_id" to JsonPrimitive("space-demo"), "idempotency_key" to JsonPrimitive(requireNotNull(request.headers["Idempotency-Key"]))))
                if (lose) throw IOException("response lost")
                receipt()
            }
            path.contains("/commands/by-key/") -> {
                assertEquals(original?.get("idempotency_key")?.jsonPrimitive?.content, path.substringAfterLast('/'))
                if (missing) return GatewayResponse(404, """{"error":{"code":"command_not_found"}}""")
                receipt()
            }
            path.endsWith("/commands") || path.endsWith("/rule-deployments") || path.endsWith("/runs") -> """{"items":[],"next_cursor":null}"""
            else -> error("unexpected endpoint: $path")
        }
        return GatewayResponse(200, body)
    }
    fun posts() = requests.count { URI(it.url).path.endsWith("/commands") && it.method == "POST" }
}

@OptIn(ExperimentalCoroutinesApi::class)
class HomeViewModelTest {
    private val dispatcher = UnconfinedTestDispatcher()
    @Before fun setup() { Dispatchers.setMain(dispatcher) }
    @After fun cleanup() { Dispatchers.resetMain() }
    private fun home(memory: HomeMemory, wire: HomeWire, restore: Boolean = false) = HomeViewModel(memory, transport = wire).also { it.connect(homeOrigin, if (restore) null else "owner-input", restore) }

    @Test fun failedOrUnverifiedStorageNeverSends() = runTest(dispatcher) {
        for (mode in listOf("throw", "ignore")) {
            val memory = HomeMemory(); val wire = HomeWire(); val vm = home(memory, wire)
            try {
                advanceUntilIdle(); assertTrue(vm.state.value.online); memory.pendingMode = mode
                vm.control(vm.state.value.snapshot!!.devices.single(), "light.power", JsonPrimitive(true)); advanceUntilIdle()
                assertEquals(0, wire.posts()); assertTrue(vm.state.value.pending.isEmpty()); assertFalse(vm.state.value.busy)
            } finally { vm.viewModelScope.cancel() }
        }
    }
    @Test fun wrongReceiptAndMissingOriginalSurviveRecreationWithoutAnotherPost() = runTest(dispatcher) {
        val memory = HomeMemory(); val wire = HomeWire(); val first = home(memory, wire)
        var restored: HomeViewModel? = null
        try {
            advanceUntilIdle(); wire.wrong = true
            first.control(first.state.value.snapshot!!.devices.single(), "light.power", JsonPrimitive(true)); advanceUntilIdle()
            val original = first.state.value.pending.getValue("device-lamp"); val bytes = memory.pending()
            assertEquals(1, wire.posts()); assertNotNull(bytes)
            restored = home(memory, wire, restore = true); advanceUntilIdle()
            assertEquals(original, restored.state.value.pending.getValue("device-lamp"))
            val device = restored.state.value.snapshot!!.devices.single()
            restored.control(device, "light.power", JsonPrimitive(false)); advanceUntilIdle(); assertEquals(1, wire.posts())
            restored.recover(device); advanceUntilIdle(); assertEquals(bytes, memory.pending()); assertEquals(original, restored.state.value.pending[device.deviceId])
            wire.wrong = false; wire.missing = true; restored.recover(device); advanceUntilIdle()
            assertEquals(bytes, memory.pending()); assertEquals(1, wire.posts())
            wire.missing = false; restored.recover(device); advanceUntilIdle()
            assertTrue(restored.state.value.pending.isEmpty()); assertEquals("{}", memory.pending()); assertEquals(1, wire.posts())
        } finally { first.viewModelScope.cancel(); restored?.viewModelScope?.cancel() }
    }
    @Test fun lostResponseSurvivesLogoutAndRestore() = runTest(dispatcher) {
        val memory = HomeMemory(); val wire = HomeWire(); val first = home(memory, wire)
        var restored: HomeViewModel? = null
        try {
            advanceUntilIdle(); wire.lose = true
            first.control(first.state.value.snapshot!!.devices.single(), "light.power", JsonPrimitive(true)); advanceUntilIdle()
            val original = memory.pending(); assertNotNull(original)
            first.logout(); advanceUntilIdle(); assertFalse(first.state.value.connected); assertEquals(original, memory.pending())
            restored = home(memory, wire); advanceUntilIdle(); assertEquals(1, wire.posts())
            restored.recover(restored.state.value.snapshot!!.devices.single()); advanceUntilIdle()
            assertTrue(restored.state.value.pending.isEmpty()); assertEquals(1, wire.posts())
        } finally { first.viewModelScope.cancel(); restored?.viewModelScope?.cancel() }
    }
    @Test fun failedClearRetainsOriginalUntilAReadBackSucceeds() = runTest(dispatcher) {
        val memory = HomeMemory(); val wire = HomeWire(); val vm = home(memory, wire)
        try {
            advanceUntilIdle(); memory.pendingMode = "ignore-clear"
            val device = vm.state.value.snapshot!!.devices.single()
            vm.control(device, "light.power", JsonPrimitive(true)); advanceUntilIdle()
            assertEquals(1, wire.posts()); assertTrue(vm.state.value.pending.containsKey(device.deviceId)); assertNotEquals("{}", memory.pending())
            memory.pendingMode = "normal"; vm.recover(device); advanceUntilIdle()
            assertTrue(vm.state.value.pending.isEmpty()); assertEquals("{}", memory.pending()); assertEquals(1, wire.posts())
        } finally { vm.viewModelScope.cancel() }
    }
    @Test fun corruptOriginalBlocksConnectionAndDoesNotEraseBytes() = runTest(dispatcher) {
        val memory = HomeMemory(); memory.values["$homeOrigin#pending"] = "{"
        val wire = HomeWire(); val vm = home(memory, wire)
        try { advanceUntilIdle(); assertFalse(vm.state.value.connected); assertFalse(vm.state.value.online); assertEquals("{", memory.pending()); assertEquals(0, wire.posts()) }
        finally { vm.viewModelScope.cancel() }
    }
    @Test fun unavailableSnapshotRetainsObservationAndBlocksControl() = runTest(dispatcher) {
        val memory = HomeMemory(); val wire = HomeWire(); val vm = home(memory, wire)
        try {
            advanceUntilIdle(); val snapshot = vm.state.value.snapshot!!
            val conversation = assertNotNull(vm.state.value.textGeneration); assertTrue(conversation.state.value.online)
            val voiceTurn = assertNotNull(vm.state.value.voiceTurn); assertTrue(voiceTurn.state.value.online)
            wire.offline = true; vm.refresh()
            assertFalse(vm.state.value.online); assertEquals(snapshot, vm.state.value.snapshot)
            assertFalse(conversation.state.value.online); assertFalse(conversation.state.value.ready)
            assertFalse(voiceTurn.state.value.online); assertFalse(voiceTurn.state.value.ready); assertNull(voiceTurn.visible())
            vm.control(snapshot.devices.single(), "light.power", JsonPrimitive(true)); advanceUntilIdle(); assertEquals(0, wire.posts())
            wire.offline = false; vm.refresh(); assertTrue(vm.state.value.online)
            assertSame(conversation, vm.state.value.textGeneration); assertTrue(conversation.state.value.online)
            assertSame(voiceTurn, vm.state.value.voiceTurn); assertTrue(voiceTurn.state.value.online)
            vm.logout(); advanceUntilIdle(); assertNull(vm.state.value.textGeneration); assertNull(vm.state.value.voiceTurn)
        } finally { vm.viewModelScope.cancel() }
    }
}
