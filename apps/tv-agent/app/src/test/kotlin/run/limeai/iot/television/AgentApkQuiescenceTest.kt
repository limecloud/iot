package run.limeai.iot.television

import android.app.Application
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.content.pm.SigningInfo
import android.os.Looper
import android.os.Build
import android.os.Process
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import org.robolectric.util.ReflectionHelpers
import run.limeai.iot.device.*
import java.io.ByteArrayInputStream
import android.net.Uri
import java.nio.file.Files
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.withLock
import kotlin.test.*

/** 实际Runtime工作线程、许可、串行队列和SQLite；连接端口显式受控，不运行MQTT或安装。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, shadows = [ApkImportLinuxFixture::class])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class AgentApkQuiescenceTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val vault = object : EnrollmentVault {
        override fun seal(bytes: ByteArray, binding: String) = bytes.copyOf()
        override fun open(bytes: ByteArray, binding: String) = bytes.copyOf()
    }
    private fun store() = AndroidAgentStore(context, vault)
    private fun pin(c: Char) = "sha256:" + c.toString().repeat(64)
    private fun hash(bytes: ByteArray) = "sha256:" + MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun plan() = ApkInstallPlan("update-one", Fixtures.enrollment.binding, pin('b'), pin('c'), pin('d'), 3, 4, 3, pin('e'), pin('f'))

    private fun pump(condition: () -> Boolean) {
        val deadline = System.nanoTime() + 2_000_000_000L
        while (!condition() && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(5)
        }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(condition(), "Runtime结果未在原2秒观察预算内到达")
    }
    private fun <T> update(runtime: AgentRuntime, materials: (ApkInstallPlan) -> Unit = {}, action: (ApkInstallJournal, AndroidApkInstaller) -> T): Result<T> {
        val result = AtomicReference<Result<T>?>(null)
        runtime.withApkInstallation(materials, action) { result.set(it) }
        pump { result.get() != null }
        return result.get()!!
    }
    private fun stored() = ApkInstallOwner.lock.withLock { AndroidApkInstallStore(context).use { it.read() } }

    private fun continuity(runtime: AgentRuntime): Result<ApkContinuitySnapshot> {
        val result = AtomicReference<Result<ApkContinuitySnapshot>?>(null)
        runtime.readApkContinuity { result.set(it) }
        pump { result.get() != null }
        return result.get()!!
    }

    private inner class Fixture {
        val entered = CountDownLatch(1)
        val closeRequested = CountDownLatch(1)
        val drained = CountDownLatch(1)
        val creates = AtomicInteger()
        val finished = AtomicInteger()
        val runtime: AgentRuntime
        init {
            store().use { it.install(Fixtures.enrollment) }
            runtime = AgentRuntime(context, ::store) { mqtt ->
                creates.incrementAndGet()
                object : AgentConnection {
                    override fun run() { entered.countDown(); check(drained.await(5, TimeUnit.SECONDS)) { "fixture worker not released" } }
                    override fun close() { mqtt.close(); closeRequested.countDown() }
                }
            }
        }
        fun start() { runtime.start { finished.incrementAndGet() }; assertTrue(entered.await(2, TimeUnit.SECONDS)); assertTrue(runtime.running) }
        fun release() { runtime.stop(); drained.countDown(); pump { !runtime.running && finished.get() > 0 } }
    }

    @Test fun active_and_stop_requested_workers_refuse_updates_until_actual_worker_cleanup() {
        val f = Fixture(); val operations = AtomicInteger()
        try {
            f.start()
            ApkInstallOwner.lock.withLock {
                f.runtime.start { fail("已有连接的重复开始不能结束当前服务") }
            }
            assertEquals(1, f.creates.get())
            for (stopping in listOf(false, true)) {
                if (stopping) { f.runtime.stop(); assertTrue(f.closeRequested.await(2, TimeUnit.SECONDS)) }
                assertTrue(f.runtime.running)
                val result = update(f.runtime) { _, _ -> operations.incrementAndGet() }
                assertEquals("apk_install_stop_required", (result.exceptionOrNull() as DeviceFault).code)
                assertEquals(0, operations.get()); assertEquals(0, f.finished.get())
                assertNull(stored())
            }
            f.release()
            assertEquals(ApkInstallPhase.PREPARED, update(f.runtime) { journal, _ -> journal.prepare(plan()).phase }.getOrThrow())
            val before = stored()
            f.runtime.start { f.finished.incrementAndGet() }
            shadowOf(Looper.getMainLooper()).idle()
            assertFalse(f.runtime.running); assertEquals(1, f.creates.get()); assertEquals(2, f.finished.get())
            assertContentEquals(before, stored())
        } finally { f.drained.countDown(); f.runtime.stop() }
    }

    @Test fun update_owner_refuses_new_start_before_waiting_and_durable_task_keeps_it_blocked() {
        val f = Fixture(); val held = CountDownLatch(1); val release = CountDownLatch(1)
        val reentrant = AtomicInteger()
        ApkInstallOwner.lock.withLock { f.runtime.start { reentrant.incrementAndGet() } }
        assertEquals(1, reentrant.get()); assertFalse(f.runtime.running); assertEquals(0, f.creates.get())
        val result = AtomicReference<Result<ApkInstallPhase>?>(null)
        f.runtime.withApkInstallation({}, { journal, _ ->
            journal.prepare(plan()); held.countDown()
            check(release.await(2, TimeUnit.SECONDS)); ApkInstallPhase.PREPARED
        }) { result.set(it) }
        try {
            assertTrue(held.await(2, TimeUnit.SECONDS))
            f.runtime.start { f.finished.incrementAndGet() }
            assertEquals(1, f.finished.get()); assertFalse(f.runtime.running); assertEquals(0, f.creates.get())
            assertEquals(1L, release.count) // start没有等待更新工作线程或SQLite。
            release.countDown(); pump { result.get() != null }
            assertEquals(ApkInstallPhase.PREPARED, result.get()!!.getOrThrow())
            val before = stored()
            f.runtime.start { f.finished.incrementAndGet() }
            assertEquals(2, f.finished.get()); assertFalse(f.runtime.running); assertContentEquals(before, stored())
            update(f.runtime) { journal, _ -> journal.cancelPrepared(plan().requestId) }.getOrThrow()
            f.start(); f.release()
        } finally { release.countDown(); f.drained.countDown(); f.runtime.stop() }
    }

    @Test fun failed_update_operation_releases_owner_and_reports_on_main_without_restarting() {
        val f = Fixture()
        val result = AtomicReference<Result<Unit>?>(null)
        val callbackOnMain = AtomicReference<Boolean>()
        f.runtime.withApkInstallation<Unit>({}, { _, _ -> throw DeviceFault("fixture_material_refused") }) {
            callbackOnMain.set(Looper.myLooper() == Looper.getMainLooper()); result.set(it)
        }
        try {
            pump { result.get() != null }
            assertEquals("fixture_material_refused", (result.get()!!.exceptionOrNull() as DeviceFault).code)
            assertTrue(callbackOnMain.get()); assertFalse(f.runtime.running); assertEquals(0, f.creates.get())
            assertFalse(ApkInstallOwner.lock.isLocked)
            f.start(); f.release()
        } finally { f.drained.countDown(); f.runtime.stop() }
    }

    @Test @Suppress("DEPRECATION")
    fun runtime_provider_requires_material_guard_after_real_baseline_and_source_fixture_checks() {
        val f = Fixture(); val baseline = byteArrayOf(1, 2, 3)
        val file = Files.createTempFile("limeiot-runtime-baseline-", ".apk").toFile().apply { writeBytes(baseline) }
        val certificate = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(Fixtures.enrollment.publicCertificate())).encoded
        val info = context.packageManager.getPackageInfo(ApkInstallJournal.PACKAGE, PackageManager.GET_PERMISSIONS)
        info.versionCode = 3
        info.applicationInfo!!.apply { uid = Process.myUid(); sourceDir = file.absolutePath }
        info.signatures = arrayOf(Signature(certificate))
        info.signingInfo = SigningInfo().also { shadowOf(it).setSignatures(info.signatures) }
        shadowOf(context.packageManager).installPackage(info)
        shadowOf(context.packageManager).setCanRequestPackageInstalls(true)
        val snapshot = continuity(f.runtime).getOrThrow()
        val original = plan().copy(baselineSha256 = hash(baseline), signerSha256 = hash(certificate))
        val checks = AtomicInteger()
        val refused = update(f.runtime) { journal, provider ->
            journal.prepare(original); provider.create(original.requestId)
        }
        assertEquals("apk_install_continuity_changed", (refused.exceptionOrNull() as DeviceFault).code)
        assertEquals(0, checks.get()); assertTrue(context.packageManager.packageInstaller.mySessions.isEmpty())
        update(f.runtime) { journal, _ -> journal.cancelPrepared(original.requestId) }.getOrThrow()
        val p = original.copy(requestId = "update-two", continuityDigest = snapshot.digest)
        val result = update(f.runtime, materials = { checks.incrementAndGet(); throw DeviceFault("fixture_material_refused") }) { journal, provider ->
            journal.prepare(p); provider.create(p.requestId)
        }
        assertEquals("fixture_material_refused", (result.exceptionOrNull() as DeviceFault).code)
        assertEquals(1, checks.get()); assertEquals(0, f.creates.get())
        assertTrue(context.packageManager.packageInstaller.mySessions.isEmpty())
        assertEquals(ApkInstallPhase.PREPARED, AndroidApkInstallStore(context).use { ApkInstallJournal(it).snapshot().single { record -> record.plan.requestId == p.requestId }.phase })
    }

    @Test fun continuity_read_requires_worker_exit_and_uses_actual_records_on_the_original_queue() {
        val f = Fixture()
        try {
            f.start()
            assertEquals("apk_install_stop_required", (continuity(f.runtime).exceptionOrNull() as DeviceFault).code)
            f.runtime.stop()
            assertEquals("apk_install_stop_required", (continuity(f.runtime).exceptionOrNull() as DeviceFault).code)
            f.release()
            val original = ApkJournalFixture.bytes(Fixtures.enrollment.identity)
            // 与worker退出后的refresh共用原队列，避免独立helper配置与维护读取并发。
            update(f.runtime) { _, _ -> store().use { it.journal(Fixtures.enrollment.binding).commit(original) } }.getOrThrow()
            val snapshot = continuity(f.runtime).getOrThrow()
            assertEquals(DeviceJournalInspection(9, 1, 1, 1, 1, false), snapshot.journal)
            update(f.runtime) { _, _ -> store().use { it.authorize("com.example.player", true) } }.getOrThrow()
            assertNotEquals(snapshot.digest, continuity(f.runtime).getOrThrow().digest)
            assertEquals(1, f.creates.get()); assertFalse(f.runtime.running)
        } finally { f.drained.countDown(); f.runtime.stop() }
    }

    @Test fun unknown_update_lookup_preserves_identity_grants_and_command_bytes_without_new_checks() {
        val f = Fixture(); val credentials = Fixtures.enrollment; val original = "original-confirmed-unknown-high-watermark".toByteArray()
        store().use { it.authorize("com.example.player", true); it.journal(credentials.binding).commit(original) }
        val identityBefore = context.getDatabasePath("tv-agent.db").readBytes()
        val p = plan()
        update(f.runtime) { journal, _ ->
            journal.prepare(p); journal.createSession(p.requestId, {}, { 17 })
            journal.staged(p.requestId, 17, p.candidateSha256, p.candidateBytes)
            journal.commit(p.requestId, {}, { _, _ -> })
        }.getOrThrow()
        val before = stored()
        val result = update(f.runtime, materials = { fail("unknown lookup cannot start material validation") }) { _, provider -> provider.commit(p.requestId) }
        assertEquals(ApkInstallPhase.COMMITTING, result.getOrThrow().phase)
        assertContentEquals(before, stored()); assertContentEquals(identityBefore, context.getDatabasePath("tv-agent.db").readBytes())
        store().use { assertEquals(credentials.binding, it.load()!!.binding); assertEquals(setOf("com.example.player"), it.allowed()); assertContentEquals(original, it.journal(credentials.binding).read()) }
        assertEquals(0, f.creates.get()); assertFalse(f.runtime.running)
    }

    @Test fun signed_material_source_prepares_original_plan_and_unknown_queries_do_not_read_missing_artifacts() {
        val f = Fixture()
        val material = ApkPreflightFixture.create()
        ReflectionHelpers.setStaticField(Build::class.java, "SUPPORTED_ABIS", arrayOf("x86_64"))
        ApkPreflightFixture.installFacts(context, material)
        shadowOf(context.packageManager).setCanRequestPackageInstalls(true)
        val result = AtomicReference<Result<ApkInstallRecord>?>(null)
        fun prepare() {
            result.set(null)
            f.runtime.prepareApkInstallation("signed-update", material.bundle, material.candidate, false) { result.set(it) }
            pump { result.get() != null }
        }
        try {
            f.start(); prepare()
            assertEquals("apk_install_stop_required", (result.get()!!.exceptionOrNull() as DeviceFault).code)
            f.release(); prepare()
            val record = result.get()!!.getOrThrow(); val p = record.plan
            assertEquals(ApkInstallPhase.PREPARED, record.phase)
            assertEquals(VerifiedApkPreflight.read(material.bundle, material.signer).digest, p.preflightDigest)
            assertEquals(continuity(f.runtime).getOrThrow().digest, p.continuityDigest)
            val original = material.candidate.readBytes(); material.candidate.writeBytes(byteArrayOf(9, 8, 7, 6))
            val refused = AtomicReference<Result<ApkInstallRecord>?>(null)
            f.runtime.withApkInstallation(material.bundle, material.candidate, false, { _, provider, _ -> provider.create(p.requestId) }) { refused.set(it) }
            pump { refused.get() != null }
            assertEquals("apk_preflight_candidate_changed", (refused.get()!!.exceptionOrNull() as DeviceFault).code)
            assertTrue(context.packageManager.packageInstaller.mySessions.isEmpty())
            assertEquals(ApkInstallPhase.PREPARED, AndroidApkInstallStore(context).use { ApkInstallJournal(it).snapshot().single().phase })
            material.candidate.writeBytes(original)
            update(f.runtime) { journal, _ ->
                journal.createSession(p.requestId, {}, { 17 }); journal.staged(p.requestId, 17, p.candidateSha256, p.candidateBytes)
                journal.commit(p.requestId, {}, { _, _ -> })
            }.getOrThrow()
            val before = stored(); val unknown = AtomicReference<Result<ApkInstallRecord>?>(null)
            f.runtime.withApkInstallation(java.io.File(material.bundle.parentFile, "missing-report.jar"), java.io.File(material.bundle.parentFile, "missing-candidate.apk"), false,
                { _, provider, _ -> provider.commit(p.requestId) }) { unknown.set(it) }
            pump { unknown.get() != null }
            assertEquals(ApkInstallPhase.COMMITTING, unknown.get()!!.getOrThrow().phase)
            assertContentEquals(before, stored()); assertEquals(1, f.creates.get()); assertFalse(f.runtime.running)
        } finally { f.drained.countDown(); f.runtime.stop() }
    }

    @Test fun product_import_review_and_visible_approval_survive_reopen_without_starting_installation() {
        val f = Fixture(); val material = ApkPreflightFixture.create(debug = true)
        ReflectionHelpers.setStaticField(Build::class.java, "SUPPORTED_ABIS", arrayOf("x86_64"))
        ApkPreflightFixture.installFacts(context, material)
        fun <T> await(action: ((Result<T>) -> Unit) -> Unit): Result<T> {
            val result = AtomicReference<Result<T>?>(null)
            action { result.set(it) }; pump { result.get() != null }; return result.get()!!
        }
        f.start()
        assertEquals("apk_install_stop_required", (await<String> { f.runtime.importApkPreflight(Uri.parse("content://unreadable-fixture/report"), it) }.exceptionOrNull() as DeviceFault).code)
        assertTrue(AndroidApkImports(context).entries().isEmpty())
        f.release()
        val id = await<String> { f.runtime.importApkPreflight(Uri.fromFile(material.bundle), it) }.getOrThrow()
        await<Unit> { f.runtime.importApkCandidate(id, Uri.fromFile(material.candidate), it) }.getOrThrow()
        val review = await<ApkUpdateReview> { f.runtime.previewApkUpdate(id, it) }.getOrThrow()
        assertEquals(3L, review.baselineVersion); assertEquals(4L, review.candidateVersion); assertTrue(review.debug)
        assertEquals(listOf("android.permission.REQUEST_INSTALL_PACKAGES"), review.addedPermissions)
        assertTrue(review.removedPermissions.isEmpty()); assertNull(stored())
        assertEquals("apk_preflight_debug_requires_approval", (await<ApkInstallRecord> { f.runtime.approveApkUpdate(review, false, it) }.exceptionOrNull() as DeviceFault).code)
        assertEquals("apk_install_visible_approval_required", (await<ApkInstallRecord> { f.runtime.approveApkUpdate(review, true, it) }.exceptionOrNull() as DeviceFault).code)
        f.runtime.setVisible(true)
        assertEquals("apk_preflight_materials_changed", (await<ApkInstallRecord> { f.runtime.approveApkUpdate(review.copy(candidateVersion = 9), true, it) }.exceptionOrNull() as DeviceFault).code)
        assertNull(stored()); assertEquals(1, f.creates.get())
        val approved = await<ApkInstallRecord> { f.runtime.approveApkUpdate(review, true, it) }.getOrThrow()
        assertEquals(ApkInstallPhase.PREPARED, approved.phase)
        assertEquals(continuity(f.runtime).getOrThrow().digest, approved.plan.continuityDigest)
        assertTrue(context.packageManager.packageInstaller.mySessions.isEmpty())
        assertEquals("apk_import_record_retained", (await<Unit> { f.runtime.discardApkImport(id, it) }.exceptionOrNull() as DeviceFault).code)
        val bytes = stored()
        val reopened = AgentRuntime(context, ::store) { fail("读取原更新不能启动连接") }
        val overview = await<ApkUpdateOverview> { reopened.apkUpdates(it) }.getOrThrow()
        assertEquals(ApkImportEntry(id, true, true), overview.imports.single()); assertEquals(approved, overview.records.single())
        assertTrue(overview.importsAvailable)
        assertContentEquals(bytes, stored())
        // 即使导入材料丢失，取消尚未创建会话的计划也不重新读取/签发材料。
        val candidate = AndroidApkImports(context).files(id).candidate
        assertTrue(candidate.renameTo(java.io.File(candidate.parentFile, "candidate-retained-outside-import.apk")))
        val damaged = await<ApkUpdateOverview> { reopened.apkUpdates(it) }.getOrThrow()
        assertFalse(damaged.importsAvailable); assertEquals(approved, damaged.records.single())
        assertContentEquals(bytes, stored())
        assertEquals(ApkInstallPhase.CANCELLED, await<ApkInstallRecord> { reopened.cancelPreparedApkUpdate(id, it) }.getOrThrow().phase)
        assertTrue(context.packageManager.packageInstaller.mySessions.isEmpty()); assertFalse(reopened.running)
        assertEquals("apk_import_record_retained", (await<Unit> { reopened.discardApkImport(id, it) }.exceptionOrNull() as DeviceFault).code)
    }
}
