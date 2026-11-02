package run.limeai.iot.television

import android.content.ContentValues
import android.content.Context
import android.database.DatabaseErrorHandler
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import run.limeai.iot.device.DeviceEnrollment
import run.limeai.iot.device.DeviceStorage
import run.limeai.iot.device.DeviceModelProfile
import run.limeai.iot.device.DeviceJournalMigration
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class AgentStoreFault(val code: String = "storage_unavailable") : Exception(code)

/** Keystore与数据库分别可验证；测试替身不能当作真实Keystore证据。 */
interface EnrollmentVault {
    fun seal(bytes: ByteArray, binding: String): ByteArray
    fun open(bytes: ByteArray, binding: String): ByteArray
}

class AndroidEnrollmentVault : EnrollmentVault {
    private val alias = "limeiot-tv-enrollment-v1"
    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(alias, null)
        if (existing is SecretKey) return existing
        if (!create || store.containsAlias(alias)) throw AgentStoreFault("credentials_unavailable")
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    override fun seal(bytes: ByteArray, binding: String): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(true)); cipher.updateAAD(binding.toByteArray(Charsets.UTF_8))
        if (cipher.iv.size != 12) throw AgentStoreFault("credentials_unavailable")
        return byteArrayOf(1) + cipher.iv + cipher.doFinal(bytes)
    }
    override fun open(bytes: ByteArray, binding: String): ByteArray {
        if (bytes.size !in 30..65536 || bytes[0] != 1.toByte()) throw AgentStoreFault("credentials_unavailable")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        cipher.updateAAD(binding.toByteArray(Charsets.UTF_8))
        return cipher.doFinal(bytes.copyOfRange(13, bytes.size))
    }
}

/** 单设备私有数据库；耐久提交失败一律向上抛出，核心自行阻断并重开读取。 */
class AndroidAgentStore(context: Context, private val vault: EnrollmentVault = AndroidEnrollmentVault()) : AutoCloseable {
    private val helper = object : SQLiteOpenHelper(context, "tv-agent.db", null, 1,
        DatabaseErrorHandler { throw AgentStoreFault("storage_corrupt") }) {
        override fun onConfigure(db: SQLiteDatabase) {
            if (db.version !in 0..1) throw AgentStoreFault("storage_version")
            db.setForeignKeyConstraintsEnabled(true)
            db.rawQuery("PRAGMA journal_mode=DELETE", null).use { if (!it.moveToFirst() || it.getString(0) != "delete") throw AgentStoreFault() }
            db.execSQL("PRAGMA synchronous=FULL")
            db.rawQuery("PRAGMA synchronous", null).use { if (!it.moveToFirst() || it.getInt(0) != 2) throw AgentStoreFault() }
        }
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("CREATE TABLE agent (slot INTEGER PRIMARY KEY CHECK(slot=1), binding TEXT NOT NULL, credentials BLOB NOT NULL, journal BLOB)")
            db.execSQL("CREATE TABLE applications (package TEXT PRIMARY KEY, slot INTEGER NOT NULL DEFAULT 1 REFERENCES agent(slot))")
        }
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) { throw AgentStoreFault("storage_version") }
        override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) { throw AgentStoreFault("storage_version") }
    }

    private fun binding(db: SQLiteDatabase): String? = db.rawQuery("SELECT binding FROM agent WHERE slot=1", null)
        .use { if (it.moveToFirst()) it.getString(0) else null }

    @Synchronized fun load(): DeviceEnrollment? {
        val db = helper.writableDatabase
        return db.rawQuery("SELECT binding, credentials FROM agent WHERE slot=1", null).use {
            if (!it.moveToFirst()) return@use null
            val binding = it.getString(0); val plain = vault.open(it.getBlob(1), binding)
            try { DeviceEnrollment.parse(plain).also { enrollment -> if (enrollment.binding != binding) throw AgentStoreFault("identity_mismatch") } }
            finally { plain.fill(0) }
        }
    }

    /** 仅在本机确认且连接已停止后调用；同身份换证不触碰回执和应用授权。 */
    @Synchronized fun install(enrollment: DeviceEnrollment) {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val old = binding(db)
            if (old != null && old != enrollment.binding) throw AgentStoreFault("identity_change_refused")
            val previous = if (old == null) null else load() ?: throw AgentStoreFault("credentials_unavailable")
            val transition = previous?.identity?.profile != enrollment.identity.profile
            if (previous != null && transition && previous.identity.profile != DeviceModelProfile.APPLICATIONS) throw AgentStoreFault("model_rollback_refused")
            val migrated = if (transition && enrollment.identity.profile == DeviceModelProfile.COMPOSED_REMOTE)
                DeviceJournalMigration.prepare(enrollment.identity, if (old == null) null else readJournal(old)) else null
            val plain = enrollment.encoded()
            val encrypted = try { vault.seal(plain, enrollment.binding) } finally { plain.fill(0) }
            val values = ContentValues().apply { put("binding", enrollment.binding); put("credentials", encrypted) }
            if (migrated != null) values.put("journal", migrated)
            if (old == null) { values.put("slot", 1); db.insertOrThrow("agent", null, values) }
            else if (db.update("agent", values, "slot=1 AND binding=?", arrayOf(old)) != 1) throw AgentStoreFault()
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    fun journal(binding: String): DeviceStorage = object : DeviceStorage {
        override fun read(): ByteArray? = readJournal(binding)
        override fun commit(bytes: ByteArray) = writeJournal(binding, bytes)
    }
    @Synchronized private fun readJournal(expected: String): ByteArray? {
        val db = helper.writableDatabase
        return db.rawQuery("SELECT binding, journal FROM agent WHERE slot=1", null).use {
            if (!it.moveToFirst() || it.getString(0) != expected) throw AgentStoreFault("identity_mismatch")
            if (it.isNull(1)) null else it.getBlob(1).also { bytes -> if (bytes.size > 1048576) throw AgentStoreFault("storage_corrupt") }
        }
    }
    @Synchronized private fun writeJournal(expected: String, bytes: ByteArray) {
        if (bytes.isEmpty() || bytes.size > 1048576) throw AgentStoreFault()
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            if (db.update("agent", ContentValues().apply { put("journal", bytes) }, "slot=1 AND binding=?", arrayOf(expected)) != 1) throw AgentStoreFault("identity_mismatch")
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
    @Synchronized fun allowed(): Set<String> {
        val db = helper.writableDatabase
        return db.rawQuery("SELECT package FROM applications ORDER BY package", null).use {
            val packages = linkedSetOf<String>()
            while (it.moveToNext()) {
                if (packages.size >= 128) throw AgentStoreFault("storage_corrupt")
                packages += it.getString(0)
            }
            packages
        }
    }
    @Synchronized fun authorize(packageName: String, allow: Boolean) {
        if (packageName.length > 255 || !Regex("[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)+").matches(packageName)) throw AgentStoreFault("invalid_application")
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            if (binding(db) == null) throw AgentStoreFault("credentials_unavailable")
            if (allow) {
                if (packageName !in allowed() && allowed().size >= 128) throw AgentStoreFault("capacity_exceeded")
                db.insertWithOnConflict("applications", null, ContentValues().apply { put("package", packageName); put("slot", 1) }, SQLiteDatabase.CONFLICT_IGNORE).also {
                    if (it == -1L && packageName !in allowed()) throw AgentStoreFault()
                }
            } else db.delete("applications", "package=?", arrayOf(packageName))
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
    @Synchronized override fun close() { helper.close() }
}
