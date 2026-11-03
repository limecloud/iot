package run.limeai.iot.television

import android.content.ContentValues
import android.content.Context
import android.database.DatabaseErrorHandler
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import run.limeai.iot.device.DeviceEnrollment
import run.limeai.iot.device.DeviceMaintenanceIdentity
import run.limeai.iot.device.DeviceIdentityMetadata
import run.limeai.iot.device.DeviceStorage
import run.limeai.iot.device.DeviceModelProfile
import run.limeai.iot.device.DeviceJournalMigration
import run.limeai.iot.device.DeviceIdentitySetup
import run.limeai.iot.device.DeviceDocument
import run.limeai.iot.device.DeviceRotationReceipt
import run.limeai.iot.device.DeviceRevocationProof
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID
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
class AndroidAgentStore(context: Context, private val vault: EnrollmentVault = AndroidEnrollmentVault(), private val keys: IdentityKeys = AndroidIdentityKeys()) : AutoCloseable {
    private var frozen = false
    private fun usable() { if (frozen) throw AgentStoreFault("storage_reopen_required") }
    private val helper = object : SQLiteOpenHelper(context, "tv-agent.db", null, 3,
        DatabaseErrorHandler { throw AgentStoreFault("storage_corrupt") }) {
        override fun onConfigure(db: SQLiteDatabase) {
            if (db.version !in 0..3) throw AgentStoreFault("storage_version")
            db.setForeignKeyConstraintsEnabled(true)
            db.rawQuery("PRAGMA journal_mode=DELETE", null).use { if (!it.moveToFirst() || it.getString(0) != "delete") throw AgentStoreFault() }
            db.execSQL("PRAGMA synchronous=FULL")
            db.rawQuery("PRAGMA synchronous", null).use { if (!it.moveToFirst() || it.getInt(0) != 2) throw AgentStoreFault() }
        }
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("CREATE TABLE agent (slot INTEGER PRIMARY KEY CHECK(slot=1), binding TEXT NOT NULL, credentials BLOB NOT NULL, journal BLOB)")
            db.execSQL("CREATE TABLE applications (package TEXT PRIMARY KEY, slot INTEGER NOT NULL DEFAULT 1 REFERENCES agent(slot))")
            createIdentity(db)
            createRotations(db)
        }
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            if (oldVersion !in 1..2 || newVersion != 3) throw AgentStoreFault("storage_version")
            if (oldVersion == 1) createIdentity(db)
            createRotations(db)
        }
        override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) { throw AgentStoreFault("storage_version") }
    }
    private fun createIdentity(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE identity (slot INTEGER PRIMARY KEY CHECK(slot=1), binding TEXT NOT NULL, document BLOB NOT NULL)")
    }
    private fun createRotations(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE rotations (number INTEGER PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, binding TEXT NOT NULL, document BLOB NOT NULL)")
    }

    private fun binding(db: SQLiteDatabase): String? = db.rawQuery("SELECT binding FROM agent WHERE slot=1", null)
        .use { if (it.moveToFirst()) it.getString(0) else null }

    @Synchronized fun load(): DeviceEnrollment? {
        usable()
        val db = helper.writableDatabase
        val enrollment = loadEnrollment(db)
        val record = readIdentity(db)
        if (record?.phase == "active") record.verify(enrollment ?: throw AgentStoreFault("identity_mismatch"), keys)
        else if (record != null && enrollment != null || enrollment?.keyReference != null) throw AgentStoreFault("identity_mismatch")
        readRotation(db)?.verify(enrollment ?: throw AgentStoreFault("identity_mismatch"), keys)
        return enrollment
    }

    private fun loadEnrollment(db: SQLiteDatabase): DeviceEnrollment? {
        return readCredentials(db) { DeviceEnrollment.parse(it, keys) }
    }

    private fun loadMaintenance(db: SQLiteDatabase): DeviceMaintenanceIdentity? = readCredentials(db) { DeviceEnrollment.maintenance(it, keys) }

    /** 仅维护读取；返回类型没有TLS能力，仍核对原持钥、身份记录与原轮换。 */
    @Synchronized fun maintenance(): DeviceMaintenanceIdentity? {
        usable()
        val db = helper.writableDatabase
        val current = loadMaintenance(db)
        val record = readIdentity(db)
        if (record?.phase == "active") record.verify(current ?: throw AgentStoreFault("identity_mismatch"), keys)
        else if (record != null && current != null || current?.keyReference != null) throw AgentStoreFault("identity_mismatch")
        readRotation(db)?.verify(current ?: throw AgentStoreFault("identity_mismatch"), keys)
        return current
    }

    private fun <T : DeviceIdentityMetadata> readCredentials(db: SQLiteDatabase, parse: (ByteArray) -> T): T? {
        return db.rawQuery("SELECT binding, credentials FROM agent WHERE slot=1", null).use {
            if (!it.moveToFirst()) return@use null
            val binding = it.getString(0); val plain = vault.open(it.getBlob(1), binding)
            try { parse(plain).also { enrollment -> if (enrollment.binding != binding) throw AgentStoreFault("identity_mismatch") } }
            finally { plain.fill(0) }
        }
    }

    /** 仅在本机确认且连接已停止后调用；同身份换证不触碰回执和应用授权。 */
    @Synchronized fun install(enrollment: DeviceEnrollment) {
        usable()
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            if (readIdentity(db) != null || readRotation(db) != null || enrollment.keyReference != null) throw AgentStoreFault("identity_request_required")
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

    private fun readIdentity(db: SQLiteDatabase): LocalIdentityRecord? = db.rawQuery("SELECT binding,document FROM identity WHERE slot=1", null).use {
        if (!it.moveToFirst()) return@use null
        val binding = it.getString(0)
        val plain = vault.open(it.getBlob(1), "tv-identity-v1/$binding")
        try { LocalIdentityRecord.parse(plain).also { record -> if (record.setup.binding != binding) throw AgentStoreFault("identity_mismatch") } }
        finally { plain.fill(0) }
    }

    /** 只在可能写入后冻结；输入拒绝和未写入的原决定查询不会要求重开。 */
    private fun <T> identityTransaction(block: (SQLiteDatabase, () -> Unit) -> T): T {
        usable()
        val db = helper.writableDatabase
        var attempted = false
        db.beginTransaction()
        try {
            val result = block(db) { attempted = true }
            db.setTransactionSuccessful()
            return result
        } catch (error: Exception) { if (attempted) frozen = true; throw error }
        finally {
            try { db.endTransaction() }
            catch (error: Exception) { if (attempted) frozen = true; throw error }
        }
    }

    private fun saveIdentity(db: SQLiteDatabase, record: LocalIdentityRecord, insert: Boolean, writing: () -> Unit) {
        writing()
        val plain = record.encoded()
        val encrypted = try { vault.seal(plain, "tv-identity-v1/${record.setup.binding}") } finally { plain.fill(0) }
        val values = ContentValues().apply { put("binding", record.setup.binding); put("document", encrypted) }
        if (insert) { values.put("slot", 1); db.insertOrThrow("identity", null, values) }
        else if (db.update("identity", values, "slot=1", null) != 1) throw AgentStoreFault("identity_mismatch")
    }

    @Synchronized fun identityRequest(): IdentityRequestView? {
        usable()
        val db = helper.writableDatabase
        val record = readIdentity(db) ?: return null
        val enrollment = loadMaintenance(db)
        if (record.phase == "active") record.verify(enrollment ?: throw AgentStoreFault("identity_mismatch"), keys)
        else if (enrollment != null) throw AgentStoreFault("identity_mismatch")
        return record.view(keys)
    }

    /** 同一原请求恢复；KeyStore不参与SQL事务，creating恢复只读已有键。 */
    @Synchronized fun requestIdentity(setup: DeviceIdentitySetup): IdentityRequestView {
        var record = identityTransaction { db, writing ->
            val original = readIdentity(db)
            if (original == null) {
                if (binding(db) != null) throw AgentStoreFault("identity_rotation_required")
                LocalIdentityRecord(setup, "limeiot-tv-identity-" + UUID.randomUUID().toString().replace("-", ""), "prepared")
                    .also { saveIdentity(db, it, true, writing) }
            } else {
                if (!original.setup.encoded().contentEquals(setup.encoded())) throw AgentStoreFault("identity_request_conflict")
                if (original.phase == "active") original.verify(loadEnrollment(db) ?: throw AgentStoreFault("identity_mismatch"), keys)
                else if (binding(db) != null) throw AgentStoreFault("identity_mismatch")
                original
            }
        }
        var create = false
        if (record.phase == "prepared") {
            record = identityTransaction { db, writing ->
                val current = readIdentity(db) ?: throw AgentStoreFault("identity_mismatch")
                if (!current.encoded().contentEquals(record.encoded()) || binding(db) != null) throw AgentStoreFault("identity_request_conflict")
                current.copy(phase = "creating").also { saveIdentity(db, it, false, writing) }
            }
            create = true
        }
        if (record.phase == "creating") {
            try {
                val key = if (create) keys.create(record.reference) else keys.load(record.reference)
                val csr = key.certificateRequest(record.setup.identity)
                val pending = record.copy(phase = "pending", csr = csr.pem, csrSha256 = csr.csrSha256, publicKeyFingerprint = csr.publicKeyFingerprint)
                identityTransaction { db, writing ->
                    val current = readIdentity(db) ?: throw AgentStoreFault("identity_mismatch")
                    if (!current.encoded().contentEquals(record.encoded()) || binding(db) != null) throw AgentStoreFault("identity_request_conflict")
                    saveIdentity(db, pending, false, writing)
                }
                // 交付前回读实际已提交的原CSR；回读失败也不得继续使用当前对象。
                return identityRequest() ?: throw AgentStoreFault("identity_mismatch")
            } catch (error: Exception) { frozen = true; throw error }
        }
        return identityRequest() ?: throw AgentStoreFault("identity_mismatch")
    }

    @Synchronized fun previewCertificate(certificate: ByteArray): DeviceEnrollment {
        usable()
        val record = readIdentity(helper.writableDatabase) ?: throw AgentStoreFault("identity_request_required")
        return record.enrollment(certificate, keys)
    }

    private fun readRotation(db: SQLiteDatabase, requestId: String? = null): LocalRotationRecord? {
        val sql = if (requestId == null) "SELECT request_id,binding,document FROM rotations ORDER BY number DESC LIMIT 1" else "SELECT request_id,binding,document FROM rotations WHERE request_id=?"
        return db.rawQuery(sql, requestId?.let { arrayOf(it) }).use {
            if (!it.moveToFirst()) return@use null
            val binding = it.getString(1); val plain = vault.open(it.getBlob(2), "tv-rotation-v1/$binding")
            try { LocalRotationRecord.parse(plain).also { record -> if (record.candidate.setup.binding != binding || record.candidate.setup.requestId != it.getString(0)) throw AgentStoreFault("identity_mismatch") } }
            finally { plain.fill(0) }
        }
    }

    private fun saveRotation(db: SQLiteDatabase, record: LocalRotationRecord, insert: Boolean, writing: () -> Unit) {
        if (insert) db.rawQuery("SELECT count(*) FROM rotations", null).use { it.moveToFirst(); if (it.getInt(0) >= 128) throw AgentStoreFault("capacity_exceeded") }
        val plain = record.encoded(); val binding = record.candidate.setup.binding
        if (plain.size > 32768) { plain.fill(0); throw AgentStoreFault("capacity_exceeded") }
        writing()
        val encrypted = try { vault.seal(plain, "tv-rotation-v1/$binding") } finally { plain.fill(0) }
        val values = ContentValues().apply { put("request_id", record.candidate.setup.requestId); put("binding", binding); put("document", encrypted) }
        if (insert) {
            db.insertOrThrow("rotations", null, values)
        } else if (db.update("rotations", values, "request_id=? AND binding=?", arrayOf(record.candidate.setup.requestId, binding)) != 1) throw AgentStoreFault("identity_mismatch")
    }

    @Synchronized fun rotationRequest(): RotationRequestView? {
        usable()
        val record = readRotation(helper.writableDatabase) ?: return null
        record.verify(maintenance() ?: throw AgentStoreFault("credentials_unavailable"), keys)
        return record.view(keys)
    }

    /** 保留原身份；与初次接入相同，先提交唯一引用与建钥尝试，恢复不补建。 */
    @Synchronized fun requestRotation(requestId: String): RotationRequestView = requestKeyChange(requestId, false)

    @Synchronized fun requestExpiredRecovery(requestId: String): RotationRequestView = requestKeyChange(requestId, true)

    private fun requestKeyChange(requestId: String, recovery: Boolean): RotationRequestView {
        var record = identityTransaction { db, writing ->
            val current = maintenance() ?: throw AgentStoreFault("credentials_unavailable")
            val original = readRotation(db, requestId)
            if (original != null) {
                original.verify(current, keys)
                if (original.expiredRecovery == recovery) {
                    if (!recovery && current.expired && original.candidate.phase != "active") throw AgentStoreFault("expired_identity_requires_recovery")
                    original
                } else if (recovery && current.expired && !original.expiredRecovery && original.candidate.phase != "active") {
                    // 仅明确进入维护；候选、原CSR与密钥引用完整保留，不产生新请求。
                    original.copy(version = 3, recoveryOrigin = "pending_rotation", previousReference = current.keyReference,
                        previousCertificatePem = current.publicCertificate().toString(Charsets.US_ASCII)).also { saveRotation(db, it, false, writing) }
                } else throw AgentStoreFault("identity_request_conflict")
            }
            else {
                val latest = readRotation(db)
                if (latest != null && (latest.candidate.phase != "active" || latest.receipt?.managementCompleted != true)) throw AgentStoreFault("rotation_in_progress")
                if (requestId == current.identityRequestId) throw AgentStoreFault("identity_request_conflict")
                if (recovery != current.expired) throw AgentStoreFault(if (recovery) "identity_not_expired" else "expired_identity_requires_recovery")
                val setup = current.setupForRequest(requestId)
                LocalRotationRecord(LocalIdentityRecord(setup, "limeiot-tv-identity-" + UUID.randomUUID().toString().replace("-", ""), "prepared"), current.certificateSerial, current.certificateFingerprint, current.publicKeyFingerprint,
                    version = if (recovery) 3 else 2, previousReference = current.keyReference, previousCertificatePem = current.publicCertificate().toString(Charsets.US_ASCII),
                    recoveryOrigin = if (recovery) "expired_identity" else null)
                    .also { saveRotation(db, it, true, writing) }
            }
        }
        var create = false
        if (record.candidate.phase == "prepared") {
            record = identityTransaction { db, writing ->
                val current = readRotation(db) ?: throw AgentStoreFault("identity_mismatch")
                if (!current.encoded().contentEquals(record.encoded())) throw AgentStoreFault("identity_request_conflict")
                current.verify(maintenance() ?: throw AgentStoreFault("credentials_unavailable"), keys)
                current.copy(candidate = current.candidate.copy(phase = "creating")).also { saveRotation(db, it, false, writing) }
            }
            create = true
        }
        if (record.candidate.phase == "creating") {
            try {
                val key = if (create) keys.create(record.candidate.reference) else keys.load(record.candidate.reference)
                if (key.publicKeyFingerprint == record.previousPublicKey) throw AgentStoreFault("rotation_new_key_required")
                val request = key.certificateRequest(record.candidate.setup.identity)
                identityTransaction { db, writing ->
                    val original = readRotation(db) ?: throw AgentStoreFault("identity_mismatch")
                    if (!original.encoded().contentEquals(record.encoded())) throw AgentStoreFault("identity_request_conflict")
                    original.verify(maintenance() ?: throw AgentStoreFault("credentials_unavailable"), keys)
                    saveRotation(db, original.copy(candidate = original.candidate.copy(phase = "pending", csr = request.pem, csrSha256 = request.csrSha256, publicKeyFingerprint = request.publicKeyFingerprint)), false, writing)
                }
                return rotationRequest() ?: throw AgentStoreFault("identity_mismatch")
            } catch (error: Exception) { frozen = true; throw error }
        }
        return record.view(keys)
    }

    @Synchronized fun previewRotation(certificate: ByteArray, receipt: DeviceRotationReceipt): RotationCandidate {
        usable()
        val record = readRotation(helper.writableDatabase) ?: throw AgentStoreFault("identity_request_required")
        val current = maintenance() ?: throw AgentStoreFault("credentials_unavailable")
        record.verify(current, keys)
        if (current.expired && !record.expiredRecovery) throw AgentStoreFault("expired_identity_requires_recovery")
        val enrollment = record.candidate.enrollment(certificate, keys)
        receipt.verify(record.candidate.setup, record.candidate.view(keys).request!!, record.previousSerial, record.previousCertificate, enrollment, record.expiredRecovery, record.preservesRotation)
        if (record.candidate.phase != "active" && !receipt.awaitingActivation(record.expiredRecovery)) throw AgentStoreFault("rotation_receipt_mismatch")
        if (record.receipt != null && record.receipt.requestDigest != receipt.requestDigest) throw AgentStoreFault("rotation_receipt_mismatch")
        return RotationCandidate(enrollment, receipt)
    }

    /** 原证书留到切换事务；凭据、当前请求及轮换决定同事务提交，原日志与授权零改写。 */
    @Synchronized fun activateRotation(candidate: RotationCandidate) {
        val document = DeviceDocument.parse(candidate.enrollment.encoded(), 32768)
        val certificate = (document["certificate_pem"] as? JsonPrimitive)?.content?.toByteArray(Charsets.US_ASCII) ?: throw AgentStoreFault("invalid_certificate")
        previewRotation(certificate, candidate.receipt)
        identityTransaction { db, writing ->
            val checked = previewRotation(certificate, candidate.receipt)
            if (!checked.enrollment.encoded().contentEquals(candidate.enrollment.encoded())) throw AgentStoreFault("identity_mismatch")
            val record = readRotation(db) ?: throw AgentStoreFault("identity_mismatch")
            if (record.candidate.phase == "active") return@identityTransaction
            if (record.candidate.phase != "pending") throw AgentStoreFault("identity_request_not_ready")
            writing()
            val plain = candidate.enrollment.encoded()
            val encrypted = try { vault.seal(plain, candidate.enrollment.binding) } finally { plain.fill(0) }
            if (db.update("agent", ContentValues().apply { put("credentials", encrypted) }, "slot=1 AND binding=?", arrayOf(candidate.enrollment.binding)) != 1) throw AgentStoreFault("identity_mismatch")
            val active = record.candidate.copy(phase = "active", certificateFingerprint = candidate.enrollment.certificateFingerprint)
            saveIdentity(db, active, readIdentity(db) == null, writing)
            saveRotation(db, record.copy(candidate = active, receipt = candidate.receipt), false, writing)
        }
        try { load() ?: throw AgentStoreFault("identity_mismatch") } catch (error: Exception) { frozen = true; throw error }
    }

    @Synchronized fun activationProof(requestId: String): String {
        val record = identityTransaction { db, writing ->
            val record = readRotation(db, requestId) ?: throw AgentStoreFault("identity_request_required")
            record.verify(load() ?: throw AgentStoreFault("credentials_unavailable"), keys)
            if (record.candidate.phase != "active") throw AgentStoreFault("identity_request_not_ready")
            if (record.proof != null) record else {
                val proof = keys.load(record.candidate.reference).rotationActivationProof(record.candidate.setup.identity, requestId, record.candidate.certificateFingerprint!!, record.receipt!!.challenge)
                record.copy(proof = proof).also { saveRotation(db, it, false, writing) }
            }
        }
        try {
            val saved = readRotation(helper.writableDatabase, requestId) ?: throw AgentStoreFault("identity_mismatch")
            if (!saved.encoded().contentEquals(record.encoded())) throw AgentStoreFault("identity_mismatch")
            return saved.proof!!
        } catch (error: Exception) { frozen = true; throw error }
    }

    /** 仅记下原管理操作的完成观测；回执不证明Broker已重载或旧连接已断开。 */
    @Synchronized fun confirmRotationManagement(receipt: DeviceRotationReceipt) {
        identityTransaction { db, writing ->
            val record = readRotation(db, receipt.requestId) ?: throw AgentStoreFault("identity_request_required")
            val current = load() ?: throw AgentStoreFault("credentials_unavailable")
            record.verify(current, keys)
            if (record.candidate.phase != "active" || record.proof == null || record.receipt?.requestDigest != receipt.requestDigest || !receipt.managementCompleted) throw AgentStoreFault("rotation_not_completed")
            receipt.verify(record.candidate.setup, record.candidate.view(keys).request!!, record.previousSerial, record.previousCertificate, current, record.expiredRecovery, record.preservesRotation)
            if (record.receipt.managementCompleted) return@identityTransaction
            saveRotation(db, record.copy(receipt = receipt), false, writing)
        }
    }

    @Synchronized fun keyRetirements(): List<KeyRetirementView> {
        usable()
        val db = helper.writableDatabase
        maintenance() ?: return emptyList()
        return db.rawQuery("SELECT request_id FROM rotations ORDER BY number DESC", null).use {
            val result = mutableListOf<KeyRetirementView>()
            while (it.moveToNext()) {
                if (result.size >= 128) throw AgentStoreFault("storage_corrupt")
                result += (readRotation(db, it.getString(0)) ?: throw AgentStoreFault("identity_mismatch")).retirementView()
            }
            result
        }
    }

    private fun retirementGuard(db: SQLiteDatabase, record: LocalRotationRecord): DeviceEnrollment {
        val current = load() ?: throw AgentStoreFault("credentials_unavailable")
        val reference = record.previousReference
        if (record.version < 2 || reference == null || record.previousCertificatePem == null) throw AgentStoreFault("key_retirement_untracked")
        if (record.candidate.phase != "active" || record.receipt?.managementCompleted != true || record.proof == null) throw AgentStoreFault("rotation_not_completed")
        val latest = readRotation(db) ?: throw AgentStoreFault("identity_mismatch")
        if (current.binding != record.candidate.setup.binding || reference == current.keyReference || reference == latest.candidate.reference ||
            current.publicKeyFingerprint == record.previousPublicKey) throw AgentStoreFault("key_retirement_current_key")
        return current
    }

    private fun validateRetirement(record: LocalRotationRecord, current: DeviceEnrollment, proof: DeviceRevocationProof, atMillis: Long) {
        proof.verify(record.candidate.setup, record.previousCertificatePem ?: throw AgentStoreFault("key_retirement_untracked"), record.previousSerial,
            record.previousCertificate, record.previousPublicKey, current, atMillis)
    }

    /** 预览零写入；未提交原清理意图时缺钥拒绝，不能伪造为已清理。 */
    @Synchronized fun previewKeyRetirement(requestId: String, crl: ByteArray? = null): KeyRetirementPreview {
        usable()
        val db = helper.writableDatabase; val record = readRotation(db, requestId) ?: throw AgentStoreFault("identity_request_required")
        val current = retirementGuard(db, record)
        val port = keys as? IdentityKeyRetirement ?: throw AgentStoreFault("key_retirement_unsupported")
        val saved = record.retirement
        val proof = if (saved != null) {
            if (crl != null && !saved.proof.encoded().contentEquals(crl)) throw AgentStoreFault("key_retirement_conflict")
            saved.proof
        } else DeviceRevocationProof.parse(crl ?: throw AgentStoreFault("revocation_proof_required"))
        validateRetirement(record, current, proof, saved?.approvedAt ?: System.currentTimeMillis())
        if (saved == null && record.copy(retirement = KeyRetirementRecord("deleting", proof, System.currentTimeMillis())).encoded().size > 32768) throw AgentStoreFault("capacity_exceeded")
        if (saved?.phase == "retired") {
            if (port.contains(record.previousReference!!)) throw AgentStoreFault("key_retirement_conflict")
        } else if (port.contains(record.previousReference!!)) {
            if (keys.load(record.previousReference).publicKeyFingerprint != record.previousPublicKey) throw AgentStoreFault("identity_mismatch")
        } else if (saved == null) throw AgentStoreFault("identity_key_unavailable")
        return KeyRetirementPreview(requestId, proof)
    }

    /** SQL意图先提交；KeyStore删除不参加事务，未知结果冻结后只恢复原决定。 */
    @Synchronized fun retirePreviousKey(preview: KeyRetirementPreview) {
        var record = identityTransaction { db, writing ->
            previewKeyRetirement(preview.requestId, preview.proof.encoded())
            val record = readRotation(db, preview.requestId) ?: throw AgentStoreFault("identity_mismatch")
            val current = retirementGuard(db, record)
            if (record.retirement != null) record else {
                val at = System.currentTimeMillis(); validateRetirement(record, current, preview.proof, at)
                record.copy(retirement = KeyRetirementRecord("deleting", preview.proof, at)).also { saveRotation(db, it, false, writing) }
            }
        }
        if (record.retirement?.phase == "retired") return
        try {
            val db = helper.writableDatabase
            val persisted = readRotation(db, preview.requestId) ?: throw AgentStoreFault("identity_mismatch")
            if (!persisted.encoded().contentEquals(record.encoded())) throw AgentStoreFault("key_retirement_conflict")
            validateRetirement(persisted, retirementGuard(db, persisted), persisted.retirement!!.proof, persisted.retirement.approvedAt)
            val port = keys as? IdentityKeyRetirement ?: throw AgentStoreFault("key_retirement_unsupported")
            port.retire(persisted.previousReference!!, persisted.previousPublicKey)
            record = identityTransaction { transaction, writing ->
                val current = readRotation(transaction, preview.requestId) ?: throw AgentStoreFault("identity_mismatch")
                if (!current.encoded().contentEquals(persisted.encoded())) throw AgentStoreFault("key_retirement_conflict")
                retirementGuard(transaction, current)
                if (port.contains(current.previousReference!!)) throw AgentStoreFault("key_retirement_unknown")
                current.copy(retirement = current.retirement!!.copy(phase = "retired")).also { saveRotation(transaction, it, false, writing) }
            }
            val saved = readRotation(db, preview.requestId) ?: throw AgentStoreFault("identity_mismatch")
            if (!saved.encoded().contentEquals(record.encoded())) throw AgentStoreFault("key_retirement_conflict")
            load() ?: throw AgentStoreFault("identity_mismatch")
        } catch (error: Exception) { frozen = true; throw error }
    }

    /** 公开证书、凭据引用与完成状态一起提交；重复确认同证书只读取原决定。 */
    @Synchronized fun activateIdentity(enrollment: DeviceEnrollment) {
        usable()
        val value = DeviceDocument.parse(enrollment.encoded(), 32768)
        val certificate = (value["certificate_pem"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.toByteArray(Charsets.US_ASCII)
            ?: throw AgentStoreFault("invalid_certificate")
        // 完整证书验证先于任何写入；事务内再次核对原记录与实际密钥。
        val preview = previewCertificate(certificate)
        if (!preview.encoded().contentEquals(enrollment.encoded())) throw AgentStoreFault("identity_mismatch")
        identityTransaction { db, writing ->
            val record = readIdentity(db) ?: throw AgentStoreFault("identity_mismatch")
            val checked = record.enrollment(certificate, keys)
            if (!checked.encoded().contentEquals(preview.encoded())) throw AgentStoreFault("identity_request_conflict")
            if (record.phase == "active") {
                record.verify(loadEnrollment(db) ?: throw AgentStoreFault("identity_mismatch"), keys)
                return@identityTransaction
            }
            if (record.phase != "pending" || binding(db) != null) throw AgentStoreFault("identity_request_conflict")
            writing()
            val plain = checked.encoded()
            val encrypted = try { vault.seal(plain, checked.binding) } finally { plain.fill(0) }
            db.insertOrThrow("agent", null, ContentValues().apply { put("slot", 1); put("binding", checked.binding); put("credentials", encrypted) })
            saveIdentity(db, record.copy(phase = "active", certificateFingerprint = checked.certificateFingerprint), false, writing)
        }
        try { load() ?: throw AgentStoreFault("identity_mismatch") }
        catch (error: Exception) { frozen = true; throw error }
    }

    fun journal(binding: String): DeviceStorage = object : DeviceStorage {
        override fun read(): ByteArray? = readJournal(binding)
        override fun commit(bytes: ByteArray) = writeJournal(binding, bytes)
    }
    @Synchronized private fun readJournal(expected: String): ByteArray? {
        usable()
        val db = helper.writableDatabase
        return db.rawQuery("SELECT binding, journal FROM agent WHERE slot=1", null).use {
            if (!it.moveToFirst() || it.getString(0) != expected) throw AgentStoreFault("identity_mismatch")
            if (it.isNull(1)) null else it.getBlob(1).also { bytes -> if (bytes.size > 1048576) throw AgentStoreFault("storage_corrupt") }
        }
    }
    @Synchronized private fun writeJournal(expected: String, bytes: ByteArray) {
        usable()
        if (bytes.isEmpty() || bytes.size > 1048576) throw AgentStoreFault()
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            if (db.update("agent", ContentValues().apply { put("journal", bytes) }, "slot=1 AND binding=?", arrayOf(expected)) != 1) throw AgentStoreFault("identity_mismatch")
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
    @Synchronized fun allowed(): Set<String> {
        usable()
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
        usable()
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
