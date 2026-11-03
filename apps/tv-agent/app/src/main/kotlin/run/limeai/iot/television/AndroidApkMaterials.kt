package run.limeai.iot.television

import android.content.Context
import android.os.Build
import run.limeai.iot.device.*
import java.io.File
import java.io.FileInputStream

internal data class ApkUpdateReview(
    val requestId: String, val preflightDigest: String, val baselineVersion: Long, val candidateVersion: Long,
    val candidateBytes: Long, val candidateSha256: String, val signerSha256: String, val debug: Boolean,
    val addedPermissions: List<String>, val removedPermissions: List<String>,
)

/** 签名预检、实际候选和系统自身包事实的组合；不从自报JSON或外部证书取得信任。 */
internal class AndroidApkMaterials private constructor(
    private val context: Context,
    private val bundle: File,
    private val candidate: File,
    private val allowDebug: Boolean,
    private val preflight: VerifiedApkPreflight,
) {
    private data class Stamp(val path: String, val length: Long, val modified: Long)
    private val bundleStamp = stamp(bundle)
    private val candidateStamp = stamp(candidate)

    fun review(requestId: String) = ApkUpdateReview(requestId, preflight.digest, preflight.baseline.version,
        preflight.candidate.version, preflight.candidateBytes, preflight.candidate.sha256, preflight.candidate.signer,
        preflight.candidate.debug, preflight.addedPermissions, preflight.baseline.permissions - preflight.candidate.permissions.toSet())

    fun plan(requestId: String, continuity: ApkContinuitySnapshot): ApkInstallPlan =
        preflight.plan(requestId, continuity.binding, continuity.digest)

    fun verifyCurrent(plan: ApkInstallPlan) {
        preflight.verifyPlan(plan)
        preflight.verifyTarget(Build.VERSION.SDK_INT, Build.SUPPORTED_ABIS.toList(), allowDebug)
        requireMaterials(stamp(bundle) == bundleStamp && stamp(candidate) == candidateStamp)
    }

    fun verifyBoundary(plan: ApkInstallPlan) {
        verifyCurrent(plan)
        val actual = VerifiedApkPreflight.read(bundle, AndroidInstalledApk(context).signerSha256())
        requireMaterials(actual.digest == preflight.digest)
        actual.verifyPlan(plan)
        actual.verifyCandidate(candidate)
        verifyCurrent(plan)
    }

    fun openCandidate(plan: ApkInstallPlan): FileInputStream { verifyCurrent(plan); return FileInputStream(candidate) }

    companion object {
        fun read(context: Context, bundle: File, candidate: File, allowDebug: Boolean): AndroidApkMaterials {
            val current = AndroidInstalledApk(context).readBaseline()
            val preflight = VerifiedApkPreflight.read(bundle, current.signer)
            requireMaterials(preflight.baseline.version == current.version && preflight.baseline.sha256 == current.sha256 && preflight.baseline.signer == current.signer)
            preflight.verifyTarget(Build.VERSION.SDK_INT, Build.SUPPORTED_ABIS.toList(), allowDebug)
            preflight.verifyCandidate(candidate)
            return AndroidApkMaterials(context, bundle, candidate, allowDebug, preflight)
        }
        private fun stamp(file: File): Stamp {
            requireMaterials(file.isFile)
            return Stamp(file.canonicalPath, file.length(), file.lastModified())
        }
        private fun requireMaterials(valid: Boolean) { if (!valid) throw DeviceFault("apk_preflight_materials_changed") }
    }
}
