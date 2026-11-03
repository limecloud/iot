package run.limeai.iot.television

import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageInfo
import android.content.pm.ResolveInfo
import android.os.Build
import android.os.Looper
import android.provider.Settings
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.SQLiteMode
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowPackageInstaller
import org.robolectric.util.ReflectionHelpers
import run.limeai.iot.device.*
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import kotlin.test.*

/** 实际Runtime队列、宿主JAR密码、文件与SQLite；系统会话/来源/确认组件全部是明确夹具。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [23, 28], application = Application::class,
    shadows = [ApkImportLinuxFixture::class, ApkInstallInteractionTest.Installer::class, ApkInstallInteractionTest.Session::class])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class ApkInstallInteractionTest {
    @Implements(PackageInstaller::class)
    class Installer : ShadowPackageInstaller() {
        @Implementation override fun createSession(params: PackageInstaller.SessionParams): Int {
            val id = super.createSession(params); creates++
            val info = getSessionInfo(id)!!
            ReflectionHelpers.setField(info, "installerPackageName", ApkInstallJournal.PACKAGE)
            ReflectionHelpers.setField(info, "sizeBytes", ReflectionHelpers.getField<Long>(params, "sizeBytes"))
            afterCreate(); return id
        }
        @Implementation override fun openSession(sessionId: Int): PackageInstaller.Session {
            return Shadow.newInstanceOf(PackageInstaller.Session::class.java).also { Shadow.extract<Session>(it).id = sessionId }
        }
        companion object {
            var creates = 0; var writes = 0; var commits = 0; var syncs = 0
            val bytes = mutableMapOf<Int, ByteArray>()
            var afterCreate: () -> Unit = {}
            var afterWrite: () -> Unit = {}
            var onCommit: (Int, IntentSender) -> Unit = { _, _ -> }
            fun reset() { creates = 0; writes = 0; commits = 0; syncs = 0; bytes.clear(); afterCreate = {}; afterWrite = {}; onCommit = { _, _ -> } }
        }
    }
    @Implements(PackageInstaller.Session::class)
    class Session {
        var id = -1
        @Implementation fun getNames(): Array<String> = if (Installer.bytes.containsKey(id)) arrayOf("base.apk") else emptyArray()
        @Implementation fun openWrite(name: String, offset: Long, length: Long): OutputStream {
            assertEquals("base.apk", name); assertEquals(0L, offset); Installer.writes++
            return object : ByteArrayOutputStream() {
                override fun write(block: ByteArray, start: Int, count: Int) { super.write(block, start, count); Installer.afterWrite() }
                override fun close() { Installer.bytes[id] = toByteArray() }
            }
        }
        @Implementation fun fsync(output: OutputStream) { Installer.syncs++ }
        @Implementation fun openRead(name: String) = ByteArrayInputStream(Installer.bytes[id] ?: error("fixture missing bytes"))
        @Implementation fun commit(receiver: IntentSender) { Installer.commits++; Installer.onCommit(id, receiver) }
        @Implementation fun close() {}
    }

    private val context get() = RuntimeEnvironment.getApplication()
    private val vault = object : EnrollmentVault {
        override fun seal(bytes: ByteArray, binding: String) = bytes.copyOf()
        override fun open(bytes: ByteArray, binding: String) = bytes.copyOf()
    }
    private fun store() = AndroidAgentStore(context, vault)
    private lateinit var runtime: AgentRuntime
    private lateinit var material: ApkPreflightFixture.Materials
    private lateinit var review: ApkUpdateReview
    private val confirmationAction = "fixture.system.CONFIRM_ORIGINAL"

    @Before fun setup() {
        Installer.reset()
        ReflectionHelpers.setField(ApkInstallConfirmations, "pending", null)
        ReflectionHelpers.setStaticField(Build::class.java, "SUPPORTED_ABIS", arrayOf("x86_64"))
        material = ApkPreflightFixture.create(debug = true); ApkPreflightFixture.installFacts(context, material)
        store().use { it.install(Fixtures.enrollment) }
        runtime = AgentRuntime(context, ::store) { error("更新不得连接") }; runtime.setVisible(true)
        allowed(true)
        val id = await<String> { runtime.importApkPreflight(android.net.Uri.fromFile(material.bundle), it) }.getOrThrow()
        await<Unit> { runtime.importApkCandidate(id, android.net.Uri.fromFile(material.candidate), it) }.getOrThrow()
        review = await<ApkUpdateReview> { runtime.previewApkUpdate(id, it) }.getOrThrow()
        await<ApkInstallRecord> { runtime.approveApkUpdate(review, true, it) }.getOrThrow()
    }
    private fun allowed(value: Boolean) {
        if (Build.VERSION.SDK_INT >= 26) shadowOf(context.packageManager).setCanRequestPackageInstalls(value)
        else @Suppress("DEPRECATION") Settings.Secure.putInt(context.contentResolver, Settings.Secure.INSTALL_NON_MARKET_APPS, if (value) 1 else 0)
    }
    private fun <T> await(action: ((Result<T>) -> Unit) -> Unit): Result<T> {
        val result = AtomicReference<Result<T>?>(null); action { result.set(it) }
        val deadline = System.nanoTime() + 2_000_000_000L
        while (result.get() == null && System.nanoTime() < deadline) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(5) }
        shadowOf(Looper.getMainLooper()).idle(); return assertNotNull(result.get(), "结果未在原2秒观察预算内到达")
    }
    private fun advance(permit: RunPermit = RunPermit()) = await<ApkInstallRecord> { runtime.continueApkUpdate(review, true, permit, it) }
    private fun record() = AndroidApkInstallStore(context).use { ApkInstallJournal(it).snapshot().single() }
    private fun stored() = AndroidApkInstallStore(context).use { it.read()!! }
    private fun fault(code: String, result: Result<*>) = assertEquals(code, (result.exceptionOrNull() as DeviceFault).code)
    private fun result(status: Int, confirmation: Intent? = null): ApkInstallRecord {
        val original = record()
        val envelope = AndroidApkInstaller.resultIntent(context, original)
            .putExtra(PackageInstaller.EXTRA_SESSION_ID, original.sessionId!!).putExtra(PackageInstaller.EXTRA_STATUS, status)
        if (confirmation != null) envelope.putExtra(Intent.EXTRA_INTENT, confirmation)
        return ApkInstallResultReceiver.accept(context, envelope)
    }
    private fun confirmation(mutate: (ActivityInfo) -> Unit = {}): Intent {
        val intent = Intent(confirmationAction).setPackage("fixture.system.installer")
            .putExtra(PackageInstaller.EXTRA_SESSION_ID, record().sessionId!!)
        val info = ActivityInfo().apply {
            packageName = "fixture.system.installer"; name = "fixture.system.installer.Confirm"; enabled = true; exported = true
            applicationInfo = ApplicationInfo().apply { packageName = "fixture.system.installer"; enabled = true; flags = ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_INSTALLED }
        }.also(mutate)
        shadowOf(context.packageManager).installPackage(PackageInfo().apply {
            packageName = info.packageName; applicationInfo = info.applicationInfo; activities = arrayOf(info)
        })
        shadowOf(context.packageManager).setResolveInfosForIntent(intent, listOf(ResolveInfo().apply { activityInfo = info; isDefault = true }))
        return intent
    }

    @Test fun explicit_original_flow_commits_once_then_visible_confirmation_waits_for_system_result() {
        val submitted = advance().getOrThrow()
        assertEquals(ApkInstallPhase.COMMITTING, submitted.phase)
        assertEquals(1, Installer.creates); assertEquals(1, Installer.writes); assertEquals(1, Installer.syncs); assertEquals(1, Installer.commits)
        assertContentEquals(material.candidate.readBytes(), Installer.bytes[submitted.sessionId])
        result(PackageInstaller.STATUS_PENDING_USER_ACTION, confirmation())
        assertTrue(ApkInstallConfirmations.available(record())); assertNull(shadowOf(context).nextStartedActivity)
        val original = stored(); var launches = 0
        await<Unit> { callback -> runtime.openApkConfirmation(review, true, RunPermit(), { intent ->
            launches++; assertEquals(ComponentName("fixture.system.installer", "fixture.system.installer.Confirm"), intent.component)
            assertEquals(submitted.sessionId, intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)); assertEquals(0, intent.flags)
        }, callback) }.getOrThrow()
        assertEquals(1, launches); assertContentEquals(original, stored()); assertEquals(1, Installer.commits)
        assertEquals(ApkInstallPhase.INSTALLED_UNVERIFIED, result(PackageInstaller.STATUS_SUCCESS).phase)
        assertFalse(ApkInstallConfirmations.available(record())); val installed = stored()
        assertEquals(ApkInstallPhase.INSTALLED_UNVERIFIED, advance().getOrThrow().phase)
        assertContentEquals(installed, stored()); assertEquals(1, Installer.commits)
        assertTrue(record().blocksAnotherInstall); assertFalse(runtime.running)
    }

    @Test fun missing_source_and_expired_foreground_permit_refuse_effects_even_after_return() {
        allowed(false); val before = stored()
        fault("apk_install_source_authorization_required", advance())
        assertEquals(0, Installer.creates); assertContentEquals(before, stored())
        val old = RunPermit(); old.stop(); runtime.setVisible(false); runtime.setVisible(true); allowed(true)
        fault("apk_install_visible_approval_required", advance(old))
        assertContentEquals(before, stored()); assertEquals(0, Installer.creates)
        assertEquals(ApkInstallPhase.COMMITTING, advance().getOrThrow().phase)
    }

    @Test fun creation_return_loss_only_resolves_original_owned_session_without_another_create() {
        Installer.afterCreate = { error("fixture lost create return") }
        fault("apk_install_creation_unknown", advance()); assertEquals(ApkInstallPhase.CREATING, record().phase)
        assertEquals(ApkInstallPhase.CREATING, advance().getOrThrow().phase); assertEquals(1, Installer.creates)
        val recovered = await<ApkInstallRecord> { runtime.recoverApkUpdate(review.requestId, it) }.getOrThrow()
        assertEquals(ApkInstallPhase.CREATED, recovered.phase); assertEquals(1, Installer.creates); assertEquals(0, Installer.commits)
        assertEquals(ApkInstallPhase.COMMITTING, advance().getOrThrow().phase)
        assertEquals(1, Installer.creates); assertEquals(1, Installer.commits)
    }

    @Test fun background_during_copy_preserves_original_session_and_never_commits_with_revived_visibility() {
        val interaction = RunPermit()
        Installer.afterWrite = { interaction.stop(); runtime.setVisible(false); runtime.setVisible(true) }
        fault("apk_install_visible_approval_required", advance(interaction))
        assertEquals(ApkInstallPhase.CREATED, record().phase); assertEquals(1, Installer.creates); assertEquals(0, Installer.commits)
        // 完整已写字节可以读回恢复；不覆盖原会话、不沿旧许可提交。
        Installer.afterWrite = {}
        assertEquals(ApkInstallPhase.COMMITTING, advance().getOrThrow().phase)
        assertEquals(1, Installer.creates); assertEquals(1, Installer.writes); assertEquals(1, Installer.commits)
    }

    @Test fun unknown_commit_with_lost_materials_remains_readable_and_cannot_reissue_or_manufacture_confirmation() {
        Installer.onCommit = { _, _ -> error("fixture lost commit return") }
        fault("apk_install_commit_unknown", advance()); assertEquals(ApkInstallPhase.COMMITTING, record().phase)
        val original = stored(); val files = AndroidApkImports(context).files(review.requestId)
        assertTrue(files.bundle.renameTo(java.io.File(files.bundle.parentFile, "retained-report.jar")))
        assertEquals(ApkInstallPhase.COMMITTING, advance().getOrThrow().phase)
        assertEquals(ApkInstallPhase.COMMITTING, await<ApkInstallRecord> { runtime.recoverApkUpdate(review.requestId, it) }.getOrThrow().phase)
        assertContentEquals(original, stored()); assertEquals(1, Installer.creates); assertEquals(1, Installer.commits)
        assertFalse(ApkInstallConfirmations.available(record()))
    }

    @Test fun bad_system_confirmation_and_process_loss_preserve_pending_without_starting_or_resubmitting() {
        advance().getOrThrow()
        val bad = confirmation().putExtra(PackageInstaller.EXTRA_SESSION_ID, record().sessionId!! + 1)
        assertEquals(ApkInstallPhase.PENDING_USER, result(PackageInstaller.STATUS_PENDING_USER_ACTION, bad).phase)
        assertFalse(ApkInstallConfirmations.available(record()))
        val valid = confirmation(); result(PackageInstaller.STATUS_PENDING_USER_ACTION, valid)
        assertTrue(ApkInstallConfirmations.available(record()))
        // 输入对象后续改动不影响已核对的私有Intent副本。
        valid.setPackage("fixture.evil")
        assertEquals("fixture.system.installer", ApkInstallConfirmations.intent(context, record()).`package`)
        val before = stored(); ReflectionHelpers.setField(ApkInstallConfirmations, "pending", null)
        var launched = false
        fault("apk_install_confirmation_unavailable", await<Unit> { runtime.openApkConfirmation(review, true, RunPermit(), { launched = true }, it) })
        assertFalse(launched); assertContentEquals(before, stored())
        assertEquals(ApkInstallPhase.PENDING_USER, advance().getOrThrow().phase); assertEquals(1, Installer.commits)
    }

    @Test fun confirmation_rechecks_source_plan_continuity_and_original_lifecycle_before_launch() {
        advance().getOrThrow(); result(PackageInstaller.STATUS_PENDING_USER_ACTION, confirmation())
        var launches = 0
        fun open(permit: RunPermit = RunPermit()) = await<Unit> { runtime.openApkConfirmation(review, true, permit, { launches++ }, it) }
        // 原队列已完整核对但主线程尚未启动时离开；再次可见也不能借用旧许可。
        val queuedPermit = RunPermit(); val queuedResult = AtomicReference<Result<Unit>?>(null)
        runtime.openApkConfirmation(review, true, queuedPermit, { launches++ }) { queuedResult.set(it) }
        val drained = CountDownLatch(1)
        ReflectionHelpers.getField<ExecutorService>(runtime, "io").execute { drained.countDown() }
        assertTrue(drained.await(2, TimeUnit.SECONDS)); assertNull(queuedResult.get())
        queuedPermit.stop(); runtime.setVisible(false); runtime.setVisible(true)
        shadowOf(Looper.getMainLooper()).idle()
        fault("apk_install_visible_approval_required", assertNotNull(queuedResult.get())); assertEquals(0, launches)
        allowed(false); fault("apk_install_source_authorization_required", open()); allowed(true)
        val expired = RunPermit(); expired.stop(); fault("apk_install_visible_approval_required", open(expired))
        fault("apk_preflight_materials_changed", await<Unit> { runtime.openApkConfirmation(review.copy(candidateVersion = 8), true, RunPermit(), { launches++ }, it) })
        store().use { it.authorize("com.example.player", true) }
        fault("apk_install_continuity_changed", open()); assertEquals(0, launches)
        assertEquals(ApkInstallPhase.PENDING_USER, record().phase); assertEquals(1, Installer.commits)
    }

    @Test fun confirmation_payload_and_resolved_component_must_match_the_original_system_session() {
        advance().getOrThrow()
        val invalid = listOf<(Intent) -> Intent>(
            { Intent(it).setData(android.net.Uri.parse("content://fixture/foreign")) },
            { Intent(it).putExtra("foreign", "unsupported") },
            { Intent(it).setPackage(null).apply { selector = Intent("fixture.selector") } },
            { Intent(it).addCategory("fixture.category") },
            { Intent(it).setComponent(ComponentName("fixture.other", "fixture.other.Confirm")) },
        )
        for (change in invalid) {
            ReflectionHelpers.setField(ApkInstallConfirmations, "pending", null)
            result(PackageInstaller.STATUS_PENDING_USER_ACTION, change(confirmation()))
            assertFalse(ApkInstallConfirmations.available(record()))
        }
        for (change in listOf<(ActivityInfo) -> Unit>(
            { it.exported = false }, { it.enabled = false }, { it.applicationInfo.flags = 0 },
            { it.permission = "fixture.permission.DENIED" },
        )) {
            ReflectionHelpers.setField(ApkInstallConfirmations, "pending", null)
            result(PackageInstaller.STATUS_PENDING_USER_ACTION, confirmation(change))
            assertFalse(ApkInstallConfirmations.available(record()))
        }
        val valid = confirmation().addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        result(PackageInstaller.STATUS_PENDING_USER_ACTION, valid)
        assertTrue(ApkInstallConfirmations.available(record()))
        assertEquals(0, ApkInstallConfirmations.intent(context, record()).flags) // 仅传固定action、组件及原session，无URI授权。
        assertNull(shadowOf(context).nextStartedActivity); assertEquals(1, Installer.commits)
    }
}
