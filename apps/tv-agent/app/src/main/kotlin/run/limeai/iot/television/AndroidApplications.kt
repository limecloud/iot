package run.limeai.iot.television

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import run.limeai.iot.device.ApplicationPort

/** 每次运行独占的许可；停止后不复活，避免旧线程借用新连接授权。 */
class RunPermit {
    @Volatile var active = true; private set
    fun stop() { active = false }
}

class AndroidApplications(
    private val context: Context,
    private val authorized: (String) -> Boolean,
    private val lock: Any,
    private val permit: RunPermit,
    private val credentialsValid: () -> Boolean = { true },
    private val visible: () -> Boolean,
) : ApplicationPort {
    data class Entry(val packageName: String, val label: String)

    private fun launchIntent(packageName: String): Intent? {
        val pm = context.packageManager
        val intent = pm.getLeanbackLaunchIntentForPackage(packageName) ?: return null
        val component = intent.component ?: return null
        if (component.packageName != packageName || packageName == context.packageName) return null
        val activity = try { pm.getActivityInfo(component, 0) } catch (_: PackageManager.NameNotFoundException) { return null }
        if (!activity.enabled || !activity.applicationInfo.enabled || !activity.exported) return null
        val (packageSetting, activitySetting) = try { pm.getApplicationEnabledSetting(packageName) to pm.getComponentEnabledSetting(component) }
            catch (_: IllegalArgumentException) { return null } // 包可能在查询间被卸载。
        val disabled = setOf(PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER, PackageManager.COMPONENT_ENABLED_STATE_DISABLED_UNTIL_USED)
        if (packageSetting in disabled || activitySetting in disabled) return null
        if (activity.permission != null && context.checkSelfPermission(activity.permission) != PackageManager.PERMISSION_GRANTED) return null
        return Intent(intent).setPackage(packageName).setComponent(component)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    }

    private fun available(packageName: String): Boolean = permit.active && credentialsValid() &&
        (Build.VERSION.SDK_INT < 29 || visible()) && authorized(packageName)

    override fun permitted(application: String): Boolean = synchronized(lock) { available(application) && launchIntent(application) != null }
    override fun submit(application: String) = synchronized(lock) {
        if (!available(application)) throw AgentStoreFault("application_not_authorized")
        val intent = launchIntent(application) ?: throw AgentStoreFault("application_unavailable")
        if (!credentialsValid()) throw AgentStoreFault("invalid_credentials")
        context.startActivity(intent)
    }

    companion object {
        fun discover(context: Context): List<Entry> {
            val pm = context.packageManager
            val query = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER)
            return pm.queryIntentActivities(query, 0).mapNotNull { resolved ->
                val info = resolved.activityInfo ?: return@mapNotNull null
                if (!info.enabled || !info.applicationInfo.enabled || !info.exported || info.packageName == context.packageName) return@mapNotNull null
                Entry(info.packageName, resolved.loadLabel(pm).toString().take(128))
            }.distinctBy { it.packageName }.sortedBy { it.packageName }.take(128)
        }
    }
}
