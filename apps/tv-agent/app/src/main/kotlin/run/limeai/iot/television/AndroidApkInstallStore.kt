package run.limeai.iot.television

import android.content.ContentValues
import android.content.Context
import android.database.DatabaseErrorHandler
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import run.limeai.iot.device.ApkInstallJournal
import run.limeai.iot.device.ApkInstallStorage

/** 独立APK安装账本；不迁移身份库，不存材料、私钥或系统确认Intent。 */
class AndroidApkInstallStore(context: Context) : ApkInstallStorage, AutoCloseable {
    private var frozen = false
    private val helper = object : SQLiteOpenHelper(context, "tv-apk-install.db", null, 1,
        DatabaseErrorHandler { throw AgentStoreFault("apk_install_storage_corrupt") }) {
        override fun onConfigure(db: SQLiteDatabase) {
            if (db.version !in 0..1) throw AgentStoreFault("apk_install_storage_version")
            db.rawQuery("PRAGMA journal_mode=DELETE", null).use { if (!it.moveToFirst() || it.getString(0) != "delete") throw AgentStoreFault() }
            db.execSQL("PRAGMA synchronous=FULL")
            db.rawQuery("PRAGMA synchronous", null).use { if (!it.moveToFirst() || it.getInt(0) != 2) throw AgentStoreFault() }
        }
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("CREATE TABLE install_journal (slot INTEGER PRIMARY KEY CHECK(slot=1), document BLOB NOT NULL)")
        }
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) { throw AgentStoreFault("apk_install_storage_version") }
        override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) { throw AgentStoreFault("apk_install_storage_version") }
    }

    private fun usable() { if (frozen) throw AgentStoreFault("apk_install_storage_reopen_required") }
    private fun read(db: SQLiteDatabase): ByteArray? = db.rawQuery("SELECT document FROM install_journal WHERE slot=1", null).use {
        if (!it.moveToFirst()) null else it.getBlob(0).also { bytes -> if (bytes.size > ApkInstallJournal.MAX_BYTES) throw AgentStoreFault("apk_install_storage_corrupt") }
    }
    @Synchronized override fun read(): ByteArray? { usable(); return read(helper.writableDatabase) }

    @Synchronized override fun compareAndSet(expected: ByteArray?, updated: ByteArray): Boolean {
        usable()
        if (updated.isEmpty() || updated.size > ApkInstallJournal.MAX_BYTES) throw AgentStoreFault("apk_install_storage_corrupt")
        val db = helper.writableDatabase
        var attempted = false
        db.beginTransaction()
        try {
            val current = read(db)
            if (current == null && expected != null || current != null && (expected == null || !current.contentEquals(expected))) return false
            val values = ContentValues().apply { put("document", updated) }
            attempted = true
            if (current == null) { values.put("slot", 1); db.insertOrThrow("install_journal", null, values) }
            else if (db.update("install_journal", values, "slot=1", null) != 1) throw AgentStoreFault()
            db.setTransactionSuccessful()
            return true
        } catch (failure: Exception) { if (attempted) frozen = true; throw failure }
        finally {
            try { db.endTransaction() }
            catch (failure: Exception) { if (attempted) frozen = true; throw failure }
        }
    }
    @Synchronized override fun close() { helper.close() }
}
