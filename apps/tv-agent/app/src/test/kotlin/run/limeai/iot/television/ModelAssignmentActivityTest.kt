package run.limeai.iot.television

import android.app.Activity
import android.app.AlertDialog
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
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
import run.limeai.iot.device.DeviceModelProfile
import kotlin.test.*

/** 实际平台Views与生命周期；没有启动Service、连接设备或改变系统音量。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = TelevisionApplication::class, shadows = [ApkImportLinuxFixture::class])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class ModelAssignmentActivityTest {
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup)
        (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun button(activity: Activity, title: String) = views(activity.window.decorView).filterIsInstance<Button>().single { it.text.toString() == title }
    private fun fixture(): ModelAssignmentRuntimeFixture {
        val app = RuntimeEnvironment.getApplication() as TelevisionApplication
        return ModelAssignmentRuntimeFixture(app).also { ReflectionHelpers.setField(app, "runtime\$delegate", lazyOf(it.runtime)) }
    }
    private fun chooseAudio(activity: Activity): AlertDialog {
        button(activity, "扩展设备能力配置").performClick()
        val selection = ShadowAlertDialog.getLatestAlertDialog()
        val index = (0 until selection.listView.adapter.count).single {
            selection.listView.adapter.getItem(it).toString() == "应用启动、音量与静音"
        }
        selection.listView.performItemClick(null, index, selection.listView.adapter.getItemId(index))
        pumpModel { ShadowAlertDialog.getLatestAlertDialog() !== selection }
        return ShadowAlertDialog.getLatestAlertDialog()
    }

    @Test fun explicit_model_confirmation_preserves_identity_and_never_starts_connection_or_grants_audio() {
        fixture().use { f ->
            val controller = Robolectric.buildActivity(TelevisionActivity::class.java).setup()
            try {
                val activity = controller.get()
                val dialog = chooseAudio(activity)
                val text = views(dialog.window!!.decorView).filterIsInstance<TextView>().joinToString("\n") { it.text.toString() }
                assertTrue(text.contains(f.original.identity.device)); assertTrue(text.contains(f.original.certificateFingerprint))
                assertTrue(text.contains("不能回退")); assertTrue(text.contains("另行允许"))
                assertEquals(DeviceModelProfile.APPLICATIONS, f.inspect { it.load()!!.identity.profile })
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
                try { pumpModel { f.runtime.screen.summary?.model == DeviceModelProfile.AUDIO_APPLICATIONS.id } }
                catch (error: AssertionError) { throw AssertionError("能力保存未完成：${f.runtime.screen.notice}; model=${f.runtime.screen.summary?.model}", error) }
                f.inspect {
                    assertEquals(f.original.keyReference, it.load()!!.keyReference)
                    assertEquals(f.original.certificateFingerprint, it.load()!!.certificateFingerprint)
                }
                assertFalse(f.runtime.running); assertFalse(f.runtime.screen.audioAuthorized)
                assertTrue(f.connections.isEmpty()); assertNull(shadowOf(activity).nextStartedService)
            } finally { controller.pause().stop().destroy() }
        }
    }

    @Test fun cancelled_or_recreated_confirmation_cannot_apply_old_review() {
        fixture().use { f ->
            val original = Robolectric.buildActivity(TelevisionActivity::class.java).setup()
            val cancelled = chooseAudio(original.get())
            val cancelledConfirm = cancelled.getButton(AlertDialog.BUTTON_POSITIVE)
            cancelled.getButton(AlertDialog.BUTTON_NEGATIVE).performClick()
            cancelledConfirm.performClick()
            pumpModel { f.runtime.screen.notice.contains("已失效") }
            assertEquals(DeviceModelProfile.APPLICATIONS, f.inspect { it.load()!!.identity.profile })
            val old = chooseAudio(original.get()); val oldConfirm = old.getButton(AlertDialog.BUTTON_POSITIVE)
            original.pause().stop().destroy(); assertFalse(old.isShowing)
            val current = Robolectric.buildActivity(TelevisionActivity::class.java).setup()
            try {
                oldConfirm.performClick()
                f.inspect { it.load() } // 原队列屏障，先消费旧页面回调，再核对未写入。
                pumpModel { f.runtime.screen.notice.contains("已失效") }
                assertEquals(DeviceModelProfile.APPLICATIONS, f.inspect { it.load()!!.identity.profile })
                assertTrue(f.connections.isEmpty()); assertFalse(f.runtime.screen.audioAuthorized)
                assertNull(shadowOf(current.get()).nextStartedService)
                chooseAudio(current.get()).getButton(AlertDialog.BUTTON_POSITIVE).performClick()
                pumpModel { f.runtime.screen.summary?.model == DeviceModelProfile.AUDIO_APPLICATIONS.id }
            } finally { current.pause().stop().destroy() }
        }
    }
}
