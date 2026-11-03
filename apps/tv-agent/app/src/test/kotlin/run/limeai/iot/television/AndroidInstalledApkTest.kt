package run.limeai.iot.television

import android.app.Application
import android.content.IntentSender
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.content.pm.SigningInfo
import android.os.Build
import android.os.Process
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
import run.limeai.iot.device.*
import java.io.ByteArrayInputStream
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import kotlin.test.*

/** PackageManager/签名为显式系统元数据夹具；基础包读自真实宿主文件，不代表实机。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, shadows = [AndroidInstalledApkTest.Packages::class])
@Suppress("DEPRECATION")
class AndroidInstalledApkTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val baseline = ByteArray(131073) { (it % 239).toByte() }
    private val candidate = byteArrayOf(7, 8, 9)
    private fun hash(bytes: ByteArray) = "sha256:" + MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun pin(c: Char) = "sha256:" + c.toString().repeat(64)
    private val certificate get() = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(Fixtures.enrollment.publicCertificate())).encoded
    private fun plan() = ApkInstallPlan("update-one", "space-demo/device-tv/${pin('a')}", hash(baseline), hash(candidate), hash(certificate), 3, 4, candidate.size.toLong(), pin('d'), pin('e'))

    @Implements(className = "android.app.ApplicationPackageManager", isInAndroidSdk = false)
    class Packages : ShadowApplicationPackageManager() {
        @Implementation override fun getPackageInfo(name: String, flags: Int): PackageInfo {
            if (name == ApkInstallJournal.PACKAGE && (flags == PackageManager.GET_SIGNATURES || flags == PackageManager.GET_SIGNING_CERTIFICATES) && current != null) {
                requested += flags
                onRead(requested.size)
                return current!!
            }
            return super.getPackageInfo(name, flags) ?: throw PackageManager.NameNotFoundException(name)
        }
        companion object {
            var current: PackageInfo? = null
            val requested = mutableListOf<Int>()
            var onRead: (Int) -> Unit = {}
        }
    }

    @Before fun reset() { Packages.current = null; Packages.requested.clear(); Packages.onRead = {} }

    private fun installed(): File {
        val file = Files.createTempFile("limeiot-installed-apk-", ".apk").toFile().apply { writeBytes(baseline) }
        Packages.current = PackageInfo().apply {
            packageName = ApkInstallJournal.PACKAGE; versionCode = 3
            applicationInfo = ApplicationInfo().apply {
                packageName = ApkInstallJournal.PACKAGE; uid = Process.myUid(); sourceDir = file.absolutePath
            }
            signatures = arrayOf(Signature(certificate))
            if (Build.VERSION.SDK_INT >= 28) signingInfo = SigningInfo().also { shadowOf(it).setSignatures(signatures) }
        }
        return file
    }
    private fun verify() = AndroidInstalledApk(context).verifyBaseline(plan())
    private fun rejected(code: String = "apk_install_baseline_mismatch") = assertEquals(code, assertFailsWith<DeviceFault> { verify() }.code)

    @Test @Config(sdk = [23, 28, 31])
    fun baseline_requires_current_system_version_unique_certificate_and_whole_file_digest() {
        installed(); verify()
        val flag = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        assertEquals(listOf(flag, flag), Packages.requested)
    }

    @Test fun wrong_package_uid_shared_or_split_metadata_is_rejected() {
        val mutations = listOf<(PackageInfo) -> Unit>(
            { it.packageName = "example.other" }, { it.applicationInfo!!.packageName = "example.other" },
            { it.applicationInfo!!.uid = Process.myUid() + 1 }, { it.sharedUserId = "shared" },
            { it.splitNames = arrayOf("feature") }, { it.applicationInfo!!.splitSourceDirs = arrayOf("/split.apk") },
            { it.applicationInfo!!.splitPublicSourceDirs = arrayOf("/split.apk") }, { it.applicationInfo = null },
            { it.applicationInfo!!.sourceDir = null }, { it.applicationInfo!!.sourceDir = "relative.apk" },
        )
        for (mutate in mutations) { installed(); mutate(Packages.current!!); rejected() }
    }

    @Test @Config(sdk = [23, 28])
    fun zero_negative_and_changed_versions_are_rejected_without_low_word_comparison() {
        for (version in listOf(0, -1, 2, 4)) {
            installed(); Packages.current!!.versionCode = version; rejected()
        }
        if (Build.VERSION.SDK_INT >= 28) {
            installed(); Packages.current!!.longVersionCode = (1L shl 32) + 3; rejected()
        }
    }

    @Test @Config(sdk = [23, 28])
    fun missing_multiple_malformed_and_wrong_certificate_signers_are_rejected() {
        for (signatures in listOf(null, emptyArray(), arrayOf(Signature(certificate), Signature(certificate)), arrayOf(Signature(byteArrayOf(1))), arrayOf(Signature(certificate + 0.toByte())))) {
            installed()
            Packages.current!!.signatures = signatures
            if (Build.VERSION.SDK_INT >= 28) shadowOf(Packages.current!!.signingInfo!!).setSignatures(signatures)
            assertFailsWith<DeviceFault> { verify() }
        }
        installed()
        assertEquals("apk_install_baseline_mismatch", assertFailsWith<DeviceFault> { AndroidInstalledApk(context).verifyBaseline(plan().copy(signerSha256 = pin('f'))) }.code)
    }

    @Test fun modern_signing_information_does_not_fall_back_or_accept_a_rotation_history() {
        installed(); Packages.current!!.signingInfo = null; rejected()
        installed()
        shadowOf(Packages.current!!.signingInfo!!).setPastSigningCertificates(arrayOf(Signature(certificate)))
        rejected()
    }

    @Test fun actual_file_missing_empty_directory_oversize_or_same_length_corruption_is_rejected() {
        val file = installed(); file.writeBytes(baseline.copyOf().apply { this[65536] = 99 }); rejected()
        installed().writeBytes(byteArrayOf()); rejected()
        installed(); Packages.current!!.applicationInfo!!.sourceDir = Files.createTempDirectory("limeiot-installed-directory-").toString(); rejected()
        installed(); Packages.current!!.applicationInfo!!.sourceDir += ".missing"; rejected()
        val oversized = installed(); RandomAccessFile(oversized, "rw").use { it.setLength(268435457L) }; rejected()
    }

    @Test fun package_source_version_or_signer_drift_during_read_is_rejected() {
        val mutations = listOf<(PackageInfo) -> Unit>(
            { it.versionCode = 4 }, { it.applicationInfo!!.sourceDir += ".replaced" },
            { it.applicationInfo!!.uid += 1 }, { it.signingInfo = null }, { it.splitNames = arrayOf("late") },
        )
        for (mutate in mutations) {
            installed(); Packages.requested.clear()
            Packages.onRead = { if (it == 2) mutate(Packages.current!!) }
            rejected()
        }
    }

    @Test fun package_manager_failure_is_unavailable_and_never_returns_a_match() {
        installed(); Packages.onRead = { throw PackageManager.NameNotFoundException() }
        rejected("apk_install_baseline_unavailable")
    }

    @Test fun default_provider_scans_baseline_at_boundaries_and_unknown_lookup_remains_read_only() {
        shadowOf(context.packageManager).setCanRequestPackageInstalls(true)
        installed(); val p = plan()
        val storage = object : ApkInstallStorage {
            var bytes: ByteArray? = null
            override fun read() = bytes?.copyOf()
            override fun compareAndSet(expected: ByteArray?, updated: ByteArray): Boolean {
                if (!(bytes?.contentEquals(expected ?: byteArrayOf()) ?: (expected == null))) return false
                bytes = updated.copyOf(); return true
            }
        }
        val journal = ApkInstallJournal(storage); journal.prepare(p)
        var creates = 0; var commits = 0
        val sessions = object : ApkSessionApi {
            override fun create(plan: ApkInstallPlan): Int { creates++; return 17 }
            override fun ownSessions() = listOf(ApkSessionClaim(17, p.digest, ApkInstallJournal.PACKAGE, p.candidateBytes))
            override fun open(sessionId: Int) = object : ApkSessionIo {
                override fun names() = listOf(AndroidApkSessions.BASE_APK)
                override fun write(length: Long) = error("existing session is read only")
                override fun fsync(output: java.io.OutputStream) = error("no rewrite")
                override fun read() = ByteArrayInputStream(candidate)
                override fun commit(receiver: IntentSender) { commits++ }
                override fun close() {}
            }
        }
        val provider = AndroidApkInstaller(context, journal, {}, sessions)
        provider.create(p.requestId); provider.stage(p.requestId) { error("read existing bytes") }; provider.commit(p.requestId)
        // 创建2、暂存2、提交4次整包核对，各读取两次系统包信息；逐块资格检查不扫描基线。
        assertEquals(16, Packages.requested.size); assertEquals(1, creates); assertEquals(1, commits)
        Packages.onRead = { fail("unknown queries cannot rescan baseline") }
        assertEquals(ApkInstallPhase.COMMITTING, provider.commit(p.requestId).phase)
        assertEquals(ApkInstallPhase.COMMITTING, provider.create(p.requestId).phase)
        for (result in listOf(ApkSystemResult.PENDING_USER_ACTION, ApkSystemResult.INSTALLED)) {
            journal.systemResult(p.requestId, 17, result)
            provider.commit(p.requestId)
        }
        assertEquals(1, creates); assertEquals(1, commits)
    }
}
