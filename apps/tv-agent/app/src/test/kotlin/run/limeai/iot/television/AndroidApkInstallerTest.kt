package run.limeai.iot.television

import android.app.Application
import android.app.PendingIntent
import android.content.ComponentName
import android.content.IntentSender
import android.content.pm.PackageInstaller
import android.os.Build
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowPackageInstaller
import org.robolectric.util.ReflectionHelpers
import run.limeai.iot.device.*
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import kotlin.test.*

/** 系统会话参数走Robolectric；字节/提交端口明确为夹具，不报告真实安装。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class)
class AndroidApkInstallerTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val bytes = ByteArray(131073) { (it % 251).toByte() }
    private fun hash(value: ByteArray) = "sha256:" + MessageDigest.getInstance("SHA-256").digest(value).joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun pin(c: Char) = "sha256:" + c.toString().repeat(64)
    private fun plan() = ApkInstallPlan("update-one", "space-demo/device-tv/${pin('a')}", pin('b'), hash(bytes), pin('c'), 3, 4, bytes.size.toLong(), pin('d'), pin('e'))
    private fun fault(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<DeviceFault>(block = block).code)

    private class Storage : ApkInstallStorage {
        var bytes: ByteArray? = null
        override fun read() = bytes?.copyOf()
        override fun compareAndSet(expected: ByteArray?, updated: ByteArray): Boolean {
            if (bytes == null && expected != null || bytes != null && (expected == null || !bytes!!.contentEquals(expected))) return false
            bytes = updated.copyOf(); return true
        }
    }
    private class Sessions(private val plan: ApkInstallPlan) : ApkSessionApi {
        var creates = 0; var writes = 0; var reads = 0; var syncs = 0; var commits = 0; var writtenBytes = 0
        var data: ByteArray? = null
        var extras = emptyList<String>()
        var claims = emptyList<ApkSessionClaim>()
        var beforeCreate: () -> Unit = {}
        var afterCreate: () -> Unit = {}
        var beforeRead: () -> Unit = {}
        var afterWrite: () -> Unit = {}
        var onCommit: (IntentSender) -> Unit = {}
        override fun create(plan: ApkInstallPlan): Int {
            beforeCreate(); creates++
            claims = listOf(ApkSessionClaim(17, plan.digest, ApkInstallJournal.PACKAGE, plan.candidateBytes))
            afterCreate(); return 17
        }
        override fun ownSessions() = claims.toList()
        override fun open(sessionId: Int): ApkSessionIo {
            assertEquals(17, sessionId)
            return object : ApkSessionIo {
                override fun names() = (if (data == null) emptyList() else listOf(AndroidApkSessions.BASE_APK)) + extras
                override fun write(length: Long): OutputStream {
                    assertEquals(plan.candidateBytes, length); writes++
                    return object : ByteArrayOutputStream() {
                        override fun write(block: ByteArray, offset: Int, count: Int) { writtenBytes += count; super.write(block, offset, count) }
                        override fun close() { data = toByteArray(); afterWrite() }
                    }
                }
                override fun fsync(output: OutputStream) { syncs++ }
                override fun read(): InputStream { reads++; beforeRead(); return ByteArrayInputStream(data ?: error("no bytes")) }
                override fun commit(receiver: IntentSender) { commits++; onCommit(receiver) }
                override fun close() {}
            }
        }
    }
    private data class Fixture(val storage: Storage, val journal: ApkInstallJournal, val sessions: Sessions, val provider: AndroidApkInstaller)
    private fun fixture(installed: (ApkInstallPlan) -> Unit = {}, policy: () -> Unit = {}, continuity: (ApkInstallPlan) -> Unit = {}, guard: (ApkInstallPlan) -> Unit = {}): Fixture {
        val storage = Storage(); val journal = ApkInstallJournal(storage); val p = plan(); journal.prepare(p)
        val sessions = Sessions(p)
        return Fixture(storage, journal, sessions, AndroidApkInstaller(context, journal, guard, sessions, installed, policy, continuity))
    }
    private fun created(guard: (ApkInstallPlan) -> Unit = {}) = fixture(guard = guard).also { it.provider.create("update-one") }
    private fun staged() = created().also { it.provider.stage("update-one") { ByteArrayInputStream(bytes) } }
    private fun phase(f: Fixture) = ApkInstallJournal(f.storage).snapshot().single().phase

    @Test fun full_continuity_is_checked_at_effect_boundaries_and_refuses_drift_after_writing() {
        var scans = 0; var changed = false
        val f = fixture(continuity = { scans++; if (changed) throw DeviceFault("apk_install_continuity_changed") })
        f.provider.create("update-one"); scans = 0
        f.provider.stage("update-one") { ByteArrayInputStream(bytes) }
        assertEquals(2, scans, "完整扫描只在暂存边界执行，不随每64KiB读写重复")
        assertEquals(ApkInstallPhase.STAGED, phase(f))
        changed = true
        fault("apk_install_continuity_changed") { f.provider.commit("update-one") }
        assertEquals(0, f.sessions.commits); assertEquals(ApkInstallPhase.STAGED, phase(f))

        changed = false
        val drift = fixture(continuity = { if (changed) throw DeviceFault("apk_install_continuity_changed") })
        drift.provider.create("update-one"); drift.sessions.afterWrite = { changed = true }
        fault("apk_install_continuity_changed") { drift.provider.stage("update-one") { ByteArrayInputStream(bytes) } }
        assertEquals(1, drift.sessions.writes); assertEquals(0, drift.sessions.commits)
        assertEquals(ApkInstallPhase.CREATED, phase(drift)); assertContentEquals(bytes, drift.sessions.data)
    }

    @Implements(PackageInstaller::class)
    class RecordingInstaller : ShadowPackageInstaller() {
        @Implementation override fun createSession(params: PackageInstaller.SessionParams): Int { last = params; return super.createSession(params) }
        companion object { var last: PackageInstaller.SessionParams? = null }
    }

    @Test @Config(sdk = [23, 31], shadows = [RecordingInstaller::class])
    fun android_adapter_sets_fixed_full_install_parameters_and_only_returns_own_claims() {
        val p = plan(); val adapter = AndroidApkSessions(context); val id = adapter.create(p)
        val params = RecordingInstaller.last!!
        assertEquals(PackageInstaller.SessionParams.MODE_FULL_INSTALL, ReflectionHelpers.getField<Int>(params, "mode"))
        assertEquals(p.candidateBytes, ReflectionHelpers.getField<Long>(params, "sizeBytes"))
        if (Build.VERSION.SDK_INT >= 31) assertEquals(PackageInstaller.SessionParams.USER_ACTION_REQUIRED, ReflectionHelpers.getField<Int>(params, "requireUserAction"))
        val info = context.packageManager.packageInstaller.getSessionInfo(id)!!
        assertEquals(ApkInstallJournal.PACKAGE, info.appPackageName)
        assertEquals(AndroidApkSessions.LABEL_PREFIX + p.digest + "/" + p.candidateBytes, info.appLabel)
        // Robolectric不填系统来源和长度；这里只显式补系统元数据夹具，不绕过生产核对。
        assertTrue(adapter.ownSessions().isEmpty())
        ReflectionHelpers.setField(info, "installerPackageName", context.packageName)
        ReflectionHelpers.setField(info, "sizeBytes", p.candidateBytes)
        assertEquals(listOf(ApkSessionClaim(id, p.digest, ApkInstallJournal.PACKAGE, p.candidateBytes)), adapter.ownSessions())
        if (Build.VERSION.SDK_INT >= 27) {
            ReflectionHelpers.setField(info, "sizeBytes", 1L)
            assertTrue(adapter.ownSessions().isEmpty())
            ReflectionHelpers.setField(info, "sizeBytes", p.candidateBytes)
        }
        ReflectionHelpers.setField(info, "appLabel", AndroidApkSessions.LABEL_PREFIX + p.digest + "/0")
        assertTrue(adapter.ownSessions().isEmpty())
        ReflectionHelpers.setField(info, "appLabel", AndroidApkSessions.LABEL_PREFIX + p.digest + "/" + p.candidateBytes)
        ReflectionHelpers.setField(info, "installerPackageName", "example.other")
        assertTrue(adapter.ownSessions().isEmpty())
    }

    @Test fun creation_loss_only_recovers_original_owned_session_without_another_create() {
        val f = fixture()
        f.sessions.beforeCreate = { assertEquals(ApkInstallPhase.CREATING, phase(f)) }
        f.sessions.afterCreate = { error("lost Binder return") }
        fault("apk_install_creation_unknown") { f.provider.create("update-one") }
        f.provider.create("update-one"); assertEquals(1, f.sessions.creates)
        val claims = f.sessions.claims
        f.sessions.claims = emptyList()
        assertEquals(ApkInstallPhase.CREATING, f.provider.resolveCreation("update-one").phase)
        f.sessions.claims = claims + claims.single().copy(sessionId = 18)
        fault("apk_install_ambiguous_session") { f.provider.resolveCreation("update-one") }
        f.sessions.claims = claims
        assertEquals(17, f.provider.resolveCreation("update-one").sessionId)
        assertEquals(1, f.sessions.creates)
    }

    @Test fun lost_eligibility_after_creation_intent_is_zero_system_create() {
        var checks = 0
        val f = fixture { if (++checks == 2) error("stopped gate lost") }
        fault("apk_install_creation_unknown") { f.provider.create("update-one") }
        assertEquals(0, f.sessions.creates); assertEquals(ApkInstallPhase.CREATING, phase(f))
    }

    @Test fun staging_fsyncs_reads_back_and_recovers_existing_complete_bytes_without_rewriting() {
        val f = created()
        assertEquals(ApkInstallPhase.STAGED, f.provider.stage("update-one") { ByteArrayInputStream(bytes) }.phase)
        assertContentEquals(bytes, f.sessions.data)
        assertEquals(1, f.sessions.writes); assertEquals(1, f.sessions.syncs); assertEquals(1, f.sessions.reads)
        f.provider.stage("update-one") { fail("same stage cannot reopen candidate") }
        assertEquals(1, f.sessions.writes)
        val recovered = created(); recovered.sessions.data = bytes.copyOf()
        assertEquals(ApkInstallPhase.STAGED, recovered.provider.stage("update-one") { fail("existing bytes are read only") }.phase)
        assertEquals(0, recovered.sessions.writes); assertEquals(0, recovered.sessions.syncs)
    }

    @Test fun candidate_length_hash_and_readback_mismatch_keep_original_session_without_commit() {
        for (bad in listOf(bytes.copyOf(bytes.size - 1), bytes + 0.toByte(), bytes.copyOf().apply { this[0] = 99 })) {
            val f = created()
            fault("apk_install_stage_mismatch") { f.provider.stage("update-one") { ByteArrayInputStream(bad) } }
            assertEquals(ApkInstallPhase.CREATED, phase(f)); assertEquals(0, f.sessions.commits)
        }
        val f = created(); f.sessions.afterWrite = { f.sessions.data = byteArrayOf(1) }
        fault("apk_install_stage_mismatch") { f.provider.stage("update-one") { ByteArrayInputStream(bytes) } }
        assertEquals(ApkInstallPhase.CREATED, phase(f)); assertEquals(0, f.sessions.commits)
    }

    @Test fun partial_extra_or_foreign_session_is_not_overwritten_or_replaced() {
        val partial = created(); partial.sessions.data = byteArrayOf(1)
        fault("apk_install_stage_mismatch") { partial.provider.stage("update-one") { fail("no replacement source") } }
        assertEquals(0, partial.sessions.writes)
        val extra = created(); extra.sessions.extras = listOf("other.apk")
        fault("apk_install_stage_mismatch") { extra.provider.stage("update-one") { fail("no write") } }
        val foreign = created(); foreign.sessions.claims = foreign.sessions.claims.map { it.copy(requestDigest = pin('f')) }
        fault("apk_install_session_mismatch") { foreign.provider.stage("update-one") { fail("no write") } }
        assertEquals(0, extra.sessions.writes); assertEquals(0, foreign.sessions.writes)
    }

    @Test fun eligibility_loss_during_candidate_read_stops_before_new_session_bytes() {
        var valid = true
        val f = created { check(valid) }
        assertFailsWith<IllegalStateException> {
            f.provider.stage("update-one") {
                object : ByteArrayInputStream(bytes) {
                    override fun read(block: ByteArray, offset: Int, count: Int): Int = super.read(block, offset, count).also { valid = false }
                }
            }
        }
        assertEquals(0, f.sessions.writtenBytes); assertEquals(0, f.sessions.syncs); assertEquals(ApkInstallPhase.CREATED, phase(f))
    }

    @Test @Config(sdk = [28, 31])
    fun commit_reads_back_before_and_after_durable_intent_and_never_repeats() {
        val f = staged(); val phases = mutableListOf<ApkInstallPhase>()
        f.sessions.beforeRead = { phases += phase(f) }
        f.sessions.onCommit = { assertEquals(ApkInstallPhase.COMMITTING, phase(f)) }
        assertEquals(ApkInstallPhase.COMMITTING, f.provider.commit("update-one").phase)
        assertEquals(listOf(ApkInstallPhase.STAGED, ApkInstallPhase.COMMITTING), phases)
        assertEquals(1, f.sessions.commits)
        f.provider.commit("update-one"); assertEquals(1, f.sessions.commits)
        val lookupFlags = PendingIntent.FLAG_NO_CREATE or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        val pending = PendingIntent.getBroadcast(context, 17, AndroidApkInstaller.resultIntent(context, f.journal.snapshot().single()), lookupFlags)!!
        val shadow = shadowOf(pending)
        assertTrue(shadow.isBroadcast); assertFalse(shadow.isImmutable)
        assertEquals(ComponentName(context, ApkInstallResultReceiver::class.java), shadow.savedIntent.component)
        assertEquals(AndroidApkInstaller.RESULT_ACTION, shadow.savedIntent.action)
        assertEquals(listOf("update-one", plan().digest, "17"), shadow.savedIntent.data!!.pathSegments)
        assertEquals(0, shadow.flags and PendingIntent.FLAG_ONE_SHOT)
        if (Build.VERSION.SDK_INT >= 31) assertEquals(PendingIntent.FLAG_MUTABLE, shadow.flags and PendingIntent.FLAG_MUTABLE)
        assertFalse(context.packageManager.getReceiverInfo(ComponentName(context, ApkInstallResultReceiver::class.java), 0).exported)
    }

    @Test fun changed_session_bytes_after_commit_intent_are_zero_submit_and_remain_unknown() {
        val f = staged()
        f.sessions.beforeRead = { if (phase(f) == ApkInstallPhase.COMMITTING) f.sessions.data = byteArrayOf(1) }
        fault("apk_install_stage_mismatch") { f.provider.commit("update-one") }
        assertEquals(ApkInstallPhase.COMMITTING, phase(f)); assertEquals(0, f.sessions.commits)
        f.provider.commit("update-one"); assertEquals(0, f.sessions.commits)
    }

    @Test fun lost_system_submit_response_reopens_original_without_any_resubmission() {
        val f = staged(); f.sessions.onCommit = { error("lost result after Binder") }
        fault("apk_install_commit_unknown") { f.provider.commit("update-one") }
        val reopened = AndroidApkInstaller(context, ApkInstallJournal(f.storage), { fail("unknown query cannot start work") }, f.sessions, { fail("unknown query cannot scan baseline") }, { fail("unknown query cannot check policy") })
        assertEquals(ApkInstallPhase.COMMITTING, reopened.commit("update-one").phase)
        assertEquals(1, f.sessions.commits)
    }

    @Test fun baseline_mismatch_at_each_creation_boundary_is_zero_system_create() {
        for (boundary in 1..2) {
            var checks = 0
            val f = fixture(installed = { if (++checks == boundary) throw DeviceFault("apk_install_baseline_mismatch") })
            fault(if (boundary == 1) "apk_install_baseline_mismatch" else "apk_install_creation_unknown") { f.provider.create("update-one") }
            assertEquals(0, f.sessions.creates)
            assertEquals(if (boundary == 1) ApkInstallPhase.PREPARED else ApkInstallPhase.CREATING, phase(f))
        }
    }

    @Test fun baseline_drift_at_stage_or_commit_boundaries_keeps_original_without_submit() {
        for (boundary in 1..6) {
            var checks = 0
            var observe = false
            val f = fixture(installed = { if (observe && ++checks == boundary) throw DeviceFault("apk_install_baseline_mismatch") })
            f.provider.create("update-one"); observe = true
            fault("apk_install_baseline_mismatch") {
                f.provider.stage("update-one") { ByteArrayInputStream(bytes) }
                f.provider.commit("update-one")
            }
            assertEquals(1, f.sessions.creates); assertEquals(0, f.sessions.commits)
            assertEquals(if (boundary <= 2) ApkInstallPhase.CREATED else if (boundary <= 4) ApkInstallPhase.STAGED else ApkInstallPhase.COMMITTING, phase(f))
            if (boundary == 1) assertEquals(0, f.sessions.writes)
            if (boundary >= 5) {
                f.provider.commit("update-one")
                assertEquals(0, f.sessions.commits); assertEquals(boundary, checks)
            }
        }
    }

    @Test fun default_provider_rejects_missing_system_baseline_without_creating_a_session() {
        val f = fixture()
        val provider = AndroidApkInstaller(context, f.journal, {}, f.sessions)
        assertFailsWith<DeviceFault> { provider.create("update-one") }
        assertEquals(0, f.sessions.creates); assertEquals(ApkInstallPhase.PREPARED, phase(f))
    }

    @Test fun install_source_loss_after_durable_intent_is_zero_create_or_commit() {
        var f: Fixture? = null
        val creating = fixture(policy = { if (f != null && phase(f!!) == ApkInstallPhase.CREATING) throw DeviceFault("apk_install_source_authorization_required") })
        f = creating
        fault("apk_install_creation_unknown") { creating.provider.create("update-one") }
        assertEquals(0, creating.sessions.creates); assertEquals(ApkInstallPhase.CREATING, phase(creating))
        f = null
        val committing = fixture(policy = { if (f != null && phase(f!!) == ApkInstallPhase.COMMITTING) throw DeviceFault("apk_install_policy_restricted") })
        f = committing
        committing.provider.create("update-one"); committing.provider.stage("update-one") { ByteArrayInputStream(bytes) }
        fault("apk_install_policy_restricted") { committing.provider.commit("update-one") }
        assertEquals(0, committing.sessions.commits); assertEquals(ApkInstallPhase.COMMITTING, phase(committing))
        committing.provider.commit("update-one"); assertEquals(0, committing.sessions.commits)
    }

    @Test fun install_source_revoked_during_candidate_read_blocks_next_write_without_advancing() {
        var allowed = true
        val f = fixture(policy = { if (!allowed) throw DeviceFault("apk_install_source_authorization_required") })
        f.provider.create("update-one")
        fault("apk_install_source_authorization_required") {
            f.provider.stage("update-one") {
                object : ByteArrayInputStream(bytes) {
                    override fun read(block: ByteArray, offset: Int, count: Int): Int = super.read(block, offset, count).also { allowed = false }
                }
            }
        }
        assertEquals(0, f.sessions.writtenBytes); assertEquals(0, f.sessions.syncs)
        assertEquals(0, f.sessions.commits); assertEquals(ApkInstallPhase.CREATED, phase(f))
    }

    @Test fun default_install_policy_blocks_without_system_source_authorization() {
        val f = fixture()
        val provider = AndroidApkInstaller(context, f.journal, {}, f.sessions, {})
        fault("apk_install_source_authorization_required") { provider.create("update-one") }
        assertEquals(0, f.sessions.creates); assertEquals(ApkInstallPhase.PREPARED, phase(f))
    }
}
