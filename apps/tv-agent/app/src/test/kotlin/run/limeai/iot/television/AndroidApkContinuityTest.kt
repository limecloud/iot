package run.limeai.iot.television

import android.app.Application
import android.database.sqlite.SQLiteDatabase
import kotlinx.serialization.json.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import run.limeai.iot.device.*
import kotlin.test.*

/** 实际宿主SQLite与正式解析器；明文Vault是夹具，不声称AndroidKeyStore连续性。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class AndroidApkContinuityTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private var opens = 0
    private val vault = object : EnrollmentVault {
        override fun seal(bytes: ByteArray, binding: String) = bytes.copyOf()
        override fun open(bytes: ByteArray, binding: String): ByteArray { opens++; return bytes.copyOf() }
    }
    private fun store() = AndroidAgentStore(context, vault)
    private fun database() = SQLiteDatabase.openDatabase(context.getDatabasePath("tv-agent.db").absolutePath, null, SQLiteDatabase.OPEN_READWRITE)
    private fun install(): ByteArray {
        val bytes = ApkJournalFixture.bytes(Fixtures.enrollment.identity)
        store().use { it.install(Fixtures.enrollment); it.authorize("com.example.player", true); it.journal(Fixtures.enrollment.binding).commit(bytes) }
        return bytes
    }

    @Test fun snapshot_binds_exact_original_bytes_and_authorizations_without_rewriting_the_database() {
        val original = install()
        val first = store().use {
            it.allowed() // 将既有打开/配置过程与本次只读事务分别观察。
            val before = context.getDatabasePath("tv-agent.db").readBytes()
            val snapshot = it.apkContinuity()
            assertEquals(snapshot, it.apkContinuity())
            assertContentEquals(before, context.getDatabasePath("tv-agent.db").readBytes())
            snapshot
        }
        assertEquals(DeviceJournalInspection(9, 1, 1, 1, 1, false), first.journal)
        assertEquals(first, store().use { it.apkContinuity() })
        store().use {
            it.journal(first.binding).commit(" ".toByteArray() + original)
            val changed = it.apkContinuity()
            assertEquals(first.journal, changed.journal); assertNotEquals(first.digest, changed.digest)
            it.journal(first.binding).commit(original); assertEquals(first, it.apkContinuity())
            it.authorize("com.example.other", true); assertNotEquals(first.digest, it.apkContinuity().digest)
            assertContentEquals(original, it.journal(first.binding).read())
        }
    }

    @Test fun invalid_head_and_grant_are_refused_without_repair_or_partial_snapshot() {
        val original = install()
        val document = DeviceDocument.parse(original, 1048576, 32768)
        val invalid = JsonObject(document + ("high_watermark" to JsonPrimitive(0))).toString().toByteArray()
        store().use { it.journal(Fixtures.enrollment.binding).commit(invalid) }
        store().use {
            it.allowed()
            val before = context.getDatabasePath("tv-agent.db").readBytes()
            assertEquals("storage_corrupt", assertFailsWith<DeviceFault> { it.apkContinuity() }.code)
            assertContentEquals(before, context.getDatabasePath("tv-agent.db").readBytes())
            assertContentEquals(invalid, it.journal(Fixtures.enrollment.binding).read())
        }
        store().use { it.journal(Fixtures.enrollment.binding).commit(original) }
        database().use { it.execSQL("INSERT INTO applications(package,slot) VALUES('bad package',1)") }
        store().use { assertEquals("storage_corrupt", assertFailsWith<AgentStoreFault> { it.apkContinuity() }.code) }
        database().use { it.rawQuery("SELECT package FROM applications WHERE package='bad package'", null).use { rows -> assertTrue(rows.moveToFirst()) } }
    }

    @Test fun null_and_legacy_journals_remain_distinct_and_empty_unconfigured_store_has_no_binding() {
        store().use { assertEquals("credentials_unavailable", assertFailsWith<AgentStoreFault> { it.apkContinuity() }.code); it.install(Fixtures.enrollment) }
        val empty = store().use { it.apkContinuity() }
        assertEquals(0, empty.journal!!.entries)
        val legacy = ApkJournalFixture.bytes(Fixtures.enrollment.identity, 1)
        store().use {
            it.journal(empty.binding).commit(legacy)
            val snapshot = it.apkContinuity()
            assertEquals(4L, snapshot.journal!!.highWatermark); assertEquals(4, snapshot.journal!!.entries)
            assertNotEquals(empty.digest, snapshot.digest); assertContentEquals(legacy, it.journal(empty.binding).read())
        }
    }

    @Test fun oversized_original_material_is_refused_before_vault_open_without_modifying_it() {
        install()
        database().use { it.execSQL("UPDATE agent SET credentials=zeroblob(65537)") }
        opens = 0
        store().use {
            it.allowed()
            val before = context.getDatabasePath("tv-agent.db").readBytes()
            assertEquals("storage_corrupt", assertFailsWith<AgentStoreFault> { it.apkContinuity() }.code)
            assertContentEquals(before, context.getDatabasePath("tv-agent.db").readBytes())
        }
        assertEquals(0, opens)
    }
}
