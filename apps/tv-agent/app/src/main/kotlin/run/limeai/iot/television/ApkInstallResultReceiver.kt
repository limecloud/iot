package run.limeai.iot.television

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import run.limeai.iot.device.*
import kotlin.concurrent.withLock
import java.util.concurrent.Executors

/** 仅由显式可变PendingIntent送达；不导出、不自动启动系统确认、不存确认Intent。 */
class ApkInstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        executor.execute {
            try { accept(context.applicationContext, intent) }
            catch (_: Exception) { /* 保留原任务；数据库异常不能改成安装失败或重新提交。 */ }
            finally { pending.finish() }
        }
    }
    companion object {
        private val executor = Executors.newSingleThreadExecutor { Thread(it, "tv-apk-result") }

        internal fun accept(context: Context, intent: Intent): ApkInstallRecord = ApkInstallOwner.lock.withLock {
            val data = intent.data
            val path = data?.pathSegments ?: emptyList()
            if (intent.component != ComponentName(context, ApkInstallResultReceiver::class.java) || intent.action != AndroidApkInstaller.RESULT_ACTION || data?.scheme != "limeiot-apk" || data.authority != "result" ||
                data.query != null || data.fragment != null || path.size != 3) throw DeviceFault("apk_install_result_mismatch")
            val sessionId = path[2].toIntOrNull()?.takeIf { it > 0 && it.toString() == path[2] }
                ?: throw DeviceFault("apk_install_result_mismatch")
            if (!intent.hasExtra(PackageInstaller.EXTRA_SESSION_ID) || intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1) != sessionId)
                throw DeviceFault("apk_install_result_mismatch")
            if (intent.hasExtra(PackageInstaller.EXTRA_PACKAGE_NAME) && intent.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME) != ApkInstallJournal.PACKAGE)
                throw DeviceFault("apk_install_result_mismatch")
            val result = when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Int.MIN_VALUE)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> ApkSystemResult.PENDING_USER_ACTION
                PackageInstaller.STATUS_SUCCESS -> ApkSystemResult.INSTALLED
                PackageInstaller.STATUS_FAILURE_ABORTED -> ApkSystemResult.CANCELLED
                PackageInstaller.STATUS_FAILURE, PackageInstaller.STATUS_FAILURE_BLOCKED, PackageInstaller.STATUS_FAILURE_CONFLICT,
                PackageInstaller.STATUS_FAILURE_INCOMPATIBLE, PackageInstaller.STATUS_FAILURE_INVALID, PackageInstaller.STATUS_FAILURE_STORAGE -> ApkSystemResult.FAILED
                else -> if (android.os.Build.VERSION.SDK_INT >= 34 && intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Int.MIN_VALUE) == PackageInstaller.STATUS_FAILURE_TIMEOUT)
                    ApkSystemResult.FAILED else throw DeviceFault("apk_install_result_mismatch")
            }
            AndroidApkInstallStore(context).use { storage ->
                val journal = ApkInstallJournal(storage)
                val original = journal.snapshot().singleOrNull { it.plan.requestId == path[0] }
                    ?: throw DeviceFault("apk_install_not_found")
                if (original.plan.digest != path[1]) throw DeviceFault("apk_install_result_mismatch")
                // Intent.EXTRA_INTENT只属于系统临时交互，不能导入为持久授权或在后台自动启动。
                journal.systemResult(original.plan.requestId, sessionId, result).also {
                    ApkInstallConfirmations.received(context, it, intent)
                }
            }
        }
    }
}
