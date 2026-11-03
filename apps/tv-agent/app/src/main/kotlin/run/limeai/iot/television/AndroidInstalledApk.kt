package run.limeai.iot.television

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import android.os.Process
import run.limeai.iot.device.ApkInstallJournal
import run.limeai.iot.device.ApkInstallPlan
import run.limeai.iot.device.DeviceFault
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.security.cert.CertificateFactory

/** 只核对系统已安装的自身基础包，不读取外部导入路径，也不产生安装授权。 */
internal class AndroidInstalledApk(private val context: Context) {
    internal data class Baseline(val version: Long, val sha256: String, val signer: String, val bytes: Long)
    private data class Installed(val source: String, val version: Long, val signer: String, val uid: Int)
    private data class FileState(val canonical: String, val length: Long, val modified: Long)

    fun verifyBaseline(plan: ApkInstallPlan) {
        inspect(plan.baselineVersion, plan.baselineSha256, plan.signerSha256)
    }
    fun readBaseline(): Baseline = inspect()
    fun signerSha256(): String = installed().signer

    /** 编译版本与当前进程加载路径同时锚定；仅修改PM事实不能让旧代码接受新包。 */
    fun verifyRunningCandidate(plan: ApkInstallPlan): Baseline {
        try {
            requireRunningCandidate(plan)
            val actual = inspect(plan.candidateVersion, plan.candidateSha256, plan.signerSha256)
            requireRunningCandidate(plan)
            if (actual.bytes != plan.candidateBytes) throw DeviceFault("apk_install_health_mismatch")
            return actual
        } catch (fault: DeviceFault) { throw fault }
        catch (_: Exception) { throw DeviceFault("apk_install_health_unavailable") }
    }

    private fun requireRunningCandidate(plan: ApkInstallPlan) {
        val info = installed()
        val loaded = context.applicationInfo
        val source = File(info.source).canonicalPath
        if (BuildConfig.VERSION_CODE.toLong() != plan.candidateVersion || loaded.packageName != ApkInstallJournal.PACKAGE ||
            loaded.uid != Process.myUid() || !loaded.splitSourceDirs.isNullOrEmpty() || !loaded.splitPublicSourceDirs.isNullOrEmpty() ||
            loaded.sourceDir == null || File(loaded.sourceDir).canonicalPath != source || File(context.packageCodePath).canonicalPath != source)
            throw DeviceFault("apk_install_health_process_mismatch")
    }

    private fun inspect(version: Long? = null, sha256: String? = null, signer: String? = null): Baseline {
        try {
            val before = installed()
            if (version != null) requireBaseline(before.version == version && before.signer == signer)
            val file = File(before.source)
            val state = fileState(file)
            val hash = MessageDigest.getInstance("SHA-256")
            FileInputStream(file).use { input ->
                requireBaseline(input.channel.size() == state.length)
                val block = ByteArray(65536)
                var size = 0L
                while (true) {
                    val count = input.read(block)
                    if (count < 0) break
                    requireBaseline(count > 0)
                    size += count
                    requireBaseline(size <= state.length)
                    hash.update(block, 0, count)
                }
                requireBaseline(size == state.length && input.channel.size() == state.length)
            }
            val digest = fingerprint(hash.digest())
            if (sha256 != null) requireBaseline(digest == sha256)
            // 安装路径由PackageManager提供并受系统保护；不宣称对抗root或被篡改系统。
            requireBaseline(fileState(file) == state && installed() == before)
            return Baseline(before.version, digest, before.signer, state.length)
        } catch (fault: DeviceFault) {
            throw fault
        } catch (_: Exception) {
            throw DeviceFault("apk_install_baseline_unavailable")
        }
    }

    @Suppress("DEPRECATION") // API23–27只能使用GET_SIGNATURES，现代签名信息缺失时不回退。
    private fun installed(): Installed {
        requireBaseline(context.packageName == ApkInstallJournal.PACKAGE)
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val info = context.packageManager.getPackageInfo(ApkInstallJournal.PACKAGE, flags)
        val app = info.applicationInfo ?: throw DeviceFault("apk_install_baseline_mismatch")
        requireBaseline(info.packageName == ApkInstallJournal.PACKAGE && app.packageName == ApkInstallJournal.PACKAGE && app.uid == Process.myUid())
        requireBaseline(info.sharedUserId == null && info.splitNames.isNullOrEmpty() && app.splitSourceDirs.isNullOrEmpty() && app.splitPublicSourceDirs.isNullOrEmpty())
        val version = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
        requireBaseline(version in 1..2147483647L)
        val source = app.sourceDir ?: throw DeviceFault("apk_install_baseline_mismatch")
        requireBaseline(File(source).isAbsolute)
        return Installed(source, version, signer(info), app.uid)
    }

    @Suppress("DEPRECATION")
    private fun signer(info: PackageInfo): String {
        val signatures: Array<Signature>
        if (Build.VERSION.SDK_INT >= 28) {
            val signing = info.signingInfo ?: throw DeviceFault("apk_install_baseline_mismatch")
            requireBaseline(!signing.hasMultipleSigners() && !signing.hasPastSigningCertificates())
            signatures = signing.apkContentsSigners ?: throw DeviceFault("apk_install_baseline_mismatch")
            val history = signing.signingCertificateHistory
            requireBaseline(signatures.size == 1 && history?.size == 1 && signatures.single() == history.single())
        } else {
            signatures = info.signatures ?: throw DeviceFault("apk_install_baseline_mismatch")
            requireBaseline(signatures.size == 1)
        }
        val bytes = signatures.single().toByteArray()
        requireBaseline(bytes.size in 1..65536)
        val input = ByteArrayInputStream(bytes)
        val certificate = CertificateFactory.getInstance("X.509").generateCertificate(input)
        requireBaseline(input.available() == 0 && certificate.encoded.contentEquals(bytes))
        return fingerprint(MessageDigest.getInstance("SHA-256").digest(bytes))
    }

    private fun fileState(file: File): FileState {
        requireBaseline(file.isFile && file.length() in 1..268435456L)
        return FileState(file.canonicalPath, file.length(), file.lastModified())
    }

    private fun requireBaseline(valid: Boolean) {
        if (!valid) throw DeviceFault("apk_install_baseline_mismatch")
    }
    private fun fingerprint(digest: ByteArray) = "sha256:" + digest.joinToString("") { "%02x".format(it.toInt() and 255) }
}
