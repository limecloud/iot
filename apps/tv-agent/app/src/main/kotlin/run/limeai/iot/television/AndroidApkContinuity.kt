package run.limeai.iot.television

import android.database.sqlite.SQLiteDatabase
import kotlinx.serialization.json.*
import run.limeai.iot.device.*
import java.security.MessageDigest

/** 仅向安装计划交付绑定、摘要及日志计数；不导出凭据、alias或完整命令。 */
internal data class ApkContinuitySnapshot(val binding: String, val digest: String, val journal: DeviceJournalInspection?) {
    fun verify(plan: ApkInstallPlan) {
        if (plan.binding != binding || plan.continuityDigest != digest) throw DeviceFault("apk_install_continuity_changed")
    }
}

/** 调用方持有原存储事务；覆盖原行/密文字节，历史决定只读保留，不重新批准清理。 */
internal object AndroidApkContinuity {
    /** 在解密/解析前限制所有原表的行数和最大载荷，拒绝后不尝试修复。 */
    fun verifyBounds(db: SQLiteDatabase) {
        val limits = listOf(
            Triple("agent", 1, mapOf("binding" to 512L, "credentials" to 65536L, "journal" to 1048576L)),
            Triple("identity", 1, mapOf("binding" to 512L, "document" to 65536L)),
            Triple("rotations", 128, mapOf("binding" to 512L, "request_id" to 64L, "document" to 65536L)),
            Triple("applications", 128, mapOf("package" to 255L)),
        )
        for ((table, count, fields) in limits) {
            val sql = "SELECT count(*)," + fields.keys.joinToString(",") { "coalesce(max(length($it)),0)" } + " FROM $table"
            db.rawQuery(sql, null).use { cursor ->
                if (!cursor.moveToFirst() || cursor.getLong(0) > count || fields.values.withIndex().any { (index, max) -> cursor.getLong(index + 1) > max })
                    throw AgentStoreFault("storage_corrupt")
            }
        }
    }

    fun capture(
        db: SQLiteDatabase,
        keys: IdentityKeys,
        current: DeviceMaintenanceIdentity?,
        identity: LocalIdentityRecord?,
        allowed: Set<String>,
        rotation: (String) -> LocalRotationRecord,
    ): ApkContinuitySnapshot {
        val binding = current?.binding ?: identity?.setup?.binding ?: throw AgentStoreFault("credentials_unavailable")
        val rows = mutableListOf<JsonElement>()
        val records = mutableListOf<LocalRotationRecord>()
        var inspection: DeviceJournalInspection? = null
        val agent = db.rawQuery("SELECT slot,binding,credentials,journal,length(credentials),length(journal) FROM agent", null).use { cursor ->
            if (cursor.count > 1 || (cursor.count == 1) != (current != null)) throw AgentStoreFault("identity_mismatch")
            if (!cursor.moveToFirst()) JsonNull else {
                if (cursor.getInt(0) != 1 || cursor.getString(1) != binding || cursor.getLong(4) !in 1..65536 ||
                    !cursor.isNull(3) && cursor.getLong(5) !in 1..1048576) throw AgentStoreFault("storage_corrupt")
                val journal = if (cursor.isNull(3)) null else cursor.getBlob(3)
                inspection = DeviceJournalInspection.inspect(current!!.identity, journal)
                buildJsonObject {
                    put("slot", 1); put("binding", binding); put("credentials", hash(cursor.getBlob(2)))
                    put("journal", journal?.let { JsonPrimitive(hash(it)) } ?: JsonNull)
                }
            }
        }
        val request = db.rawQuery("SELECT slot,binding,document,length(document) FROM identity", null).use { cursor ->
            if (cursor.count > 1 || (cursor.count == 1) != (identity != null)) throw AgentStoreFault("identity_mismatch")
            if (!cursor.moveToFirst()) JsonNull else {
                if (cursor.getInt(0) != 1 || cursor.getString(1) != binding || cursor.getLong(3) !in 1..65536) throw AgentStoreFault("storage_corrupt")
                buildJsonObject { put("slot", 1); put("binding", binding); put("document", hash(cursor.getBlob(2))) }
            }
        }
        db.rawQuery("SELECT number,request_id,binding,document,length(document) FROM rotations ORDER BY number", null).use { cursor ->
            if (cursor.count > 128) throw AgentStoreFault("storage_corrupt")
            while (cursor.moveToNext()) {
                if (cursor.getLong(0) <= 0 || cursor.getString(2) != binding || cursor.getLong(4) !in 1..65536) throw AgentStoreFault("storage_corrupt")
                val record = rotation(cursor.getString(1))
                if (record.candidate.setup.binding != binding) throw AgentStoreFault("identity_mismatch")
                records += record
                rows += buildJsonObject {
                    put("number", cursor.getLong(0)); put("request_id", cursor.getString(1)); put("binding", binding)
                    put("document", hash(cursor.getBlob(3)))
                }
            }
        }
        if (current == null && (allowed.isNotEmpty() || records.isNotEmpty())) throw AgentStoreFault("identity_mismatch")
        // 历史候选不是当前身份；已按后续原决定清理的键无需复活或重新签名。
        for ((earlier, later) in records.zipWithNext()) {
            val candidate = earlier.candidate
            if (candidate.phase != "active" || earlier.receipt?.managementCompleted != true || earlier.proof == null ||
                candidate.certificateFingerprint != later.previousCertificate || candidate.publicKeyFingerprint != later.previousPublicKey ||
                later.previousReference?.let { it != candidate.reference } == true) throw AgentStoreFault("identity_mismatch")
        }
        if (records.map { it.candidate.reference }.distinct().size != records.size) throw AgentStoreFault("identity_mismatch")
        val observed = observeKeys(keys, identity, records)
        val document = buildJsonObject {
            put("version", 1); put("storage_version", db.version); put("binding", binding)
            put("agent", agent); put("identity", request); put("rotations", JsonArray(rows))
            put("applications", JsonArray(allowed.map(::JsonPrimitive))); put("keys", observed)
        }
        if (observed != observeKeys(keys, identity, records)) throw AgentStoreFault("identity_mismatch")
        return ApkContinuitySnapshot(binding, DeviceDocument.digest(document), inspection)
    }

    private fun observeKeys(keys: IdentityKeys, identity: LocalIdentityRecord?, records: List<LocalRotationRecord>): JsonObject {
        val candidates = listOfNotNull(identity) + records.map { it.candidate }
        val references = (candidates.map { it.reference } + records.mapNotNull { it.previousReference }).distinct().sorted()
        if (references.isEmpty()) return JsonObject(emptyMap())
        val presence = keys as? IdentityKeyRetirement ?: throw AgentStoreFault("key_retirement_unsupported")
        val decisions = records.filter { it.previousReference != null }.associateBy { it.previousReference!! }
        if (decisions.size != records.count { it.previousReference != null }) throw AgentStoreFault("identity_mismatch")
        return buildJsonObject {
            for (reference in references) {
                val present = presence.contains(reference)
                val previous = decisions[reference]
                val retirement = previous?.retirement
                if (retirement?.phase == "retired" && present || previous != null && retirement == null && !present)
                    throw AgentStoreFault("identity_key_unavailable")
                val actual = if (present) keys.load(reference).publicKeyFingerprint else null
                if (actual != null && previous != null && actual != previous.previousPublicKey) throw AgentStoreFault("identity_mismatch")
                for (candidate in candidates.filter { it.reference == reference }) {
                    when (candidate.phase) {
                        "prepared" -> if (present) throw AgentStoreFault("identity_mismatch")
                        "pending", "active" -> {
                            if (present) candidate.view(keys)
                            else if (candidate.phase != "active" || retirement == null || previous?.previousPublicKey != candidate.publicKeyFingerprint)
                                throw AgentStoreFault("identity_key_unavailable")
                        }
                        // creating可处于建钥调用前或原响应丢失后；只记录实际状态，不补建。
                    }
                }
                put(reference, actual?.let(::JsonPrimitive) ?: JsonNull)
            }
        }
    }

    private fun hash(bytes: ByteArray): String = "sha256:" + MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it.toInt() and 255) }
}
