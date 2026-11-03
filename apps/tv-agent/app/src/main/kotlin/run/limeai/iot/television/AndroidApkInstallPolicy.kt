package run.limeai.iot.television

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.UserManager
import android.provider.Settings
import run.limeai.iot.device.ApkInstallJournal
import run.limeai.iot.device.DeviceFault

/** 普通应用的安装来源门禁；只读系统政策，不授权、不改设置或启动界面。 */
internal class AndroidApkInstallPolicy(private val context: Context) {
    fun verify() = guarded {
        if (!authorized()) throw DeviceFault("apk_install_source_authorization_required")
    }

    /** 仅供后续可见页面上的明确用户操作使用；返回后仍须重新核对原任务全部门禁。 */
    fun sourceAuthorizationIntent(): Intent? = guarded {
        if (authorized()) return@guarded null
        val intent = if (Build.VERSION.SDK_INT >= 26) {
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.fromParts("package", ApkInstallJournal.PACKAGE, null))
        } else Intent(Settings.ACTION_SECURITY_SETTINGS)
        val flags = PackageManager.MATCH_DEFAULT_ONLY or (if (Build.VERSION.SDK_INT >= 24) PackageManager.MATCH_SYSTEM_ONLY else 0)
        val resolved = context.packageManager.resolveActivity(intent, flags)
            ?.activityInfo ?: throw DeviceFault("apk_install_source_settings_unavailable")
        val app = resolved.applicationInfo ?: throw DeviceFault("apk_install_source_settings_unavailable")
        if (!resolved.enabled || !resolved.exported || !app.enabled || resolved.packageName.isNullOrBlank() || resolved.name.isNullOrBlank() || app.packageName != resolved.packageName ||
            resolved.permission?.let { context.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED } == true ||
            app.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0)
            throw DeviceFault("apk_install_source_settings_unavailable")
        intent.component = ComponentName(resolved.packageName, resolved.name)
        intent
    }

    @Suppress("DEPRECATION") // API23–25按系统安装器读取Secure开关，不用于API26起的按来源授权。
    private fun authorized(): Boolean {
        if (context.packageName != ApkInstallJournal.PACKAGE) throw DeviceFault("apk_install_package_mismatch")
        val info = context.packageManager.getPackageInfo(ApkInstallJournal.PACKAGE, PackageManager.GET_PERMISSIONS)
        if (info.packageName != ApkInstallJournal.PACKAGE || info.requestedPermissions?.contains(Manifest.permission.REQUEST_INSTALL_PACKAGES) != true)
            throw DeviceFault("apk_install_source_permission_missing")
        val users = context.getSystemService(Context.USER_SERVICE) as? UserManager ?: throw DeviceFault("apk_install_policy_unavailable")
        if (users.hasUserRestriction(UserManager.DISALLOW_INSTALL_APPS) || users.hasUserRestriction(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES) ||
            Build.VERSION.SDK_INT >= 29 && users.hasUserRestriction(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY))
            throw DeviceFault("apk_install_policy_restricted")
        return if (Build.VERSION.SDK_INT >= 26) context.packageManager.canRequestPackageInstalls()
            else Settings.Secure.getInt(context.contentResolver, Settings.Secure.INSTALL_NON_MARKET_APPS, 0) > 0
    }

    private inline fun <T> guarded(action: () -> T): T = try { action() }
        catch (fault: DeviceFault) { throw fault }
        catch (_: Exception) { throw DeviceFault("apk_install_policy_unavailable") }
}
