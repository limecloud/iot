package run.limeai.iot.television

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import org.robolectric.shadows.ShadowAlertDialog
import org.robolectric.util.ReflectionHelpers
import kotlin.test.*

/** 实际平台页面/生命周期与原Runtime；系统服务调度和音频服务仍为宿主夹具。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = TelevisionApplication::class, shadows = [AndroidAudioTest.Mixer::class, ApkImportLinuxFixture::class])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class AudioConsentActivityTest {
    @Before fun setup() { AndroidAudioTest.Mixer.reset() }
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup)
        (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun button(activity: Activity, title: String) = views(activity.window.decorView).filterIsInstance<Button>().single { it.text.toString() == title }
    private fun fixture(): AudioRuntimeFixture {
        val application = RuntimeEnvironment.getApplication() as TelevisionApplication
        return AudioRuntimeFixture(application).also { ReflectionHelpers.setField(application, "runtime\$delegate", lazyOf(it.runtime)) }
    }

    @Test fun cancel_leaves_audio_unapproved_and_starting_service_is_not_implicit_consent() {
        fixture().use { f ->
            val controller = Robolectric.buildActivity(TelevisionActivity::class.java).setup()
            try {
                val activity = controller.get()
                button(activity, "开始连接").performClick()
                val dialog = ShadowAlertDialog.getLatestAlertDialog()
                assertTrue(dialog.isShowing)
                val text = views(dialog.window!!.decorView).filterIsInstance<TextView>().joinToString("\n") { it.text.toString() }
                assertTrue(text.contains(f.enrollment.identity.device)); assertTrue(text.contains("本次连接")); assertTrue(text.contains("停止"))
                assertNull(shadowOf(activity).nextStartedService)
                dialog.getButton(AlertDialog.BUTTON_NEGATIVE).performClick(); pumpAudio { !dialog.isShowing }
                assertNull(shadowOf(activity).nextStartedService)
                f.runtime.start { f.finished.incrementAndGet() }
                pumpAudio { !f.runtime.running && f.finished.get() == 1 }
                assertTrue(f.connections.isEmpty()); assertFalse(f.runtime.screen.audioAuthorized)
                assertTrue(AndroidAudioTest.Mixer.volumes.isEmpty()); assertTrue(AndroidAudioTest.Mixer.adjustments.isEmpty())
            } finally { controller.pause().stop().destroy() }
        }
    }

    @Test fun recreated_page_rejects_old_confirm_then_new_explicit_confirm_and_revoke_control_one_run() {
        fixture().use { f ->
            val original = Robolectric.buildActivity(TelevisionActivity::class.java).setup()
            button(original.get(), "开始连接").performClick()
            val oldDialog = ShadowAlertDialog.getLatestAlertDialog()
            val oldConfirm = oldDialog.getButton(AlertDialog.BUTTON_POSITIVE)
            original.pause().stop().destroy()
            assertFalse(oldDialog.isShowing)
            val current = Robolectric.buildActivity(TelevisionActivity::class.java).setup()
            try {
                oldConfirm.performClick()
                shadowOf(Looper.getMainLooper()).idle()
                assertNull(shadowOf(original.get()).nextStartedService); assertNull(shadowOf(current.get()).nextStartedService)
                assertFalse(f.runtime.screen.audioAuthorized)
                button(current.get(), "开始连接").performClick()
                val dialog = ShadowAlertDialog.getLatestAlertDialog()
                assertNotSame(oldDialog, dialog)
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
                var started: Intent? = null
                pumpAudio { started = started ?: shadowOf(current.get()).nextStartedService; started != null }
                val intent = assertNotNull(started)
                assertEquals(AgentService::class.java.name, intent.component!!.className)
                assertEquals(AgentService.ACTION_START, intent.action); assertNull(intent.extras)
                val connection = f.start(); pumpAudio { f.runtime.screen.audioAuthorized }
                assertTrue(connection.port.permitted())
                button(current.get(), "取消本次音量和静音授权并停止").performClick()
                pumpAudio { !f.runtime.screen.audioAuthorized }
                assertFalse(connection.port.permitted())
                f.release(connection)
                assertTrue(AndroidAudioTest.Mixer.volumes.isEmpty()); assertTrue(AndroidAudioTest.Mixer.adjustments.isEmpty())
            } finally { current.pause().stop().destroy() }
        }
    }
}
