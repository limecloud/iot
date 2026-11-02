package run.limeai.iot

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import run.limeai.iot.core.GatewayClient
import run.limeai.iot.core.GatewayRequest
import run.limeai.iot.core.OkHttpTransport
import java.io.File

private class RuntimeFixture {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val config = JSONObject(File(context.filesDir, "runtime-fixture.json").readText())
    val origin: String = config.getString("origin")
    val owner: String = config.getString("owner")
    private val transport = OkHttpTransport()
    suspend fun control(action: String): JSONObject {
        val response = transport.send(GatewayRequest("$origin/__fixture", "POST", mapOf(
            "Authorization" to "Bearer " + config.getString("control"), "Content-Type" to "application/json"),
            JSONObject().put("action", action).toString()))
        check(response.status == 200)
        return JSONObject(response.body)
    }
    fun screenshot(name: String) {
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        File(context.filesDir, "$name.png").outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        bitmap.recycle()
    }
    fun report(name: String, details: JSONObject) {
        File(context.filesDir, "$name.json").writeText(details.put("hardware", false).toString())
    }
}

@RunWith(AndroidJUnit4::class)
class HomeRuntimeTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    @Test fun nasLoginControlOfflineAndForegroundUseActualApp() = runBlocking {
        val fixture = RuntimeFixture()
        compose.onNodeWithTag("nas-origin").performTextReplacement(fixture.origin)
        compose.onNodeWithTag("nas-credential").performTextReplacement(fixture.owner)
        compose.onNodeWithText("连接家庭网关").performScrollTo().performClick()
        try {
            compose.waitUntil(30000) { compose.onAllNodesWithText("我的设备").fetchSemanticsNodes().isNotEmpty() }
        } catch (error: Exception) {
            compose.runOnUiThread {
                val state = ViewModelProvider(compose.activity)[HomeViewModel::class.java].state.value
                fixture.report("nas-login-failure", JSONObject().put("passed", false).put("message", state.message)
                    .put("connected", state.connected).put("online", state.online).put("busy", state.busy))
            }
            fixture.screenshot("nas-login-failure")
            throw error
        }
        val client = GatewayClient(fixture.origin, store = SecureStore(fixture.context)); client.restore()
        val before = client.snapshot()
        val old = before.devices.first { it.deviceId == "device-lamp" }.reported["light.power"]!!.value
        compose.onAllNodes(isToggleable()).onFirst().assertIsEnabled().performClick()
        compose.waitUntil(15000) { compose.onAllNodesWithText("最近操作：已确认").fetchSemanticsNodes().isNotEmpty() }
        val after = client.snapshot()
        assertEquals(before.commands.items.size + 1, after.commands.items.size)
        assertNotEquals(old, after.devices.first { it.deviceId == "device-lamp" }.reported["light.power"]!!.value)
        fixture.screenshot("nas-connected")

        fixture.control("offline")
        compose.onNodeWithText("刷新").performScrollTo().performClick()
        compose.waitUntil(15000) { compose.onAllNodesWithText("连接中断，当前显示上次观测").fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(isToggleable()).onFirst().assertIsNotEnabled()
        fixture.screenshot("nas-offline")
        fixture.control("online")
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        delay(1500)
        val background = fixture.control("stats").getInt("apiRequests")
        delay(6500)
        assertEquals(background, fixture.control("stats").getInt("apiRequests"))
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.waitUntil(15000) { compose.onAllNodesWithText("连接中断，当前显示上次观测").fetchSemanticsNodes().isEmpty() }
        assertTrue(fixture.control("stats").getInt("apiRequests") > background)
        compose.onAllNodes(isToggleable()).onFirst().assertIsEnabled()
        fixture.report("nas-runtime", JSONObject().put("passed", true).put("commandsAdded", 1)
            .put("backgroundPollingStopped", true).put("offlineControlDisabled", true))
    }
}

@RunWith(AndroidJUnit4::class)
class HomeResumeRuntimeTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    @Test fun freshProcessRestoresKeystoreSessionWithoutLoginOrCommandReplay() = runBlocking {
        val fixture = RuntimeFixture()
        compose.waitUntil(30000) {
            compose.onAllNodes(isToggleable()).fetchSemanticsNodes().isNotEmpty() &&
                compose.onAllNodesWithText("连接中断，当前显示上次观测").fetchSemanticsNodes().isEmpty()
        }
        val control = compose.onAllNodes(isToggleable()).onFirst().assertIsEnabled()
        val stats = fixture.control("stats")
        assertEquals(1, stats.getInt("loginPosts")); assertEquals(1, stats.getInt("commandPosts"))
        val client = GatewayClient(fixture.origin, store = SecureStore(fixture.context)); client.restore()
        val restored = client.snapshot()
        assertEquals(1, restored.commands.items.size)
        if (restored.devices.first { it.deviceId == "device-lamp" }.reported["light.power"]!!.value.toString() == "true") {
            control.assertIsOn()
        } else control.assertIsOff()
        fixture.screenshot("nas-restored")
        compose.onNodeWithTag("nas-tab-3").performClick()
        compose.onNodeWithText("退出登录").performClick()
        compose.waitUntil(15000) { compose.onAllNodesWithText("连接我的家").fetchSemanticsNodes().isNotEmpty() }
        assertNull(SecureStore(fixture.context).load(fixture.origin))
        fixture.report("nas-resume", JSONObject().put("passed", true).put("freshProcess", true)
            .put("loginPosts", 1).put("commandPosts", 1).put("restoredUiOnline", true).put("logoutClearedSession", true))
    }
}
