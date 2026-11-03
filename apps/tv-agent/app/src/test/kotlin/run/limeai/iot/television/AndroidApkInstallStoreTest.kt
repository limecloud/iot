package run.limeai.iot.television

import android.app.Application
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import run.limeai.iot.device.*
import java.nio.file.Files
import kotlin.test.*

/** 宿主实际SQLite与事务；未运行PackageInstaller、AndroidKeyStore或真实电视。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class AndroidApkInstallStoreTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private fun fingerprint(c: Char) = "sha256:" + c.toString().repeat(64)
    private fun plan(id: String = "update-one") = ApkInstallPlan(id, "space-demo/device-tv/${fingerprint('a')}", fingerprint('b'), fingerprint('c'), fingerprint('d'), 3, 4, 12345, fingerprint('e'), fingerprint('f'))
    private fun database() = SQLiteDatabase.openDatabase(context.getDatabasePath("tv-apk-install.db").path, null, SQLiteDatabase.OPEN_READWRITE)
    private fun fault(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<DeviceFault>(block = block).code)

    @Test fun native_sqlite_reopens_original_record_and_checks_cas_across_instances() {
        AndroidApkInstallStore(context).use { first ->
            AndroidApkInstallStore(context).use { second ->
                val original = ApkInstallJournal(first); val stale = ApkInstallJournal(second)
                original.prepare(plan())
                // synchronous为连接级属性，检查生产存储实际使用的连接。
                val helper = AndroidApkInstallStore::class.java.getDeclaredField("helper").apply { isAccessible = true }.get(first) as SQLiteOpenHelper
                helper.writableDatabase.rawQuery("PRAGMA synchronous", null).use { assertTrue(it.moveToFirst()); assertEquals(2, it.getInt(0)) }
                helper.writableDatabase.rawQuery("PRAGMA journal_mode", null).use { assertTrue(it.moveToFirst()); assertEquals("delete", it.getString(0)) }
                fault("apk_install_storage_conflict") { stale.prepare(plan("stale")) }
                assertTrue(stale.blocked)
                fault("apk_install_storage_reopen_required") { stale.createSession("stale", {}, { fail("no create") }) }
            }
        }
        AndroidApkInstallStore(context).use {
            val record = ApkInstallJournal(it).snapshot().single()
            assertEquals(plan(), record.plan); assertEquals(ApkInstallPhase.PREPARED, record.phase)
        }
        database().use { db ->
            assertEquals(1, db.version)
        }
    }

    @Test fun actual_sqlite_abort_before_intent_is_zero_session_creation_and_preserves_original() {
        AndroidApkInstallStore(context).use { storage ->
            val journal = ApkInstallJournal(storage); journal.prepare(plan())
            database().use { it.execSQL("CREATE TRIGGER fail_intent BEFORE UPDATE ON install_journal BEGIN SELECT RAISE(ABORT,'injected'); END") }
            fault("apk_install_storage_unavailable") { journal.createSession("update-one", {}, { fail("intent must commit first") }) }
            assertTrue(journal.blocked)
            assertEquals("apk_install_storage_reopen_required", assertFailsWith<AgentStoreFault> { storage.read() }.code)
        }
        AndroidApkInstallStore(context).use { assertEquals(ApkInstallPhase.PREPARED, ApkInstallJournal(it).snapshot().single().phase) }
    }

    @Test fun durable_commit_followed_by_lost_return_reopens_intent_without_recreating_session() {
        AndroidApkInstallStore(context).use { storage ->
            val journal = ApkInstallJournal(storage); journal.prepare(plan())
            val losingReturn = object : ApkInstallStorage {
                override fun read() = storage.read()
                override fun compareAndSet(expected: ByteArray?, updated: ByteArray): Boolean {
                    assertTrue(storage.compareAndSet(expected, updated))
                    error("injected loss after real SQLite transaction")
                }
            }
            val uncertain = ApkInstallJournal(losingReturn)
            fault("apk_install_storage_unavailable") { uncertain.createSession("update-one", {}, { fail("write response failed before create") }) }
        }
        AndroidApkInstallStore(context).use { storage ->
            val reopened = ApkInstallJournal(storage)
            assertEquals(ApkInstallPhase.CREATING, reopened.snapshot().single().phase)
            reopened.createSession("update-one", {}, { fail("cannot recreate") })
            assertEquals(ApkInstallPhase.CREATING, reopened.resolveCreation("update-one", emptyList()).phase)
        }
    }

    @Test fun system_result_and_pending_confirmation_survive_store_reopen_without_automatic_installation() {
        val p = plan()
        AndroidApkInstallStore(context).use {
            val journal = ApkInstallJournal(it); journal.prepare(p)
            journal.createSession(p.requestId, {}, { 17 }); journal.staged(p.requestId, 17, p.candidateSha256, p.candidateBytes)
            journal.commit(p.requestId, {}, { _, _ -> })
            journal.systemResult(p.requestId, 17, ApkSystemResult.PENDING_USER_ACTION)
        }
        AndroidApkInstallStore(context).use {
            val journal = ApkInstallJournal(it)
            assertEquals(ApkInstallPhase.PENDING_USER, journal.snapshot().single().phase)
            journal.commit(p.requestId, { fail("query cannot resubmit") }, { _, _ -> fail("duplicate") })
            journal.systemResult(p.requestId, 17, ApkSystemResult.INSTALLED)
        }
        AndroidApkInstallStore(context).use {
            val journal = ApkInstallJournal(it)
            assertEquals(ApkInstallPhase.INSTALLED_UNVERIFIED, journal.snapshot().single().phase)
            fault("apk_install_in_progress") { journal.prepare(plan("other")) }
        }
    }

    @Test fun future_database_version_and_corrupt_document_refuse_without_resetting_original() {
        AndroidApkInstallStore(context).use { ApkInstallJournal(it).prepare(plan()) }
        val before = AndroidApkInstallStore(context).use { it.read()!! }
        database().use { it.version = 2 }
        AndroidApkInstallStore(context).use {
            assertEquals("apk_install_storage_version", assertFailsWith<AgentStoreFault> { it.read() }.code)
        }
        database().use { db ->
            assertEquals(2, db.version)
            db.rawQuery("SELECT document FROM install_journal", null).use { assertTrue(it.moveToFirst()); assertContentEquals(before, it.getBlob(0)) }
            db.version = 1
            db.execSQL("UPDATE install_journal SET document=?", arrayOf("{\"schema_version\":4,\"operations\":[]}".toByteArray()))
        }
        val corrupt = AndroidApkInstallStore(context).use { it.read()!! }
        AndroidApkInstallStore(context).use { fault("apk_install_storage_corrupt") { ApkInstallJournal(it) } }
        AndroidApkInstallStore(context).use { assertContentEquals(corrupt, it.read()) }
    }

    @Test fun corrupt_sqlite_file_is_not_deleted_or_replaced_by_android_helper() {
        AndroidApkInstallStore(context).use { ApkInstallJournal(it).prepare(plan()) }
        val file = context.getDatabasePath("tv-apk-install.db").toPath()
        val corrupt = Files.readAllBytes(file).apply { for (index in 0..15) this[index] = 0x7f }
        Files.write(file, corrupt)
        AndroidApkInstallStore(context).use { assertFails { it.read() } }
        assertContentEquals(corrupt, Files.readAllBytes(file))
    }

    @Test fun separate_update_store_does_not_touch_original_identity_grants_or_command_journal() {
        // 仅检查数据库隔离，vault为宿主替身，不形成Keystore或密码保护证据。
        val vault = object : EnrollmentVault {
            override fun seal(bytes: ByteArray, binding: String) = bytes.copyOf()
            override fun open(bytes: ByteArray, binding: String) = bytes.copyOf()
        }
        val credentials = Fixtures.enrollment
        AndroidAgentStore(context, vault).use {
            it.install(credentials); it.authorize("com.example.player", true)
            it.journal(credentials.binding).commit("original-confirmed-unknown-high-watermark".toByteArray())
        }
        val original = context.getDatabasePath("tv-agent.db").toPath()
        val bytes = Files.readAllBytes(original)
        AndroidApkInstallStore(context).use {
            val journal = ApkInstallJournal(it); journal.prepare(plan()); journal.cancelPrepared("update-one")
        }
        assertContentEquals(bytes, Files.readAllBytes(original))
        AndroidAgentStore(context, vault).use {
            assertEquals(credentials.binding, it.load()!!.binding)
            assertEquals(setOf("com.example.player"), it.allowed())
            assertContentEquals("original-confirmed-unknown-high-watermark".toByteArray(), it.journal(credentials.binding).read())
        }
    }
}
