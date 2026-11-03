package run.limeai.iot.television

import android.content.Context
import run.limeai.iot.device.*

internal data class ApkLocalHealthReview(val requestId: String, val health: ApkLocalHealth)
internal data class ApkPackageRecoveryReview(val requestId: String, val fromPhase: ApkInstallPhase, val sessionId: Int, val health: ApkLocalHealth)

/** 本机只读健康检查；不打开Socket、不启动应用、不修复或改写身份/授权/原命令。 */
internal class AndroidApkHealth(private val context: Context, private val store: AndroidAgentStore) {
    fun inspect(plan: ApkInstallPlan): ApkLocalHealth {
        val installed = AndroidInstalledApk(context)
        installed.verifyRunningCandidate(plan)
        val original = store.apkContinuity().also { it.verify(plan) }
        // 普通load/tls要求证书当前有效，并通过原持钥解析器核对实际私钥句柄。
        val enrollment = store.load() ?: throw DeviceFault("apk_install_health_identity_unavailable")
        if (enrollment.binding != plan.binding) throw DeviceFault("apk_install_continuity_changed")
        val tls = enrollment.tls().also { it.requireCurrent() }
        val applications = AndroidApplications.discover(context)
        val actual = installed.verifyRunningCandidate(plan)
        if (store.apkContinuity() != original) throw DeviceFault("apk_install_continuity_changed")
        tls.requireCurrent()
        return ApkLocalHealth(plan.digest, actual.sha256, actual.bytes, actual.signer, BuildConfig.VERSION_CODE.toLong(),
            original.digest, enrollment.certificateFingerprint, applications.size)
    }
}
