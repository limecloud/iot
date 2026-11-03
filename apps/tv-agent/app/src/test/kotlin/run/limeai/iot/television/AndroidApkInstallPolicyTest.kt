package run.limeai.iot.television

import android.Manifest
import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.net.Uri
import android.os.Build
import android.os.Process
import android.os.UserManager
import android.provider.Settings
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowApplicationPackageManager
import run.limeai.iot.device.ApkInstallJournal
import run.limeai.iot.device.DeviceFault
import kotlin.test.*

/** 所有授权、设置和用户限制来自Robolectric夹具，不改宿主或电视设置。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, shadows = [AndroidApkInstallPolicyTest.Resolver::class])
@Suppress("DEPRECATION")
class AndroidApkInstallPolicyTest {
    @Implements(className = "android.app.ApplicationPackageManager", isInAndroidSdk = false)
    class Resolver : ShadowApplicationPackageManager() {
        @Implementation override fun resolveActivity(intent: Intent, flags: Int): ResolveInfo? = super.resolveActivity(intent, flags).also(afterResolve)
        companion object { var afterResolve: (ResolveInfo?) -> Unit = {} }
    }
    @Before fun resetResolver() { Resolver.afterResolve = {} }
    private val context get() = RuntimeEnvironment.getApplication()
    private val policy get() = AndroidApkInstallPolicy(context)
    private val packages get() = shadowOf(context.packageManager)
    private val users get() = context.getSystemService(Context.USER_SERVICE) as UserManager
    private fun fault(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<DeviceFault>(block = block).code)
    private fun allowed(value: Boolean) {
        if (Build.VERSION.SDK_INT >= 26) packages.setCanRequestPackageInstalls(value)
        else Settings.Secure.putInt(context.contentResolver, Settings.Secure.INSTALL_NON_MARKET_APPS, if (value) 1 else 0)
    }
    private fun settings() = if (Build.VERSION.SDK_INT >= 26)
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.fromParts("package", ApkInstallJournal.PACKAGE, null))
        else Intent(Settings.ACTION_SECURITY_SETTINGS)
    private fun handler(mutate: (ActivityInfo) -> Unit = {}) {
        val activity = ActivityInfo().apply {
            packageName = "com.android.settings"; name = "com.android.settings.InstallSources"
            enabled = true; exported = true
            applicationInfo = ApplicationInfo().apply { packageName = "com.android.settings"; enabled = true; flags = ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_INSTALLED }
        }
        mutate(activity)
        packages.setResolveInfosForIntent(settings(), listOf(ResolveInfo().apply { activityInfo = activity; isDefault = true }))
    }

    @Test @Config(sdk = [23, 28, 31])
    fun manifest_declares_install_source_permission_but_does_not_grant_source_authorization() {
        val info = context.packageManager.getPackageInfo(ApkInstallJournal.PACKAGE, PackageManager.GET_PERMISSIONS)
        assertContains(assertNotNull(info.requestedPermissions).toList(), Manifest.permission.REQUEST_INSTALL_PACKAGES)
        allowed(false)
        fault("apk_install_source_authorization_required") { policy.verify() }
        assertNull(shadowOf(context).nextStartedActivity)
    }

    @Test @Config(sdk = [23])
    fun legacy_secure_setting_is_read_without_using_the_new_per_source_api() {
        allowed(false); fault("apk_install_source_authorization_required") { policy.verify() }
        for (value in listOf(1, 2)) {
            Settings.Secure.putInt(context.contentResolver, Settings.Secure.INSTALL_NON_MARKET_APPS, value)
            policy.verify(); assertNull(policy.sourceAuthorizationIntent())
            assertEquals(value, Settings.Secure.getInt(context.contentResolver, Settings.Secure.INSTALL_NON_MARKET_APPS))
        }
    }

    @Test @Config(sdk = [28, 31])
    fun modern_authorization_ignores_legacy_global_enable_and_rechecks_revocation() {
        Settings.Secure.putInt(context.contentResolver, Settings.Secure.INSTALL_NON_MARKET_APPS, 1)
        allowed(false); fault("apk_install_source_authorization_required") { policy.verify() }
        allowed(true); policy.verify(); assertNull(policy.sourceAuthorizationIntent())
        allowed(false); fault("apk_install_source_authorization_required") { policy.verify() }
    }

    @Test @Config(sdk = [23, 28, 31])
    fun admin_restrictions_block_even_authorized_sources_and_never_offer_settings() {
        allowed(true)
        val restrictions = mutableListOf(UserManager.DISALLOW_INSTALL_APPS, UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES)
        if (Build.VERSION.SDK_INT >= 29) restrictions += UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY
        for (restriction in restrictions) {
            shadowOf(users).setUserRestriction(Process.myUserHandle(), restriction, true)
            fault("apk_install_policy_restricted") { policy.verify() }
            fault("apk_install_policy_restricted") { policy.sourceAuthorizationIntent() }
            shadowOf(users).setUserRestriction(Process.myUserHandle(), restriction, false)
            policy.verify()
        }
        assertNull(shadowOf(context).nextStartedActivity)
    }

    @Test fun missing_manifest_permission_never_becomes_an_authorized_source() {
        val info = context.packageManager.getPackageInfo(ApkInstallJournal.PACKAGE, PackageManager.GET_PERMISSIONS)
        info.requestedPermissions = emptyArray(); packages.installPackage(info)
        allowed(true)
        fault("apk_install_source_permission_missing") { policy.verify() }
        fault("apk_install_source_permission_missing") { policy.sourceAuthorizationIntent() }
    }

    @Test fun foreign_context_unavailable_user_service_and_package_read_fail_closed() {
        val foreign = object : ContextWrapper(context) { override fun getPackageName() = "example.other" }
        fault("apk_install_package_mismatch") { AndroidApkInstallPolicy(foreign).verify() }
        val unavailable = object : ContextWrapper(context) { override fun getSystemService(name: String): Any? = if (name == Context.USER_SERVICE) null else super.getSystemService(name) }
        fault("apk_install_policy_unavailable") { AndroidApkInstallPolicy(unavailable).verify() }
        val denied = object : ContextWrapper(context) { override fun getPackageManager(): PackageManager = throw SecurityException("fixture") }
        fault("apk_install_policy_unavailable") { AndroidApkInstallPolicy(denied).verify() }
    }

    @Test @Config(sdk = [23, 28, 31])
    fun settings_intent_is_fixed_to_the_system_handler_and_never_started_automatically() {
        allowed(false); handler()
        val intent = policy.sourceAuthorizationIntent()!!
        assertEquals(settings().action, intent.action); assertEquals(settings().data, intent.data)
        assertEquals(ComponentName("com.android.settings", "com.android.settings.InstallSources"), intent.component)
        assertEquals(0, intent.flags); assertTrue(intent.extras == null || intent.extras!!.isEmpty)
        assertNull(shadowOf(context).nextStartedActivity)
        fault("apk_install_source_authorization_required") { policy.verify() }
        allowed(true); policy.verify(); assertNull(policy.sourceAuthorizationIntent())
    }

    @Test @Config(sdk = [23, 28])
    fun missing_non_system_disabled_private_or_permission_protected_settings_are_rejected() {
        allowed(false)
        fault("apk_install_source_settings_unavailable") { policy.sourceAuthorizationIntent() }
        val mutations = listOf<(ActivityInfo) -> Unit>(
            { it.applicationInfo.flags = ApplicationInfo.FLAG_INSTALLED }, { it.enabled = false }, { it.exported = false },
            { it.applicationInfo.enabled = false }, { it.permission = "example.permission.PRIVATE" },
        )
        for (mutate in mutations) {
            handler(mutate)
            fault("apk_install_source_settings_unavailable") { policy.sourceAuthorizationIntent() }
        }
        // Robolectric会把component包名改成application包名；在返回边界明确注入原不一致事实。
        handler()
        Resolver.afterResolve = { it?.activityInfo?.applicationInfo?.packageName = "example.other" }
        fault("apk_install_source_settings_unavailable") { policy.sourceAuthorizationIntent() }
        assertNull(shadowOf(context).nextStartedActivity)
    }
}
