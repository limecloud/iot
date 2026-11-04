package run.limeai.iot.television

import android.app.Activity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import org.robolectric.util.ReflectionHelpers
import kotlin.test.*

/** 页面导航不能建立连接、授予音频权限或改变原设备身份。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [23, 28], application = TelevisionApplication::class, shadows = [ApkImportLinuxFixture::class], qualifiers = "w960dp-h540dp-land-xhdpi")
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class TvNavigationActivityTest {
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup)
        (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun button(activity: Activity, text: String) = views(activity.window.decorView).filterIsInstance<Button>().single { it.text.toString() == text }
    private fun back(activity: Activity) {
        activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK))
        activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK))
    }
    private fun fixture(): ModelAssignmentRuntimeFixture {
        val app = RuntimeEnvironment.getApplication() as TelevisionApplication
        return ModelAssignmentRuntimeFixture(app).also { ReflectionHelpers.setField(app, "runtime\$delegate", lazyOf(it.runtime)) }
    }

    @Test fun maintenance_is_separate_from_home_and_back_returns_without_side_effects() {
        fixture().use { f ->
            val controller = Robolectric.buildActivity(TelevisionActivity::class.java).setup()
            try {
                val activity = controller.get()
                assertTrue(button(activity, "开始连接").isShown)
                assertFalse(button(activity, "扩展设备能力配置").isShown)
                for (page in listOf("连接设置", "应用授权", "设备维护", "诊断信息")) {
                    button(activity, page).performClick()
                    assertTrue(button(activity, page).isSelected)
                    back(activity)
                    assertTrue(button(activity, "总览").isSelected)
                }
                assertFalse(f.runtime.running); assertFalse(f.runtime.screen.audioAuthorized)
                assertTrue(f.connections.isEmpty())
                assertEquals(f.original.certificateFingerprint, f.inspect { it.load()!!.certificateFingerprint })
            } finally { controller.pause().stop().destroy() }
        }
    }

    @Test fun down_key_enters_content_and_recreation_preserves_only_current_page() {
        fixture().use { f ->
            val controller = Robolectric.buildActivity(TelevisionActivity::class.java).setup()
            try {
                val activity = controller.get()
                val applications = button(activity, "应用授权")
                assertTrue(applications.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_DOWN)))
                assertTrue(applications.isSelected)
                assertTrue(button(activity, "刷新设备与应用").isShown)
                assertFalse(button(activity, "开始连接").isShown)
                controller.recreate()
                assertTrue(button(controller.get(), "应用授权").isSelected)
                assertTrue(button(controller.get(), "刷新设备与应用").isShown)
                assertFalse(f.runtime.running); assertFalse(f.runtime.screen.audioAuthorized)
                assertTrue(f.connections.isEmpty())
            } finally { controller.pause().stop().destroy() }
        }
    }

    @Test fun horizontal_tabs_and_up_return_keep_current_page_without_side_effects() {
        fixture().use { f ->
            val controller = Robolectric.buildActivity(TelevisionActivity::class.java).setup()
            try {
                val activity = controller.get()
                val home = button(activity, "总览")
                home.requestFocus()
                home.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_RIGHT))
                val connection = button(activity, "连接设置")
                assertTrue(connection.hasFocus()); assertTrue(connection.isSelected)
                connection.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_DOWN))
                assertFalse(connection.hasFocus())
                activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_UP))
                assertTrue(connection.hasFocus()); assertTrue(connection.isSelected)
                connection.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_LEFT))
                assertTrue(home.hasFocus()); assertTrue(home.isSelected)
                home.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_LEFT))
                assertTrue(home.hasFocus())
                val maintenance = button(activity, "设备维护")
                // 与实机旧PEM身份一致：有设备材料，没有本机证书申请记录。
                ReflectionHelpers.setField(f.runtime, "screen", f.runtime.screen.copy(identityRequest = null))
                ReflectionHelpers.callInstanceMethod<Unit>(activity, "render")
                maintenance.requestFocus()
                assertFalse(button(activity, "扩展设备能力配置").isEnabled)
                assertFalse(button(activity, "扩展设备能力配置").isFocusable)
                assertFalse(button(activity, "取消本次音量和静音授权并停止").isFocusable)
                maintenance.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_DOWN))
                assertTrue(button(activity, "更新材料与批准").hasFocus())
                activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_UP))
                assertTrue(maintenance.hasFocus()); assertTrue(maintenance.isSelected)
                assertFalse(f.runtime.running); assertFalse(f.runtime.screen.audioAuthorized)
                assertTrue(f.connections.isEmpty())
            } finally { controller.pause().stop().destroy() }
        }
    }

    @Test fun home_tile_opens_authorization_without_starting_connection() {
        fixture().use { f ->
            val controller = Robolectric.buildActivity(TelevisionActivity::class.java).setup()
            try {
                val activity = controller.get()
                val row = views(activity.window.decorView).single {
                    it.contentDescription?.toString() == "应用授权，选择允许远程启动的应用"
                }
                assertTrue(row.isFocusable); assertTrue(row.isClickable)
                row.performClick()
                assertTrue(button(activity, "应用授权").isSelected)
                assertFalse(button(activity, "开始连接").isShown)
                assertFalse(f.runtime.running); assertTrue(f.connections.isEmpty())
                back(activity)
                assertTrue(button(activity, "开始连接").isShown)
            } finally { controller.pause().stop().destroy() }
        }
    }

    @Test fun unavailable_connection_is_not_presented_as_connecting_or_ready() {
        fixture().use { f ->
            val controller = Robolectric.buildActivity(TelevisionActivity::class.java).setup()
            try {
                val activity = controller.get()
                ReflectionHelpers.setField(f.runtime, "screen", f.runtime.screen.copy(status = "connection_unavailable"))
                ReflectionHelpers.callInstanceMethod<Unit>(activity, "render")
                val text = views(activity.window.decorView).filterIsInstance<android.widget.TextView>()
                    .filter { it.isShown }.map { it.text.toString() }
                assertTrue("暂时无法连接网关" in text)
                assertTrue("○  连接失败，等待重试" in text)
                assertFalse("正在建立安全连接" in text)
                assertFalse("●  已连接家庭网关" in text)
                assertFalse(f.runtime.running); assertTrue(f.connections.isEmpty())
            } finally { controller.pause().stop().destroy() }
        }
    }
}
