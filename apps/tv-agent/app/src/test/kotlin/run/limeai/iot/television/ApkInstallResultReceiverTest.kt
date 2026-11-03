package run.limeai.iot.television

import android.app.Application
import android.app.PendingIntent
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.os.Looper
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import run.limeai.iot.device.*
import kotlin.test.*
import kotlin.concurrent.withLock

/** 回执为显式系统输入夹具，记录由真实宿主SQLite保存；不执行系统安装。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class ApkInstallResultReceiverTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private fun pin(c: Char) = "sha256:" + c.toString().repeat(64)
    private fun plan(id: String) = ApkInstallPlan(id, "space-demo/device-tv/${pin('a')}", pin('b'), pin('c'), pin('d'), 3, 4, 123, pin('e'), pin('f'))
    private fun committing(id: String = "update-one", sessionId: Int = 17): ApkInstallRecord = AndroidApkInstallStore(context).use {
        val journal = ApkInstallJournal(it); val p = plan(id)
        journal.prepare(p); journal.createSession(id, {}, { sessionId }); journal.staged(id, sessionId, p.candidateSha256, p.candidateBytes)
        journal.commit(id, {}, { _, _ -> })
    }
    private fun callback(record: ApkInstallRecord, status: Int) = AndroidApkInstaller.resultIntent(context, record)
        .putExtra(PackageInstaller.EXTRA_SESSION_ID, record.sessionId)
        .putExtra(PackageInstaller.EXTRA_PACKAGE_NAME, ApkInstallJournal.PACKAGE)
        .putExtra(PackageInstaller.EXTRA_STATUS, status)
    private fun stored() = AndroidApkInstallStore(context).use { it.read()!! }
    private fun fault(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<DeviceFault>(block = block).code)

    @Test fun pending_then_success_reopens_original_and_does_not_launch_or_save_confirmation() {
        val record = committing()
        val intent = callback(record, PackageInstaller.STATUS_PENDING_USER_ACTION)
            .putExtra(Intent.EXTRA_INTENT, Intent("fixture.system.confirmation.secret"))
        assertEquals(ApkInstallPhase.PENDING_USER, ApkInstallResultReceiver.accept(context, intent).phase)
        val before = stored()
        ApkInstallResultReceiver.accept(context, intent); assertContentEquals(before, stored())
        assertFalse(stored().toString(Charsets.UTF_8).contains("fixture.system.confirmation.secret"))
        assertNull(shadowOf(context).nextStartedActivity)
        assertEquals(ApkInstallPhase.INSTALLED_UNVERIFIED, ApkInstallResultReceiver.accept(context, callback(record, PackageInstaller.STATUS_SUCCESS)).phase)
        AndroidApkInstallStore(context).use {
            val journal = ApkInstallJournal(it)
            assertEquals(ApkInstallPhase.INSTALLED_UNVERIFIED, journal.snapshot().single().phase)
            fault("apk_install_in_progress") { journal.prepare(plan("another")) }
        }
    }

    @Test @Config(sdk = [33]) @android.annotation.TargetApi(33)
    fun explicit_pending_intent_delivers_repeated_system_updates_through_registered_receiver() {
        val record = committing()
        val pending = PendingIntent.getBroadcast(context, record.sessionId!!, AndroidApkInstaller.resultIntent(context, record), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
        // Robolectric不为无filter的清单入口建立分发wrapper；显式注册真实类，清单非导出属性另验。
        val receiver = ApkInstallResultReceiver()
        val filter = IntentFilter(AndroidApkInstaller.RESULT_ACTION).apply { addDataScheme("limeiot-apk"); addDataAuthority("result", null) }
        context.registerReceiver(receiver, filter, android.content.Context.RECEIVER_NOT_EXPORTED)
        fun deliver(status: Int, expected: ApkInstallPhase) {
            val fill = Intent().putExtra(PackageInstaller.EXTRA_SESSION_ID, record.sessionId)
                .putExtra(PackageInstaller.EXTRA_STATUS, status)
            pending.send(context, 0, fill)
            val deadline = System.nanoTime() + 2_000_000_000L
            var observed: ApkInstallPhase? = null
            do {
                shadowOf(Looper.getMainLooper()).idle()
                observed = ApkInstallOwner.lock.withLock {
                    AndroidApkInstallStore(context).use { ApkInstallJournal(it).snapshot().single().phase }
                }
                if (observed == expected) break
                Thread.sleep(10)
            } while (System.nanoTime() < deadline)
            assertEquals(expected, observed)
        }
        try {
            deliver(PackageInstaller.STATUS_PENDING_USER_ACTION, ApkInstallPhase.PENDING_USER)
            deliver(PackageInstaller.STATUS_SUCCESS, ApkInstallPhase.INSTALLED_UNVERIFIED)
            assertNull(shadowOf(context).nextStartedActivity)
        } finally { context.unregisterReceiver(receiver) }
    }

    @Test fun all_defined_failure_statuses_keep_original_history_and_user_abort_is_cancelled() {
        val statuses = listOf(PackageInstaller.STATUS_FAILURE, PackageInstaller.STATUS_FAILURE_BLOCKED, PackageInstaller.STATUS_FAILURE_CONFLICT,
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE, PackageInstaller.STATUS_FAILURE_INVALID, PackageInstaller.STATUS_FAILURE_STORAGE,
            PackageInstaller.STATUS_FAILURE_ABORTED)
        for ((index, status) in statuses.withIndex()) {
            val record = committing("update-$index", 17 + index)
            val phase = if (status == PackageInstaller.STATUS_FAILURE_ABORTED) ApkInstallPhase.CANCELLED else ApkInstallPhase.FAILED
            assertEquals(phase, ApkInstallResultReceiver.accept(context, callback(record, status)).phase)
            val before = stored()
            ApkInstallResultReceiver.accept(context, callback(record, status)); assertContentEquals(before, stored())
        }
        AndroidApkInstallStore(context).use { assertEquals(7, ApkInstallJournal(it).snapshot().size) }
    }

    @Test fun malformed_route_digest_session_package_or_status_never_changes_original_bytes() {
        val record = committing(); val valid = callback(record, PackageInstaller.STATUS_SUCCESS); val before = stored()
        val invalid = listOf(
            Intent(valid).setAction("other"),
            Intent(valid).setComponent(null),
            Intent(valid).setData(valid.data!!.buildUpon().appendQueryParameter("request", "other").build()),
            Intent(valid).setData(valid.data!!.buildUpon().fragment("other").build()),
            Intent(valid).setData(valid.data!!.buildUpon().path("/update-one/${pin('0')}/17").build()),
            Intent(valid).putExtra(PackageInstaller.EXTRA_SESSION_ID, 18),
            Intent(valid).apply { removeExtra(PackageInstaller.EXTRA_SESSION_ID) },
            Intent(valid).putExtra(PackageInstaller.EXTRA_PACKAGE_NAME, "example.other"),
            Intent(valid).putExtra(PackageInstaller.EXTRA_STATUS, 999),
            Intent(valid).apply { removeExtra(PackageInstaller.EXTRA_STATUS) },
        )
        for (intent in invalid) {
            fault("apk_install_result_mismatch") { ApkInstallResultReceiver.accept(context, intent) }
            assertContentEquals(before, stored())
        }
    }

    @Test fun conflicting_late_result_and_result_before_commit_are_rejected_without_rewriting() {
        val record = committing()
        ApkInstallResultReceiver.accept(context, callback(record, PackageInstaller.STATUS_SUCCESS))
        val before = stored()
        fault("apk_install_result_conflict") { ApkInstallResultReceiver.accept(context, callback(record, PackageInstaller.STATUS_FAILURE)) }
        assertContentEquals(before, stored())
        // 另一个独立存储夹具验证提交前回执，不能靠早来的成功跳过意图提交。
        val memory = object : ApkInstallStorage {
            var bytes: ByteArray? = null
            override fun read() = bytes
            override fun compareAndSet(expected: ByteArray?, updated: ByteArray): Boolean { bytes = updated; return true }
        }
        val journal = ApkInstallJournal(memory); val p = plan("before-commit")
        journal.prepare(p); journal.createSession(p.requestId, {}, { 99 })
        fault("apk_install_result_conflict") { journal.systemResult(p.requestId, 99, ApkSystemResult.INSTALLED) }
        assertEquals(ApkInstallPhase.CREATED, journal.snapshot().single().phase)
    }

    @Test fun storage_version_failure_leaves_original_file_and_result_unresolved() {
        val record = committing()
        val path = context.getDatabasePath("tv-apk-install.db")
        android.database.sqlite.SQLiteDatabase.openDatabase(path.path, null, android.database.sqlite.SQLiteDatabase.OPEN_READWRITE).use { it.version = 2 }
        val before = path.readBytes()
        assertEquals("apk_install_storage_version", assertFailsWith<AgentStoreFault> { ApkInstallResultReceiver.accept(context, callback(record, PackageInstaller.STATUS_SUCCESS)) }.code)
        assertContentEquals(before, path.readBytes())
    }

    @Test fun runtime_refuses_a_new_connection_before_creating_a_permit_for_unverified_installation() {
        val record = committing()
        ApkInstallResultReceiver.accept(context, callback(record, PackageInstaller.STATUS_SUCCESS))
        val runtime = AgentRuntime(context)
        var finished = 0
        runtime.start { finished++ }
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, finished); assertFalse(runtime.running)
        assertEquals("stopped", runtime.screen.status)
        assertTrue(runtime.screen.notice.contains("原更新任务"))
        assertEquals(ApkInstallPhase.INSTALLED_UNVERIFIED, AndroidApkInstallStore(context).use { ApkInstallJournal(it).snapshot().single().phase })
    }

    @Test fun runtime_refuses_future_update_database_without_replacing_original_data() {
        committing()
        val path = context.getDatabasePath("tv-apk-install.db")
        android.database.sqlite.SQLiteDatabase.openDatabase(path.path, null, android.database.sqlite.SQLiteDatabase.OPEN_READWRITE).use { it.version = 2 }
        val before = path.readBytes(); val runtime = AgentRuntime(context); var finished = 0
        runtime.start { finished++ }
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, finished); assertFalse(runtime.running)
        assertEquals("apk_install_storage_version", runtime.screen.notice)
        assertContentEquals(before, path.readBytes())
    }
}
