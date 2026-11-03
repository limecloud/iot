package run.limeai.iot.television

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.pm.ResolveInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
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
import run.limeai.iot.device.*
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.*

/** 实际平台Views、SAF返回和生命周期的宿主行为；系统选择器/电视显示仍待实机。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [23, 28], application = TelevisionApplication::class, shadows = [ApkImportLinuxFixture::class])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class ApkUpdateActivityTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun button(activity: Activity, text: String) = views(activity.window.decorView).filterIsInstance<Button>().single { it.text.toString() == text }
    private fun deliver(activity: Activity, code: Int, uri: Uri) {
        ReflectionHelpers.callInstanceMethod<Void>(activity, "onActivityResult",
            ReflectionHelpers.ClassParameter.from(Int::class.javaPrimitiveType!!, code),
            ReflectionHelpers.ClassParameter.from(Int::class.javaPrimitiveType!!, Activity.RESULT_OK),
            ReflectionHelpers.ClassParameter.from(Intent::class.java, Intent().setData(uri)))
    }
    private fun pump(condition: () -> Boolean) {
        val deadline = System.nanoTime() + 2_000_000_000L
        while (!condition() && System.nanoTime() < deadline) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(5) }
        shadowOf(Looper.getMainLooper()).idle(); assertTrue(condition(), "页面结果未在原2秒观察预算内到达")
    }

    @Test fun document_selection_recovers_original_request_after_activity_recreation_and_cancel_does_not_approve() {
        val material = ApkPreflightFixture.create(debug = true)
        ReflectionHelpers.setStaticField(Build::class.java, "SUPPORTED_ABIS", arrayOf("x86_64"))
        ApkPreflightFixture.installFacts(context, material)
        val controller = Robolectric.buildActivity(ApkUpdateActivity::class.java).setup()
        val activity = controller.get()
        pump { button(activity, "导入签名预检文件").isEnabled }
        button(activity, "导入签名预检文件").performClick()
        val picker = shadowOf(activity).nextStartedActivityForResult
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, picker.intent.action)
        assertTrue(picker.intent.hasCategory(Intent.CATEGORY_OPENABLE))
        deliver(activity, picker.requestCode, Uri.fromFile(material.bundle))
        pump { shadowOf(activity).peekNextStartedActivityForResult() != null }
        val candidatePicker = shadowOf(activity).nextStartedActivityForResult
        val requestId = AndroidApkImports(context).entries().single().requestId
        val saved = Bundle(); controller.saveInstanceState(saved).pause().stop().destroy()
        val reopened = Robolectric.buildActivity(ApkUpdateActivity::class.java).create(saved).start().resume().visible()
        deliver(reopened.get(), candidatePicker.requestCode, Uri.fromFile(material.candidate))
        pump { ShadowAlertDialog.getLatestAlertDialog()?.isShowing == true }
        val dialog = ShadowAlertDialog.getLatestAlertDialog()
        val text = views(dialog.window!!.decorView).filterIsInstance<TextView>().joinToString("\n") { it.text.toString() }
        assertTrue(text.contains("3 → 4")); assertTrue(text.contains("android.permission.REQUEST_INSTALL_PACKAGES")); assertTrue(text.contains(material.signer))
        assertFalse(views(dialog.window!!.decorView).filterIsInstance<CheckBox>().single().isChecked)
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        assertTrue(dialog.isShowing) // 开发包未明确允许，不能保存计划。
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE).performClick()
        pump { !dialog.isShowing }
        assertEquals(requestId, AndroidApkImports(context).entries().single().requestId)
        AndroidApkInstallStore(context).use { assertTrue(ApkInstallJournal(it).snapshot().isEmpty()) }
        assertTrue(context.packageManager.packageInstaller.mySessions.isEmpty())
        reopened.pause().stop().destroy()
    }

    @Test fun backgrounded_import_keeps_copy_without_opening_picker_or_dialog_until_user_returns() {
        val material = ApkPreflightFixture.create()
        val controller = Robolectric.buildActivity(ApkUpdateActivity::class.java).setup()
        val activity = controller.get()
        deliver(activity, 61, Uri.fromFile(material.bundle))
        controller.pause().stop()
        pump { AndroidApkImports(context).entries().any { it.hasPreflight } }
        assertNull(shadowOf(activity).nextStartedActivityForResult)
        assertTrue(ShadowAlertDialog.getLatestAlertDialog()?.isShowing != true)
        controller.start().resume().visible()
        pump { views(activity.window.decorView).filterIsInstance<Button>().any { it.text.toString() == "继续选择原 APK" } }
        assertTrue(context.packageManager.packageInstaller.mySessions.isEmpty())
        controller.pause().stop().destroy()
    }

    @Test fun source_settings_return_preserves_prepared_plan_and_never_starts_installation_automatically() {
        val pin = "sha256:" + "a".repeat(64)
        val plan = ApkInstallPlan("update-one", Fixtures.enrollment.binding, pin, "sha256:" + "b".repeat(64), pin, 3, 4, 123, pin, pin)
        AndroidApkInstallStore(context).use { ApkInstallJournal(it).prepare(plan) }
        val settings = if (Build.VERSION.SDK_INT >= 26) {
            shadowOf(context.packageManager).setCanRequestPackageInstalls(false)
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.fromParts("package", context.packageName, null))
        } else {
            @Suppress("DEPRECATION") Settings.Secure.putInt(context.contentResolver, Settings.Secure.INSTALL_NON_MARKET_APPS, 0)
            Intent(Settings.ACTION_SECURITY_SETTINGS)
        }
        val info = ActivityInfo().apply {
            packageName = "fixture.system.settings"; name = "fixture.system.settings.Sources"; enabled = true; exported = true
            applicationInfo = ApplicationInfo().apply { packageName = "fixture.system.settings"; enabled = true; flags = ApplicationInfo.FLAG_SYSTEM }
        }
        shadowOf(context.packageManager).setResolveInfosForIntent(settings, listOf(ResolveInfo().apply { activityInfo = info; isDefault = true }))
        val controller = Robolectric.buildActivity(ApkUpdateActivity::class.java).setup(); val activity = controller.get()
        pump { views(activity.window.decorView).filterIsInstance<Button>().any { it.text.toString() == "核对安装来源设置" } }
        button(activity, "核对安装来源设置").performClick()
        pump { shadowOf(activity).peekNextStartedActivityForResult() != null }
        val started = shadowOf(activity).nextStartedActivityForResult
        assertEquals(settings.action, started.intent.action); assertEquals(info.packageName, started.intent.component!!.packageName)
        controller.pause().stop()
        deliver(activity, started.requestCode, Uri.EMPTY)
        controller.start().resume().visible()
        pump { button(activity, "核对并继续原安装").isEnabled }
        val observed = AtomicReference<ApkInstallPhase?>(null)
        (context as TelevisionApplication).runtime.apkUpdates { observed.set(it.getOrThrow().records.single().phase) }
        pump { observed.get() != null }; assertEquals(ApkInstallPhase.PREPARED, observed.get())
        assertTrue(context.packageManager.packageInstaller.mySessions.isEmpty())
        assertNull(shadowOf(activity).nextStartedActivityForResult)
        controller.pause().stop().destroy()
    }
}
