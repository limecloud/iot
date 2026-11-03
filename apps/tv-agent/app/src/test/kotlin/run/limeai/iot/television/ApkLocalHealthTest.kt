package run.limeai.iot.television

import android.app.Activity
import android.app.AlertDialog
import android.app.Application
import android.content.ContextWrapper
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.Signature
import android.content.pm.SigningInfo
import android.os.Build
import android.os.Looper
import android.os.Process
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import kotlinx.serialization.json.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.SQLiteMode
import org.robolectric.shadows.ShadowAlertDialog
import org.robolectric.shadows.ShadowPackageInstaller
import org.robolectric.shadow.api.Shadow
import org.robolectric.util.ReflectionHelpers
import run.limeai.iot.device.*
import java.io.File
import java.nio.file.Files
import java.security.KeyFactory
import java.security.cert.CertificateFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.withLock
import kotlin.test.*

/** 实际宿主文件/SQLite/持钥签名与Runtime；已装包、进程路径及版本是明确夹具，不是包替换证据。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [23, 28], application = Application::class, shadows = [AndroidInstalledApkTest.Packages::class, ApkLocalHealthTest.Sessions::class])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class ApkLocalHealthTest {
    @Implements(PackageInstaller::class)
    class Sessions : ShadowPackageInstaller() {
        @Implementation override fun getMySessions(): List<PackageInstaller.SessionInfo> {
            queries++; onQuery(queries)
            check(!unavailable) { "fixture session query unavailable" }
            return if (oversized) List(129) { Shadow.newInstanceOf(PackageInstaller.SessionInfo::class.java) } else super.getMySessions()
        }
        @Implementation override fun createSession(params: PackageInstaller.SessionParams): Int { creates++; return super.createSession(params) }
        @Implementation override fun openSession(sessionId: Int): PackageInstaller.Session { opens++; error("本机恢复不能打开系统安装会话") }
        companion object {
            var queries = 0; var creates = 0; var opens = 0; var unavailable = false; var oversized = false
            var onQuery: (Int) -> Unit = {}
            fun reset() { queries = 0; creates = 0; opens = 0; unavailable = false; oversized = false; onQuery = {} }
        }
    }
    private val base get() = RuntimeEnvironment.getApplication()
    private lateinit var candidate: File
    private lateinit var baseline: File
    private lateinit var runtime: AgentRuntime
    private lateinit var plan: ApkInstallPlan
    private var loadedSource = ""
    private var codePath = ""
    private var connections = 0
    private var keyReference: String? = null
    private var keyPresent = false
    private var creates = 0
    private val enrollment get() = Fixtures.enrollment
    private val publicKey get() = CertificateFactory.getInstance("X.509").generateCertificate(enrollment.publicCertificate().inputStream()).publicKey
    private val keys = object : IdentityKeys, IdentityKeyRetirement {
        override fun create(reference: String): DeviceSigningKey { creates++; keyReference = reference; keyPresent = true; return load(reference) }
        override fun load(reference: String): DeviceSigningKey {
            if (!contains(reference)) throw AgentStoreFault("identity_key_unavailable")
            val pem = DeviceDocument.parse(enrollment.encoded()).getValue("private_key_pem").jsonPrimitive.content
            val der = Base64.getMimeDecoder().decode(pem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", ""))
            return DeviceSigningKey.from(KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(der)), publicKey)
        }
        override fun contains(reference: String) = keyPresent && keyReference == reference
        override fun retire(reference: String, expectedPublicKey: String) = error("健康检查不能删除键")
    }
    private val vault = object : EnrollmentVault {
        override fun seal(bytes: ByteArray, binding: String) = bytes.copyOf()
        override fun open(bytes: ByteArray, binding: String) = bytes.copyOf()
    }
    private fun store() = AndroidAgentStore(base, vault, keys)
    private val context by lazy { object : ContextWrapper(base) {
        override fun getPackageCodePath() = codePath
        override fun getApplicationInfo() = ApplicationInfo(base.applicationInfo).apply {
            sourceDir = loadedSource; uid = Process.myUid(); packageName = ApkInstallJournal.PACKAGE
        }
    } }
    private fun hash(bytes: ByteArray) = ApkPreflightFixture.hash(bytes)
    private fun record() = ApkInstallOwner.lock.withLock { AndroidApkInstallStore(base).use { ApkInstallJournal(it).snapshot().single() } }
    private fun bytes() = ApkInstallOwner.lock.withLock { AndroidApkInstallStore(base).use { it.read()!! } }
    private fun success() { AndroidApkInstallStore(base).use { ApkInstallJournal(it).systemResult(plan.requestId, 17, ApkSystemResult.INSTALLED) } }
    private fun fault(code: String, result: Result<*>) = assertEquals(code, (result.exceptionOrNull() as DeviceFault).code)
    private fun pump(condition: () -> Boolean) {
        val deadline = System.nanoTime() + 2_000_000_000L
        while (!condition() && System.nanoTime() < deadline) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(5) }
        shadowOf(Looper.getMainLooper()).idle(); assertTrue(condition(), "结果未在原2秒观察预算内到达")
    }
    private fun <T> await(action: ((Result<T>) -> Unit) -> Unit): Result<T> {
        val result = AtomicReference<Result<T>?>(null); action { result.set(it) }; pump { result.get() != null }; return result.get()!!
    }
    private fun preview(permit: RunPermit = RunPermit()) = await<ApkLocalHealthReview> { runtime.previewApkHealth(plan.requestId, permit, it) }
    private fun accept(review: ApkLocalHealthReview, permit: RunPermit = RunPermit()) = await<ApkInstallRecord> { runtime.acceptApkHealth(review, permit, it) }
    private fun previewRecovery(permit: RunPermit = RunPermit()) = await<ApkPackageRecoveryReview> { runtime.previewApkPackageRecovery(plan.requestId, permit, it) }
    private fun recover(review: ApkPackageRecoveryReview, permit: RunPermit = RunPermit()) = await<ApkInstallRecord> { runtime.acceptApkPackageRecovery(review, permit, it) }
    private fun rawSession(): Int {
        val installer = base.packageManager.packageInstaller
        val id = installer.createSession(PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(ApkInstallJournal.PACKAGE); setAppLabel("unrecognized-original-label")
        })
        ReflectionHelpers.setField(installer.getSessionInfo(id)!!, "installerPackageName", ApkInstallJournal.PACKAGE)
        return id
    }
    private fun pending() { AndroidApkInstallStore(base).use { ApkInstallJournal(it).systemResult(plan.requestId, 17, ApkSystemResult.PENDING_USER_ACTION) } }
    private fun lateResult(status: Int): ApkInstallRecord = ApkInstallResultReceiver.accept(base,
        AndroidApkInstaller.resultIntent(base, record()).putExtra(PackageInstaller.EXTRA_SESSION_ID, 17).putExtra(PackageInstaller.EXTRA_STATUS, status))

    @Before fun setup() {
        Sessions.reset()
        AndroidInstalledApkTest.Packages.requested.clear(); AndroidInstalledApkTest.Packages.onRead = {}
        baseline = Files.createTempFile("limeiot-health-baseline-", ".apk").toFile().apply { writeBytes(byteArrayOf(1, 2, 3)) }
        candidate = Files.createTempFile("limeiot-health-candidate-", ".apk").toFile().apply { writeBytes(byteArrayOf(4, 5, 6, 7)) }
        loadedSource = candidate.path; codePath = candidate.path
        val certificate = CertificateFactory.getInstance("X.509").generateCertificate(enrollment.publicCertificate().inputStream()).encoded
        @Suppress("DEPRECATION")
        val info = PackageInfo().apply {
            packageName = ApkInstallJournal.PACKAGE; versionCode = BuildConfig.VERSION_CODE
            applicationInfo = ApplicationInfo().apply { packageName = ApkInstallJournal.PACKAGE; uid = Process.myUid(); sourceDir = candidate.path }
            signatures = arrayOf(Signature(certificate))
            if (Build.VERSION.SDK_INT >= 28) signingInfo = SigningInfo().also { shadowOf(it).setSignatures(signatures) }
        }
        AndroidInstalledApkTest.Packages.current = info
        val snapshot = store().use {
            val request = it.requestIdentity(enrollment.setupForRequest("health-identity")).request!!
            assertTrue(request.pem.contains("CERTIFICATE REQUEST"))
            it.activateIdentity(it.previewCertificate(enrollment.publicCertificate()))
            it.authorize("com.example.player", true)
            it.journal(enrollment.binding).commit(ApkJournalFixture.bytes(enrollment.identity))
            it.apkContinuity()
        }
        plan = ApkInstallPlan("update-health", snapshot.binding, hash(baseline.readBytes()), hash(candidate.readBytes()), hash(certificate),
            (BuildConfig.VERSION_CODE - 1).toLong(), BuildConfig.VERSION_CODE.toLong(), candidate.length(), snapshot.digest, "sha256:" + "e".repeat(64))
        AndroidApkInstallStore(base).use { storage ->
            val journal = ApkInstallJournal(storage); journal.prepare(plan); journal.createSession(plan.requestId, {}, { 17 })
            journal.staged(plan.requestId, 17, plan.candidateSha256, plan.candidateBytes); journal.commit(plan.requestId, {}, { _, _ -> })
        }
        runtime = AgentRuntime(context, ::store) { connections++; error("本机健康检查不能连接") }; runtime.setVisible(true)
        // 与既有连续性测试一致：先完成该实例的SQLite打开/配置，再观察健康检查的零改写。
        await<ApkContinuitySnapshot> { runtime.readApkContinuity(it) }.getOrThrow()
    }

    @Test fun preview_is_read_only_and_explicit_acceptance_survives_sqlite_reopen_without_connecting_or_replaying() {
        success(); val original = bytes(); val identityDb = base.getDatabasePath("tv-agent.db").readBytes()
        val review = preview().getOrThrow()
        assertEquals(plan.candidateSha256, review.health.installedSha256); assertEquals(plan.continuityDigest, review.health.continuityDigest)
        assertContentEquals(original, bytes()); assertTrue(record().blocksAnotherInstall)
        var finished = false; runtime.start { finished = true }; assertTrue(finished); assertFalse(runtime.running); assertEquals(0, connections)
        val accepted = accept(review).getOrThrow()
        assertEquals(ApkInstallPhase.LOCAL_HEALTH_ACCEPTED, accepted.phase); assertFalse(record().blocksAnotherInstall)
        assertEquals(review.health, record().localHealth); assertEquals(17, record().sessionId)
        val durable = bytes(); assertEquals(accepted, accept(review).getOrThrow()); assertContentEquals(durable, bytes())
        assertContentEquals(identityDb, base.getDatabasePath("tv-agent.db").readBytes())
        store().use { assertContentEquals(ApkJournalFixture.bytes(enrollment.identity), it.journal(enrollment.binding).read()); assertEquals(setOf("com.example.player"), it.allowed()) }
        assertEquals(1, creates); assertEquals(0, connections); assertFalse(runtime.running)
        assertNull(shadowOf(base).nextStartedActivity); assertTrue(base.packageManager.packageInstaller.mySessions.isEmpty())
    }

    @Test fun system_success_is_required_and_no_phase_or_material_absence_is_treated_as_success() {
        val before = bytes()
        fault("apk_install_health_not_ready", preview())
        assertContentEquals(before, bytes()); assertEquals(ApkInstallPhase.COMMITTING, record().phase)
        success(); assertTrue(AndroidApkImports(base).entries().isEmpty())
        assertEquals(ApkInstallPhase.LOCAL_HEALTH_ACCEPTED, accept(preview().getOrThrow()).getOrThrow().phase)
    }

    @Test fun installed_facts_require_candidate_bytes_size_signer_and_new_process_code_and_loaded_paths() {
        success(); val before = bytes()
        val installed = AndroidInstalledApk(context)
        val info = AndroidInstalledApkTest.Packages.current!!
        loadedSource = baseline.path
        fault("apk_install_health_process_mismatch", preview()); loadedSource = candidate.path
        codePath = baseline.path
        fault("apk_install_health_process_mismatch", preview()); codePath = candidate.path
        @Suppress("DEPRECATION")
        run {
            info.versionCode = BuildConfig.VERSION_CODE + 1
            assertEquals("apk_install_health_process_mismatch", assertFailsWith<DeviceFault> {
                installed.verifyRunningCandidate(plan.copy(candidateVersion = (BuildConfig.VERSION_CODE + 1).toLong()))
            }.code)
            info.versionCode = BuildConfig.VERSION_CODE
        }
        candidate.writeBytes(byteArrayOf(4, 5, 6, 8)); fault("apk_install_baseline_mismatch", preview())
        candidate.writeBytes(byteArrayOf(4, 5, 6, 7))
        assertEquals("apk_install_health_mismatch", assertFailsWith<DeviceFault> { installed.verifyRunningCandidate(plan.copy(candidateBytes = 5)) }.code)
        assertEquals("apk_install_baseline_mismatch", assertFailsWith<DeviceFault> { installed.verifyRunningCandidate(plan.copy(signerSha256 = "sha256:" + "0".repeat(64))) }.code)
        assertContentEquals(before, bytes()); assertTrue(record().blocksAnotherInstall)
    }

    @Test fun acceptance_rechecks_actual_package_and_exact_original_grants_and_journal_after_preview() {
        success(); val review = preview().getOrThrow(); val before = bytes()
        candidate.writeBytes(byteArrayOf(4, 5, 6, 8)); fault("apk_install_baseline_mismatch", accept(review))
        candidate.writeBytes(byteArrayOf(4, 5, 6, 7))
        store().use { it.authorize("com.example.other", true) }; fault("apk_install_continuity_changed", accept(review))
        store().use { it.authorize("com.example.other", false); it.journal(enrollment.binding).commit(" ".toByteArray() + ApkJournalFixture.bytes(enrollment.identity)) }
        fault("apk_install_continuity_changed", accept(review))
        assertContentEquals(before, bytes()); assertTrue(record().blocksAnotherInstall); assertEquals(0, connections)
    }

    @Test fun missing_current_key_is_never_recreated_or_accepted() {
        success(); val review = preview().getOrThrow(); val before = bytes(); keyPresent = false
        val rejected = accept(review)
        assertEquals("invalid_enrollment", (rejected.exceptionOrNull() as DeviceFault).code)
        assertContentEquals(before, bytes()); assertEquals(1, creates); assertFalse(keyPresent); assertTrue(record().blocksAnotherInstall)
    }

    @Test fun stale_foreground_permit_cannot_borrow_later_visibility_or_a_queued_acceptance() {
        success(); val review = preview().getOrThrow(); val before = bytes()
        val old = RunPermit(); old.stop(); runtime.setVisible(false); runtime.setVisible(true)
        fault("apk_install_visible_approval_required", accept(review, old))
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val queue = ReflectionHelpers.getField<ExecutorService>(runtime, "io")
        queue.execute { entered.countDown(); check(release.await(2, TimeUnit.SECONDS)) }
        assertTrue(entered.await(2, TimeUnit.SECONDS))
        val permit = RunPermit(); val result = AtomicReference<Result<ApkInstallRecord>?>(null)
        runtime.acceptApkHealth(review, permit) { result.set(it) }
        permit.stop(); runtime.setVisible(false); runtime.setVisible(true); release.countDown()
        pump { result.get() != null }; fault("apk_install_visible_approval_required", result.get()!!)
        assertContentEquals(before, bytes()); assertTrue(record().blocksAnotherInstall)
    }

    @Test fun loss_of_foreground_during_full_scan_or_worker_not_yet_exited_preserves_block() {
        success(); val review = preview().getOrThrow(); val before = bytes(); val permit = RunPermit()
        AndroidInstalledApkTest.Packages.onRead = { permit.stop() }
        fault("apk_install_visible_approval_required", accept(review, permit))
        AndroidInstalledApkTest.Packages.onRead = { fail("尚未退出的worker不能开始健康扫描") }
        ReflectionHelpers.setField(runtime, "permit", RunPermit().apply { stop() })
        try { fault("apk_install_stop_required", preview()) }
        finally { ReflectionHelpers.setField(runtime, "permit", null); AndroidInstalledApkTest.Packages.onRead = {} }
        assertContentEquals(before, bytes()); assertTrue(record().blocksAnotherInstall)
    }

    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun button(activity: Activity, text: String) = views(activity.window.decorView).filterIsInstance<Button>().singleOrNull { it.text.toString() == text }

    @Test @Config(application = TelevisionApplication::class)
    fun visible_health_dialog_requires_current_review_and_explicit_acceptance_without_automatic_connection() {
        success(); ReflectionHelpers.setField(base, "runtime\$delegate", lazyOf(runtime))
        val controller = Robolectric.buildActivity(ApkUpdateActivity::class.java).setup(); val activity = controller.get()
        pump { button(activity, "核对更新后状态") != null }
        button(activity, "核对更新后状态")!!.performClick()
        pump { ShadowAlertDialog.getLatestAlertDialog()?.isShowing == true }
        val stale = ShadowAlertDialog.getLatestAlertDialog(); controller.pause().stop().start().resume().visible()
        stale.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        assertEquals(ApkInstallPhase.INSTALLED_UNVERIFIED, record().phase)
        button(activity, "核对更新后状态")!!.performClick()
        pump { ShadowAlertDialog.getLatestAlertDialog()?.isShowing == true }
        val current = ShadowAlertDialog.getLatestAlertDialog(); assertNotSame(stale, current)
        assertEquals("接受本机健康", current.getButton(AlertDialog.BUTTON_POSITIVE).text.toString())
        current.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        pump { !current.isShowing && button(activity, "核对更新后状态") == null }
        assertEquals(ApkInstallPhase.LOCAL_HEALTH_ACCEPTED, record().phase); assertEquals(0, connections); assertFalse(runtime.running)
        assertNull(shadowOf(activity).nextStartedActivity); controller.pause().stop().destroy()
    }

    @Test fun unknown_commit_requires_explicit_package_recovery_and_preserves_missing_system_result_origin() {
        val original = bytes(); val identityDb = base.getDatabasePath("tv-agent.db").readBytes()
        val review = previewRecovery().getOrThrow()
        assertEquals(ApkInstallPhase.COMMITTING, review.fromPhase); assertEquals(17, review.sessionId)
        assertContentEquals(original, bytes()); assertTrue(record().blocksAnotherInstall)
        fault("apk_install_health_not_ready", preview()) // 原系统成功路径没有被放宽。
        val recovered = recover(review).getOrThrow()
        assertEquals(ApkInstallPhase.LOCAL_PACKAGE_RECOVERED, recovered.phase)
        assertEquals(ApkInstallPhase.COMMITTING, recovered.recoveredFrom); assertNull(recovered.recoveryResult)
        assertEquals(review.health, recovered.localHealth); assertFalse(record().blocksAnotherInstall)
        val durable = bytes(); assertEquals(recovered, recover(review).getOrThrow()); assertContentEquals(durable, bytes())
        assertContentEquals(identityDb, base.getDatabasePath("tv-agent.db").readBytes())
        assertEquals(0, Sessions.creates); assertEquals(0, Sessions.opens); assertEquals(0, connections); assertFalse(runtime.running)
        assertNull(shadowOf(base).nextStartedActivity)
    }

    @Test fun pending_user_requires_unfiltered_owned_sessions_to_be_absent_even_if_labels_are_unrecognized() {
        pending(); val original = bytes(); val session = rawSession()
        assertTrue(AndroidApkSessions(context).ownSessions().isEmpty()) // 旧的过滤列表不能证明不存在原会话。
        fault("apk_install_recovery_sessions_present", previewRecovery())
        assertContentEquals(original, bytes()); assertTrue(record().blocksAnotherInstall)
        base.packageManager.packageInstaller.abandonSession(session) // 仅清理宿主会话夹具，产品恢复入口不调用此方法。
        val review = previewRecovery().getOrThrow(); assertEquals(ApkInstallPhase.PENDING_USER, review.fromPhase)
        assertContentEquals(original, bytes())
        val recovered = recover(review).getOrThrow()
        assertEquals(ApkInstallPhase.PENDING_USER, recovered.recoveredFrom); assertNull(recovered.recoveryResult)
        assertEquals(1, Sessions.creates); assertEquals(0, Sessions.opens); assertEquals(0, connections)
    }

    @Test fun unavailable_or_oversized_session_queries_do_not_become_an_empty_session_proof() {
        val original = bytes(); Sessions.unavailable = true
        fault("apk_install_recovery_sessions_unavailable", previewRecovery())
        Sessions.unavailable = false; Sessions.oversized = true
        fault("apk_install_recovery_sessions_unavailable", previewRecovery())
        Sessions.oversized = false
        assertContentEquals(original, bytes()); assertTrue(record().blocksAnotherInstall); assertEquals(0, Sessions.creates)
    }

    @Test fun recovery_rechecks_new_code_exact_candidate_original_grants_and_current_key() {
        val original = bytes()
        loadedSource = baseline.path; fault("apk_install_health_process_mismatch", previewRecovery()); loadedSource = candidate.path
        val review = previewRecovery().getOrThrow()
        candidate.writeBytes(byteArrayOf(4, 5, 6, 8)); fault("apk_install_baseline_mismatch", recover(review))
        candidate.writeBytes(byteArrayOf(4, 5, 6, 7))
        store().use { it.authorize("com.example.other", true) }; fault("apk_install_continuity_changed", recover(review))
        store().use { it.authorize("com.example.other", false) }
        keyPresent = false; fault("invalid_enrollment", recover(review))
        assertContentEquals(original, bytes()); assertTrue(record().blocksAnotherInstall)
        assertEquals(1, creates); assertEquals(0, Sessions.creates); assertEquals(0, Sessions.opens); assertEquals(0, connections)
    }

    @Test fun final_raw_session_query_after_full_recheck_prevents_a_racing_local_acceptance() {
        val review = previewRecovery().getOrThrow(); val original = bytes()
        Sessions.queries = 0; Sessions.onQuery = { if (it == 3) rawSession() }
        fault("apk_install_recovery_sessions_present", recover(review))
        assertEquals(3, Sessions.queries); assertEquals(1, Sessions.creates); assertEquals(0, Sessions.opens)
        assertContentEquals(original, bytes()); assertTrue(record().blocksAnotherInstall)
    }

    @Test fun a_new_pending_or_success_result_after_preview_requires_a_new_review_of_the_actual_phase() {
        val committing = previewRecovery().getOrThrow(); pending(); val pendingBytes = bytes()
        fault("apk_install_package_recovery_not_ready", recover(committing)); assertContentEquals(pendingBytes, bytes())
        val waiting = previewRecovery().getOrThrow(); success(); val installedBytes = bytes()
        fault("apk_install_package_recovery_not_ready", recover(waiting)); assertContentEquals(installedBytes, bytes())
        val accepted = accept(preview().getOrThrow()).getOrThrow()
        assertEquals(ApkInstallPhase.LOCAL_HEALTH_ACCEPTED, accepted.phase); assertNull(accepted.recoveredFrom)
    }

    @Test fun stale_foreground_or_leaving_during_candidate_scan_cannot_accept_package_recovery() {
        val review = previewRecovery().getOrThrow(); val original = bytes()
        val stale = RunPermit().apply { stop() }; runtime.setVisible(false); runtime.setVisible(true)
        fault("apk_install_visible_approval_required", recover(review, stale))
        val current = RunPermit(); AndroidInstalledApkTest.Packages.onRead = { current.stop() }
        fault("apk_install_visible_approval_required", recover(review, current)); AndroidInstalledApkTest.Packages.onRead = {}
        assertContentEquals(original, bytes()); assertTrue(record().blocksAnotherInstall)
        assertEquals(0, Sessions.creates); assertEquals(0, Sessions.opens); assertEquals(0, connections)
    }

    @Test fun private_late_result_persists_separately_after_recovery_without_reinstalling_or_connecting() {
        val recovered = recover(previewRecovery().getOrThrow()).getOrThrow()
        val failed = lateResult(PackageInstaller.STATUS_FAILURE)
        assertEquals(recovered.copy(recoveryResult = ApkSystemResult.FAILED), failed)
        assertEquals(failed, record()); val durable = bytes()
        assertEquals(failed, lateResult(PackageInstaller.STATUS_FAILURE)); assertContentEquals(durable, bytes())
        assertEquals("apk_install_result_conflict", assertFailsWith<DeviceFault> { lateResult(PackageInstaller.STATUS_SUCCESS) }.code)
        assertFalse(record().blocksAnotherInstall); assertEquals(0, Sessions.creates); assertEquals(0, Sessions.opens); assertEquals(0, connections)
        assertNull(shadowOf(base).nextStartedActivity)
    }

    @Test @Config(application = TelevisionApplication::class)
    fun visible_package_recovery_preserves_unknown_origin_and_requires_fresh_explicit_acceptance() {
        ReflectionHelpers.setField(base, "runtime\$delegate", lazyOf(runtime))
        val controller = Robolectric.buildActivity(ApkUpdateActivity::class.java).setup(); val activity = controller.get()
        pump { button(activity, "核对已运行候选包") != null }
        button(activity, "核对已运行候选包")!!.performClick()
        pump { ShadowAlertDialog.getLatestAlertDialog()?.isShowing == true }
        val cancelled = ShadowAlertDialog.getLatestAlertDialog(); cancelled.getButton(AlertDialog.BUTTON_NEGATIVE).performClick()
        // 系统按钮通过主队列关闭对话框，等原窗口真正关闭后再进行下一次用户点击。
        pump { !cancelled.isShowing && button(activity, "核对已运行候选包")?.isEnabled == true }
        assertEquals(ApkInstallPhase.COMMITTING, record().phase)
        button(activity, "核对已运行候选包")!!.performClick()
        pump { ShadowAlertDialog.getLatestAlertDialog()?.let { it !== cancelled && it.isShowing } == true }
        val stale = ShadowAlertDialog.getLatestAlertDialog(); controller.pause().stop().start().resume().visible()
        stale.getButton(AlertDialog.BUTTON_POSITIVE).performClick(); assertEquals(ApkInstallPhase.COMMITTING, record().phase)
        button(activity, "核对已运行候选包")!!.performClick()
        pump { ShadowAlertDialog.getLatestAlertDialog()?.let { it !== stale && it.isShowing } == true }
        val current = ShadowAlertDialog.getLatestAlertDialog()
        assertEquals("接受本机恢复", current.getButton(AlertDialog.BUTTON_POSITIVE).text.toString())
        current.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        pump { !current.isShowing && button(activity, "核对已运行候选包") == null }
        assertEquals(ApkInstallPhase.LOCAL_PACKAGE_RECOVERED, record().phase); assertNull(record().recoveryResult)
        lateResult(PackageInstaller.STATUS_FAILURE_ABORTED)
        pump { views(activity.window.decorView).filterIsInstance<android.widget.TextView>().any { it.text.contains("后来报告安装取消") } }
        assertEquals(ApkSystemResult.CANCELLED, record().recoveryResult)
        assertEquals(0, Sessions.creates); assertEquals(0, Sessions.opens); assertEquals(0, connections); assertFalse(runtime.running)
        assertNull(shadowOf(activity).nextStartedActivity); controller.pause().stop().destroy()
    }
}
