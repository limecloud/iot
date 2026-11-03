package run.limeai.iot.television

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import run.limeai.iot.device.*
import java.util.concurrent.CopyOnWriteArraySet

/** 仅保留经过原系统回执认证的临时确认；不序列化、不构造隐藏action、不在后台启动。 */
internal object ApkInstallConfirmations {
    private data class Key(val requestId: String, val digest: String, val sessionId: Int?)
    private data class Pending(val key: Key, val intent: Intent)
    private var pending: Pending? = null
    private val observers = CopyOnWriteArraySet<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    private fun key(record: ApkInstallRecord) = Key(record.plan.requestId, record.plan.digest, record.sessionId)

    fun observe(observer: () -> Unit) { observers += observer }
    fun remove(observer: () -> Unit) { observers -= observer }

    @Synchronized fun available(record: ApkInstallRecord) = record.phase == ApkInstallPhase.PENDING_USER && pending?.key == key(record)

    /** 必须在非导出回执完成原账本CAS之后调用；坏Intent不能撤回已收到的系统状态。 */
    @Synchronized fun received(context: Context, record: ApkInstallRecord, envelope: Intent) {
        if (record.phase == ApkInstallPhase.PENDING_USER) {
            try {
                @Suppress("DEPRECATION") // API23起读取系统Parcelable，再严格验证类型/目标/会话。
                val intent = envelope.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: throw DeviceFault("apk_install_confirmation_unavailable")
                pending = Pending(key(record), validate(context, record, intent))
            } catch (_: Exception) { /* 不信任损坏/不支持的确认载荷；保留原待确认阶段与已有合法临时入口。 */ }
        } else if (pending?.key == key(record)) pending = null
        main.post { observers.forEach { runCatching { it() } } }
    }

    @Synchronized fun intent(context: Context, record: ApkInstallRecord): Intent {
        if (!available(record)) throw DeviceFault("apk_install_confirmation_unavailable")
        return validate(context, record, pending!!.intent)
    }

    private fun validate(context: Context, record: ApkInstallRecord, intent: Intent): Intent {
        fun requireValid(valid: Boolean) { if (!valid) throw DeviceFault("apk_install_confirmation_unavailable") }
        requireValid((intent.action?.length ?: 0) in 1..256 && !intent.`package`.isNullOrBlank() && intent.`package` != context.packageName &&
            intent.data == null && intent.type == null && intent.selector == null && intent.clipData == null && intent.categories.isNullOrEmpty() &&
            intent.extras?.keySet() == setOf(PackageInstaller.EXTRA_SESSION_ID) && intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1) == record.sessionId)
        val clean = Intent(intent.action).setPackage(intent.`package`).setComponent(intent.component)
            .putExtra(PackageInstaller.EXTRA_SESSION_ID, record.sessionId!!)
        val flags = PackageManager.MATCH_DEFAULT_ONLY or (if (Build.VERSION.SDK_INT >= 24) PackageManager.MATCH_SYSTEM_ONLY else 0)
        val activity = context.packageManager.resolveActivity(clean, flags)?.activityInfo ?: throw DeviceFault("apk_install_confirmation_unavailable")
        val app = activity.applicationInfo ?: throw DeviceFault("apk_install_confirmation_unavailable")
        requireValid(activity.enabled && activity.exported && app.enabled && activity.packageName == intent.`package` &&
            app.packageName == activity.packageName && !activity.name.isNullOrBlank() &&
            app.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0 &&
            activity.permission?.let { context.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED } != true)
        val component = ComponentName(activity.packageName, activity.name)
        requireValid(intent.component == null || intent.component == component)
        return clean.setComponent(component)
    }
}
