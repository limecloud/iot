package run.limeai.iot.television

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream

/** 实际遥控器事件验证页面边界；不开始连接、不授予权限、不修改设备身份。 */
@RunWith(AndroidJUnit4::class)
class TvExperienceRuntimeTest {
    @Test fun actual_dpad_navigation_back_and_safe_screen_visual_capture() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val runtime = (context.applicationContext as TelevisionApplication).runtime
        assertFalse(runtime.running)
        val before = AndroidAgentStore(context).use { store -> store.load()?.certificateFingerprint to store.allowed() }
        instrumentation.setInTouchMode(false)
        val activity = instrumentation.startActivitySync(Intent(context, TelevisionActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup)
            (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
        fun button(title: String) = views(activity.window.decorView).filterIsInstance<Button>().single { it.text.toString() == title }
        fun screenshot(name: String) {
            // 仅隔离instrumentation为公开页面临时开放截图；产品窗口继续保持FLAG_SECURE。
            instrumentation.runOnMainSync { activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
            instrumentation.waitForIdleSync()
            try {
                val bitmap = instrumentation.uiAutomation.takeScreenshot()
                assertNotNull(bitmap)
                FileOutputStream(File(context.filesDir, name + ".png")).use { output ->
                    assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)); output.fd.sync()
                }
                bitmap.recycle()
            } finally { instrumentation.runOnMainSync { activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) } }
        }
        try {
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                assertTrue(button("总览").isSelected)
                assertEquals("总览", (activity.window.decorView.findFocus() as Button).text.toString())
            }
            screenshot("tv-home")
            for ((index, page) in listOf("连接设置", "应用授权", "设备维护", "诊断信息").withIndex()) {
                instrumentation.runOnMainSync { assertTrue(button("总览").requestFocus()) }
                repeat(index + 1) { instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_RIGHT) }
                instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_DOWN)
                instrumentation.waitForIdleSync()
                instrumentation.runOnMainSync {
                    assertTrue("D-pad must activate $page", button(page).isSelected)
                    assertNotNull("content must retain focus", activity.window.decorView.findFocus())
                    val focused = activity.window.decorView.findFocus()
                    assertTrue("focused element must remain within the screen", focused.getGlobalVisibleRect(android.graphics.Rect()))
                }
                // 身份诊断含设备摘要，保留本机保护，不采集该页截图。
                if (page != "诊断信息") screenshot("tv-page-" + index)
                instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_UP)
                instrumentation.runOnMainSync {
                    assertTrue("Up returns to the current tab", button(page).hasFocus())
                    assertTrue(button(page).isSelected)
                }
                instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
                instrumentation.waitForIdleSync()
                instrumentation.runOnMainSync { assertTrue("Back must return home", button("总览").isSelected) }
                assertFalse(runtime.running)
            }
            assertFalse(runtime.screen.audioAuthorized)
            AndroidAgentStore(context).use { store ->
                assertEquals(before.first, store.load()?.certificateFingerprint)
                assertEquals(before.second, store.allowed())
            }
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }
}
