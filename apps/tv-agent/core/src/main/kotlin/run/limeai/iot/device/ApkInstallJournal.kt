package run.limeai.iot.device

import kotlinx.serialization.json.*

/** 原记录比较与提交必须在同一耐久事务内完成；冲突不能覆盖另一实例的决定。 */
interface ApkInstallStorage {
    fun read(): ByteArray?
    fun compareAndSet(expected: ByteArray?, updated: ByteArray): Boolean
}

/** 仅保存已核对材料的引用与连续性摘要；此对象不产生安装授权或预检证明。 */
data class ApkInstallPlan(
    val requestId: String,
    val binding: String,
    val baselineSha256: String,
    val candidateSha256: String,
    val signerSha256: String,
    val baselineVersion: Long,
    val candidateVersion: Long,
    val candidateBytes: Long,
    val continuityDigest: String,
    val preflightDigest: String,
) {
    init {
        checkDevice(identifier.matches(requestId) && Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,63}/[A-Za-z0-9][A-Za-z0-9_-]{0,63}/sha256:[0-9a-f]{64}").matches(binding), "invalid_apk_install_plan")
        checkDevice(listOf(baselineSha256, candidateSha256, signerSha256, continuityDigest, preflightDigest).all { Regex("sha256:[0-9a-f]{64}").matches(it) }, "invalid_apk_install_plan")
        checkDevice(baselineSha256 != candidateSha256 && baselineVersion in 1..2147483647L && candidateVersion in (baselineVersion + 1)..2147483647L && candidateBytes in 1..268435456L, "invalid_apk_install_plan")
    }
    val digest: String get() = DeviceDocument.digest(document())
    internal fun document() = buildJsonObject {
        put("request_id", requestId); put("binding", binding)
        put("baseline_sha256", baselineSha256); put("candidate_sha256", candidateSha256); put("signer_sha256", signerSha256)
        put("baseline_version", baselineVersion); put("candidate_version", candidateVersion); put("candidate_bytes", candidateBytes)
        put("continuity_digest", continuityDigest); put("preflight_digest", preflightDigest)
    }
    companion object {
        internal fun parse(value: JsonObject): ApkInstallPlan {
            value.fields("request_id", "binding", "baseline_sha256", "candidate_sha256", "signer_sha256", "baseline_version", "candidate_version", "candidate_bytes", "continuity_digest", "preflight_digest")
            return ApkInstallPlan(value.text("request_id"), value.text("binding"), value.text("baseline_sha256"), value.text("candidate_sha256"), value.text("signer_sha256"),
                value.integer("baseline_version"), value.integer("candidate_version"), value.integer("candidate_bytes"), value.text("continuity_digest"), value.text("preflight_digest"))
        }
    }
}

enum class ApkInstallPhase {
    PREPARED, CREATING, CREATED, STAGED, COMMITTING, PENDING_USER, INSTALLED_UNVERIFIED, LOCAL_HEALTH_ACCEPTED, LOCAL_PACKAGE_RECOVERED, FAILED, CANCELLED;
    val terminal: Boolean get() = this == FAILED || this == CANCELLED || this == LOCAL_HEALTH_ACCEPTED || this == LOCAL_PACKAGE_RECOVERED
}

/** 本机检查的接受记录，不代表Broker连通、远程命令或真实安装已由服务端验收。 */
data class ApkLocalHealth(
    val planDigest: String, val installedSha256: String, val installedBytes: Long, val signerSha256: String,
    val runningVersion: Long, val continuityDigest: String, val certificateSha256: String, val discoveredApplications: Int,
) {
    internal fun verify(plan: ApkInstallPlan) {
        checkDevice(planDigest == plan.digest && installedSha256 == plan.candidateSha256 && installedBytes == plan.candidateBytes &&
            signerSha256 == plan.signerSha256 && runningVersion == plan.candidateVersion && continuityDigest == plan.continuityDigest &&
            Regex("sha256:[0-9a-f]{64}").matches(certificateSha256) && discoveredApplications in 0..128, "apk_install_health_mismatch")
    }
    internal fun document() = buildJsonObject {
        put("plan_digest", planDigest); put("installed_sha256", installedSha256); put("installed_bytes", installedBytes)
        put("signer_sha256", signerSha256); put("running_version", runningVersion); put("continuity_digest", continuityDigest)
        put("certificate_sha256", certificateSha256); put("discovered_applications", discoveredApplications)
    }
    companion object {
        internal fun parse(value: JsonObject): ApkLocalHealth {
            value.fields("plan_digest", "installed_sha256", "installed_bytes", "signer_sha256", "running_version", "continuity_digest", "certificate_sha256", "discovered_applications")
            val applications = value.integer("discovered_applications"); checkDevice(applications in 0..128)
            return ApkLocalHealth(value.text("plan_digest"), value.text("installed_sha256"), value.integer("installed_bytes"), value.text("signer_sha256"),
                value.integer("running_version"), value.text("continuity_digest"), value.text("certificate_sha256"), applications.toInt())
        }
    }
}

data class ApkInstallRecord(
    val plan: ApkInstallPlan, val phase: ApkInstallPhase, val sessionId: Int?, val localHealth: ApkLocalHealth? = null,
    val recoveredFrom: ApkInstallPhase? = null, val recoveryResult: ApkSystemResult? = null,
) {
    val blocksAnotherInstall: Boolean get() = !phase.terminal
}

/** 仅由安装提供方的当前自有会话查询产生，不能来自外部导入文件。 */
data class ApkSessionClaim(val sessionId: Int, val requestDigest: String, val packageName: String, val size: Long)

enum class ApkSystemResult { PENDING_USER_ACTION, INSTALLED, FAILED, CANCELLED }

/** APK专用原任务账本；读取/重开无系统副作用，不提供通用更新插件或自动重试。 */
class ApkInstallJournal(private val storage: ApkInstallStorage) {
    private var encoded: ByteArray? = storage.read()?.copyOf()
    private var records: List<ApkInstallRecord> = decode(encoded)
    var blocked = false; private set

    @Synchronized fun snapshot(): List<ApkInstallRecord> { usable(); return records.toList() }

    @Synchronized fun prepare(plan: ApkInstallPlan): ApkInstallRecord {
        usable()
        records.find { it.plan.requestId == plan.requestId }?.let {
            checkDevice(it.plan == plan, "apk_install_idempotency_conflict")
            return it
        }
        checkDevice(records.none { it.blocksAnotherInstall }, "apk_install_in_progress")
        checkDevice(records.size < 128, "apk_install_capacity")
        val record = ApkInstallRecord(plan, ApkInstallPhase.PREPARED, null)
        persist(records + record)
        return record
    }

    @Synchronized fun cancelPrepared(requestId: String): ApkInstallRecord {
        val old = find(requestId)
        if (old.phase == ApkInstallPhase.CANCELLED) return old
        checkDevice(old.phase == ApkInstallPhase.PREPARED, "apk_install_resolve_required")
        return replace(old.copy(phase = ApkInstallPhase.CANCELLED))
    }

    /** 外部调用前先保存创建意图；丢失返回值时只查询原自有会话，不再创建。 */
    @Synchronized fun createSession(requestId: String, verifyCurrent: (ApkInstallPlan) -> Unit, create: (ApkInstallPlan) -> Int): ApkInstallRecord {
        val old = find(requestId)
        if (old.phase != ApkInstallPhase.PREPARED) return old
        verifyCurrent(old.plan)
        replace(old.copy(phase = ApkInstallPhase.CREATING))
        val session = try { create(old.plan) } catch (_: Exception) { throw DeviceFault("apk_install_creation_unknown") }
        checkDevice(session > 0 && records.none { it.sessionId == session }, "apk_install_creation_unknown")
        return replace(old.copy(phase = ApkInstallPhase.CREATED, sessionId = session))
    }

    @Synchronized fun resolveCreation(requestId: String, claims: List<ApkSessionClaim>): ApkInstallRecord {
        val old = find(requestId)
        checkDevice(old.phase == ApkInstallPhase.CREATING, "apk_install_resolve_required")
        checkDevice(claims.size <= 128, "apk_install_ambiguous_session")
        val matches = claims.filter { it.requestDigest == old.plan.digest }
        if (matches.isEmpty()) return old // 没有当前会话不足以证明从未创建，不自动重新创建。
        checkDevice(matches.size == 1, "apk_install_ambiguous_session")
        val found = matches.single()
        checkDevice(found.sessionId > 0 && found.packageName == PACKAGE && found.size == old.plan.candidateBytes && records.none { it.sessionId == found.sessionId }, "apk_install_session_mismatch")
        return replace(old.copy(phase = ApkInstallPhase.CREATED, sessionId = found.sessionId))
    }

    /** 摘要和字节数必须来自提供方实际读回的同一会话；此层不解析或写入APK。 */
    @Synchronized fun staged(requestId: String, sessionId: Int, sha256: String, bytes: Long): ApkInstallRecord {
        val old = find(requestId)
        checkDevice(old.sessionId == sessionId && old.plan.candidateSha256 == sha256 && old.plan.candidateBytes == bytes, "apk_install_stage_mismatch")
        if (old.phase == ApkInstallPhase.STAGED) return old
        checkDevice(old.phase == ApkInstallPhase.CREATED, "apk_install_resolve_required")
        return replace(old.copy(phase = ApkInstallPhase.STAGED))
    }

    /** 提交不自动重试；两次核对之间耐久保存意图，提交返回也不能代替系统结果。 */
    @Synchronized fun commit(requestId: String, verifyCurrent: (ApkInstallPlan) -> Unit, submit: (ApkInstallPlan, Int) -> Unit): ApkInstallRecord {
        val old = find(requestId)
        if (old.phase in setOf(ApkInstallPhase.COMMITTING, ApkInstallPhase.PENDING_USER, ApkInstallPhase.INSTALLED_UNVERIFIED) || old.phase.terminal) return old
        checkDevice(old.phase == ApkInstallPhase.STAGED, "apk_install_not_staged")
        verifyCurrent(old.plan)
        replace(old.copy(phase = ApkInstallPhase.COMMITTING))
        // 保存后再次失权时零提交，保留可能开始的阶段供独立核对，不改回可重试状态。
        verifyCurrent(old.plan)
        try { submit(old.plan, old.sessionId!!) } catch (_: Exception) { throw DeviceFault("apk_install_commit_unknown") }
        return find(requestId)
    }

    /** 调用方须验证非导出系统结果入口、原请求及会话；成功仍须另验身份/记录和健康。 */
    @Synchronized fun systemResult(requestId: String, sessionId: Int, result: ApkSystemResult): ApkInstallRecord {
        val old = find(requestId)
        checkDevice(old.sessionId == sessionId, "apk_install_session_mismatch")
        if (old.phase == ApkInstallPhase.LOCAL_PACKAGE_RECOVERED) {
            // 本机独立恢复不是系统成功；迟到的原终态另存，不能改写恢复来源或重新安装。
            if (result == ApkSystemResult.PENDING_USER_ACTION || old.recoveryResult == result) return old
            checkDevice(old.recoveryResult == null, "apk_install_result_conflict")
            return replace(old.copy(recoveryResult = result))
        }
        if (old.phase == ApkInstallPhase.LOCAL_HEALTH_ACCEPTED && result == ApkSystemResult.INSTALLED) return old
        val phase = when (result) {
            ApkSystemResult.PENDING_USER_ACTION -> ApkInstallPhase.PENDING_USER
            ApkSystemResult.INSTALLED -> ApkInstallPhase.INSTALLED_UNVERIFIED
            ApkSystemResult.FAILED -> ApkInstallPhase.FAILED
            ApkSystemResult.CANCELLED -> ApkInstallPhase.CANCELLED
        }
        if (old.phase == phase) return old
        checkDevice(old.phase in setOf(ApkInstallPhase.COMMITTING, ApkInstallPhase.PENDING_USER), "apk_install_result_conflict")
        return replace(old.copy(phase = phase))
    }

    /** 仅接受已有系统成功的原任务；核对失败不写入，耐久结果未知则冻结并重开原账本。 */
    @Synchronized fun acceptLocalHealth(requestId: String, verifyCurrent: (ApkInstallPlan) -> ApkLocalHealth): ApkInstallRecord {
        val old = find(requestId)
        if (old.phase == ApkInstallPhase.LOCAL_HEALTH_ACCEPTED) return old
        checkDevice(old.phase == ApkInstallPhase.INSTALLED_UNVERIFIED, "apk_install_health_not_ready")
        val health = verifyCurrent(old.plan).also { it.verify(old.plan) }
        return replace(old.copy(phase = ApkInstallPhase.LOCAL_HEALTH_ACCEPTED, localHealth = health))
    }

    /** 调用方须核对原会话已消失、实际候选/新代码及完整连续性；不伪造系统安装结果。 */
    @Synchronized fun recoverInstalledPackage(
        requestId: String, fromPhase: ApkInstallPhase, verifyCurrent: (ApkInstallPlan, Int) -> ApkLocalHealth,
    ): ApkInstallRecord {
        val old = find(requestId)
        checkDevice(fromPhase in setOf(ApkInstallPhase.COMMITTING, ApkInstallPhase.PENDING_USER), "apk_install_package_recovery_not_ready")
        if (old.phase == ApkInstallPhase.LOCAL_PACKAGE_RECOVERED) {
            checkDevice(old.recoveredFrom == fromPhase, "apk_install_idempotency_conflict")
            return old
        }
        checkDevice(old.phase == fromPhase && old.sessionId != null, "apk_install_package_recovery_not_ready")
        val health = verifyCurrent(old.plan, old.sessionId!!).also { it.verify(old.plan) }
        return replace(old.copy(phase = ApkInstallPhase.LOCAL_PACKAGE_RECOVERED, localHealth = health, recoveredFrom = fromPhase))
    }

    private fun usable() = checkDevice(!blocked, "apk_install_storage_reopen_required")
    private fun find(requestId: String): ApkInstallRecord {
        usable()
        return records.find { it.plan.requestId == requestId } ?: throw DeviceFault("apk_install_not_found")
    }
    private fun replace(record: ApkInstallRecord): ApkInstallRecord {
        persist(records.map { if (it.plan.requestId == record.plan.requestId) record else it })
        return record
    }
    private fun persist(next: List<ApkInstallRecord>) {
        usable()
        val bytes = encode(next)
        checkDevice(bytes.size <= MAX_BYTES, "apk_install_capacity")
        try {
            checkDevice(storage.compareAndSet(encoded?.copyOf(), bytes.copyOf()), "apk_install_storage_conflict")
            encoded = bytes; records = next
        } catch (failure: Exception) {
            blocked = true
            if (failure is DeviceFault && failure.code == "apk_install_storage_conflict") throw failure
            throw DeviceFault("apk_install_storage_unavailable")
        }
    }

    companion object {
        const val PACKAGE = "run.limeai.iot.television"
        const val MAX_BYTES = 1048576
        private fun encode(records: List<ApkInstallRecord>): ByteArray = DeviceDocument.canonical(buildJsonObject {
            put("schema_version", 3)
            put("operations", JsonArray(records.map { record -> buildJsonObject {
                put("plan", record.plan.document()); put("request_digest", record.plan.digest)
                put("phase", record.phase.name.lowercase()); put("session_id", record.sessionId?.let(::JsonPrimitive) ?: JsonNull)
                put("local_health", record.localHealth?.document() ?: JsonNull)
                put("recovered_from", record.recoveredFrom?.let { JsonPrimitive(it.name.lowercase()) } ?: JsonNull)
                put("recovery_result", record.recoveryResult?.let { JsonPrimitive(it.name.lowercase()) } ?: JsonNull)
            } }))
        }).toByteArray(Charsets.UTF_8)

        private fun decode(bytes: ByteArray?): List<ApkInstallRecord> {
            if (bytes == null) return emptyList()
            try {
                val document = DeviceDocument.parse(bytes, MAX_BYTES, 16384)
                document.fields("schema_version", "operations")
                val version = document.integer("schema_version"); checkDevice(version in 1L..3L)
                val operations = document["operations"] as? JsonArray ?: throw DeviceFault("invalid_message")
                checkDevice(operations.size <= 128)
                val result = operations.map { element ->
                    val item = element.obj()
                    if (version == 1L) item.fields("plan", "request_digest", "phase", "session_id")
                    else if (version == 2L) item.fields("plan", "request_digest", "phase", "session_id", "local_health")
                    else item.fields("plan", "request_digest", "phase", "session_id", "local_health", "recovered_from", "recovery_result")
                    val plan = ApkInstallPlan.parse(item.getValue("plan").obj())
                    checkDevice(item.text("request_digest") == plan.digest)
                    val phaseText = item.text("phase")
                    val phase = ApkInstallPhase.entries.single { it.name.lowercase() == phaseText }
                    checkDevice(version != 1L || phase != ApkInstallPhase.LOCAL_HEALTH_ACCEPTED)
                    checkDevice(version == 3L || phase != ApkInstallPhase.LOCAL_PACKAGE_RECOVERED)
                    val health = if (version == 1L || item["local_health"] === JsonNull) null else ApkLocalHealth.parse(item.getValue("local_health").obj()).also { it.verify(plan) }
                    checkDevice((phase in setOf(ApkInstallPhase.LOCAL_HEALTH_ACCEPTED, ApkInstallPhase.LOCAL_PACKAGE_RECOVERED)) == (health != null))
                    val recoveredFrom = if (version < 3L || item["recovered_from"] === JsonNull) null else ApkInstallPhase.entries.single { it.name.lowercase() == item.text("recovered_from") }
                    val recoveryResult = if (version < 3L || item["recovery_result"] === JsonNull) null else ApkSystemResult.entries.single { it.name.lowercase() == item.text("recovery_result") }
                    checkDevice(if (phase == ApkInstallPhase.LOCAL_PACKAGE_RECOVERED) recoveredFrom in setOf(ApkInstallPhase.COMMITTING, ApkInstallPhase.PENDING_USER)
                        else recoveredFrom == null && recoveryResult == null)
                    checkDevice(recoveryResult != ApkSystemResult.PENDING_USER_ACTION)
                    val session = if (item["session_id"] === JsonNull) null else item.integer("session_id").also { checkDevice(it in 1..2147483647L) }.toInt()
                    checkDevice(if (phase in setOf(ApkInstallPhase.PREPARED, ApkInstallPhase.CREATING)) session == null else phase == ApkInstallPhase.CANCELLED || session != null)
                    ApkInstallRecord(plan, phase, session, health, recoveredFrom, recoveryResult)
                }
                checkDevice(result.map { it.plan.requestId }.distinct().size == result.size)
                checkDevice(result.mapNotNull { it.sessionId }.let { it.distinct().size == it.size })
                checkDevice(result.count { it.blocksAnotherInstall } <= 1)
                return result
            } catch (_: Exception) { throw DeviceFault("apk_install_storage_corrupt") }
        }
    }
}
