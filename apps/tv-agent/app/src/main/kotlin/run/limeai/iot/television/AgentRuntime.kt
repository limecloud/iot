package run.limeai.iot.television

import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import run.limeai.iot.device.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import kotlin.concurrent.withLock

/** 只隔离连接的运行/关闭机制；宿主夹具不能当作实际MQTT执行证据。 */
internal interface AgentConnection : AutoCloseable { fun run() }

class TelevisionApplication : Application() {
    val runtime: AgentRuntime by lazy { AgentRuntime(this) }
}

data class EnrollmentSummary(val space: String, val device: String, val broker: String, val ca: String, val certificate: String, val expires: String, val model: String, val revision: String, val expired: Boolean)
data class AgentScreen(
    val status: String = "stopped", val notice: String = "", val summary: EnrollmentSummary? = null,
    val applications: List<AndroidApplications.Entry> = emptyList(), val allowed: Set<String> = emptySet(),
    val identityRequest: IdentityRequestView? = null,
    val rotation: RotationRequestView? = null,
    val retirements: List<KeyRetirementView> = emptyList(),
)

/** 单进程、单运行实例；Activity不是连接Owner，旧许可从不复活。 */
class AgentRuntime internal constructor(
    private val context: Context,
    private val stores: () -> AndroidAgentStore,
    private val connections: (DeviceMqtt) -> AgentConnection,
) {
    constructor(context: Context) : this(context, { AndroidAgentStore(context) }, { mqtt ->
        object : AgentConnection {
            override fun run() = mqtt.run()
            override fun close() = mqtt.close()
        }
    })
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor { Thread(it, "tv-agent-storage") }
    private var store = stores()
    private val lock = Any()
    private val observers = CopyOnWriteArraySet<() -> Unit>()
    private var permit: RunPermit? = null
    private var mqtt: AgentConnection? = null
    private var visible = false
    @Volatile var screen = AgentScreen(); private set
    val running: Boolean get() = synchronized(lock) { permit != null }
    fun observe(observer: () -> Unit) { observers += observer; observer() }
    fun remove(observer: () -> Unit) { observers -= observer }
    fun setVisible(value: Boolean) { synchronized(lock) { visible = value } }
    private fun update(change: (AgentScreen) -> AgentScreen) { main.post { screen = change(screen); observers.forEach { it() } } }
    fun notice(value: String) { update { it.copy(notice = value) } }
    private fun failure(error: Exception): String {
        val code = when (error) {
            is AgentStoreFault -> error.code
            is DeviceFault -> error.code
            else -> "storage_or_credentials_unavailable"
        }
        return when (code) {
            "storage_reopen_required" -> "保存结果需要核对。请停止连接后选择“重新核对已保存记录”，再恢复原申请。"
            "identity_rotation_required" -> "设备已有身份，请保留原记录。首次接入不能替代换钥流程。"
            "identity_request_conflict" -> "配置与已保存的申请不一致，请恢复原申请。"
            "identity_request_required" -> "请先核对首次连接配置并保存申请；已有申请不能被其他材料覆盖。"
            "identity_request_not_ready" -> "申请尚未完成，请先恢复原申请。"
            "identity_key_unavailable" -> "原设备密钥不可用，已拒绝继续。请保留应用数据，不要重新申请另一身份。"
            "identity_not_expired" -> "当前证书仍有效，请使用换钥流程。"
            "expired_identity_requires_recovery" -> "设备证书已过期，仅可维护。请明确申请过期恢复，连接和控制继续停用。"
            "rotation_in_progress" -> "原换钥尚未完成。请恢复原申请，切换后导出激活证明，由管理者完成撤旧。"
            "rotation_receipt_mismatch", "invalid_rotation_receipt" -> "换钥回执与原申请或证书不一致，已拒绝保存。请核对原管理操作。"
            "rotation_not_completed" -> "尚未取得原管理操作的完整撤旧结果。请导出激活证明并查询原轮换。"
            "invalid_revocation_proof" -> "撤销列表无效或不包含原旧证书，已拒绝清理。请核对固定CA签署的完整有效CRL。"
            "key_retirement_untracked" -> "该记录未保存可核对的原键引用，已拒绝自动清理。请保留原记录。"
            "key_retirement_current_key", "key_retirement_conflict" -> "原清理记录与当前密钥状态不一致，已拒绝删除。请保留记录并核对原操作。"
            "revocation_proof_required" -> "请提供固定CA签署的原撤销列表；管理完成JSON不能代替CRL。"
            "apk_install_in_progress" -> "原更新任务尚未完成核对，连接继续停用。请保留应用数据并核对原更新；系统安装成功仍须验证原身份、记录和健康。"
            "apk_install_stop_required" -> "请先停止连接并等待工作线程完全退出，再继续原更新任务。已请求停止不代表在途命令已结束。"
            else -> code
        }
    }
    fun summary(enrollment: DeviceIdentityMetadata) = EnrollmentSummary(enrollment.identity.space, enrollment.identity.device, enrollment.broker,
        enrollment.caFingerprint, enrollment.certificateFingerprint, DateFormat.getDateTimeInstance().format(Date(enrollment.certificateExpiresAt)), enrollment.identity.profile.id, enrollment.identity.profile.revision, System.currentTimeMillis() >= enrollment.certificateExpiresAt)

    fun refresh() { io.execute {
        try {
            val enrollment = store.maintenance(); val request = store.identityRequest(); val rotation = store.rotationRequest(); val retirements = store.keyRetirements(); val allowed = store.allowed(); val applications = AndroidApplications.discover(context)
            update { it.copy(summary = enrollment?.let(::summary), applications = applications, allowed = allowed, identityRequest = request, rotation = rotation, retirements = retirements) }
        } catch (error: Exception) { update { it.copy(summary = null, identityRequest = null, rotation = null, retirements = emptyList(), notice = failure(error)) } }
    } }

    private fun read(uri: Uri, maximum: Int): ByteArray = context.contentResolver.openInputStream(uri)?.use { input ->
        val output = ByteArrayOutputStream(); val block = ByteArray(4096)
        while (true) {
            val count = input.read(block); if (count < 0) break
            if (output.size() + count > maximum) throw DeviceFault("import_too_large")
            output.write(block, 0, count)
        }
        output.toByteArray()
    } ?: throw DeviceFault("import_unavailable")

    fun readEnrollment(uri: Uri, callback: (DeviceEnrollment) -> Unit) { io.execute {
        try {
            val bytes = read(uri, 32768)
            val enrollment = try { DeviceEnrollment.parse(bytes) } finally { bytes.fill(0) }
            main.post { callback(enrollment) }
        } catch (error: Exception) { notice(failure(error)) }
    } }

    fun readIdentitySetup(uri: Uri, callback: (DeviceIdentitySetup) -> Unit) { io.execute {
        try {
            val setup = DeviceIdentitySetup.parse(read(uri, 16384))
            main.post { callback(setup) }
        } catch (error: Exception) { notice(failure(error)) }
    } }

    fun requestIdentity(setup: DeviceIdentitySetup? = null) { io.execute {
        try {
            val request = synchronized(lock) {
                if (permit != null) throw AgentStoreFault("stop_before_import")
                val original = setup ?: store.identityRequest()?.setup ?: throw AgentStoreFault("identity_request_required")
                store.requestIdentity(original)
            }
            update { it.copy(identityRequest = request, notice = if (request.phase == "active") "原申请与已保存的设备证书已核对。" else "原申请已保存。请导出申请并由管理者核对公钥、签发证书。") }
            refresh()
        } catch (error: Exception) { notice(failure(error)); refresh() }
    } }

    fun exportIdentityRequest(uri: Uri) { io.execute {
        try {
            val view = synchronized(lock) {
                if (permit != null) throw AgentStoreFault("stop_before_import")
                store.identityRequest()?.takeIf { it.request != null } ?: throw AgentStoreFault("identity_request_not_ready")
            }
            context.contentResolver.openOutputStream(uri, "wt")?.use { output -> output.write(view.request!!.pem.toByteArray(Charsets.US_ASCII)); output.flush() }
                ?: throw DeviceFault("export_unavailable")
            notice(if (view.phase == "active") "原申请已导出，用于核对现有证书；更换证书须走换钥流程。" else "原申请已导出。请将公钥指纹与管理端独立核对，再导入签发的设备证书。")
        } catch (error: Exception) { notice(failure(error)) }
    } }

    fun readIdentityCertificate(uri: Uri, callback: (DeviceEnrollment) -> Unit) { io.execute {
        try {
            val certificate = read(uri, 4096)
            val enrollment = synchronized(lock) {
                if (permit != null) throw AgentStoreFault("stop_before_import")
                store.previewCertificate(certificate)
            }
            main.post { callback(enrollment) }
        } catch (error: Exception) { notice(failure(error)) }
    } }

    fun activateIdentity(enrollment: DeviceEnrollment) { io.execute {
        try {
            synchronized(lock) {
                if (permit != null) throw AgentStoreFault("stop_before_import")
                store.activateIdentity(enrollment)
            }
            notice("设备证书已保存。请确认允许的应用，再开始连接。")
            refresh()
        } catch (error: Exception) { notice(failure(error)); refresh() }
    } }

    fun reopenRecords() { io.execute {
        try {
            synchronized(lock) {
                if (permit != null) throw AgentStoreFault("stop_before_import")
                store.close(); store = stores()
            }
            update { it.copy(summary = null, identityRequest = null, notice = "已重新打开记录。未完成的申请请使用恢复原申请继续核对。") }
            refresh()
        } catch (error: Exception) { notice(failure(error)) }
    } }

    fun requestRotation(requestId: String, expiredRecovery: Boolean = false) { io.execute {
        try {
            synchronized(lock) {
                if (permit != null) throw AgentStoreFault("stop_before_import")
                if (expiredRecovery) store.requestExpiredRecovery(requestId) else store.requestRotation(requestId)
            }
            notice(if (expiredRecovery) "过期恢复申请已保存，连接仍停用。请管理者独立核对新公钥及过期旧证书，使用原请求恢复。" else "原换钥申请已保存。原身份继续保留，请独立核对新公钥和前证书后签发。")
            refresh()
        } catch (error: Exception) { notice(failure(error)); refresh() }
    } }

    fun readRotationReceipt(uri: Uri, callback: (DeviceRotationReceipt) -> Unit) { io.execute {
        try {
            val receipt = DeviceRotationReceipt.parse(read(uri, 16384))
            main.post { callback(receipt) }
        } catch (error: Exception) { notice(failure(error)) }
    } }

    fun readRotationCertificate(uri: Uri, receipt: DeviceRotationReceipt, callback: (RotationCandidate) -> Unit) { io.execute {
        try {
            val certificate = read(uri, 4096)
            val candidate = synchronized(lock) {
                if (permit != null) throw AgentStoreFault("stop_before_import")
                store.previewRotation(certificate, receipt)
            }
            main.post { callback(candidate) }
        } catch (error: Exception) { notice(failure(error)) }
    } }

    fun activateRotation(candidate: RotationCandidate) { io.execute {
        try {
            synchronized(lock) {
                if (permit != null) throw AgentStoreFault("stop_before_import")
                store.activateRotation(candidate)
            }
            notice("新身份已保存。请导出激活证明，由管理者完成原轮换、撤旧及Broker重载。")
            refresh()
        } catch (error: Exception) { notice(failure(error)); refresh() }
    } }

    fun exportRotation(uri: Uri, proof: Boolean) { io.execute {
        try {
            val bytes = synchronized(lock) {
                if (permit != null) throw AgentStoreFault("stop_before_import")
                val view = store.rotationRequest() ?: throw AgentStoreFault("identity_request_required")
                if (proof) store.activationProof(view.candidate.setup.requestId).toByteArray(Charsets.US_ASCII)
                else (view.candidate.request ?: throw AgentStoreFault("identity_request_not_ready")).pem.toByteArray(Charsets.US_ASCII)
            }
            context.contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes); it.flush() } ?: throw DeviceFault("export_unavailable")
            notice(if (proof) "原激活证明已导出。管理者须明确完成原轮换，再重载Broker并核对新旧身份连接。" else "原换钥CSR已导出，请独立核对新公钥、前证书指纹及序列号。")
        } catch (error: Exception) { notice(failure(error)); refresh() }
    } }

    fun confirmRotationManagement(receipt: DeviceRotationReceipt) { io.execute {
        try {
            synchronized(lock) {
                if (permit != null) throw AgentStoreFault("stop_before_import")
                store.confirmRotationManagement(receipt)
            }
            notice("已记录原管理操作完成。该回执不证明Broker已重载；请分别核对旧身份拒绝和新身份连接。")
            refresh()
        } catch (error: Exception) { notice(failure(error)); refresh() }
    } }

    fun previewKeyRetirement(requestId: String, uri: Uri?, callback: (KeyRetirementPreview) -> Unit) { io.execute {
        try {
            val crl = uri?.let { read(it, 16384) }
            val preview = synchronized(lock) {
                if (permit != null) throw AgentStoreFault("stop_before_import")
                store.previewKeyRetirement(requestId, crl)
            }
            main.post { callback(preview) }
        } catch (error: Exception) { notice(failure(error)); refresh() }
    } }

    fun retirePreviousKey(preview: KeyRetirementPreview) { io.execute {
        try {
            synchronized(lock) {
                if (permit != null) throw AgentStoreFault("stop_before_import")
                store.retirePreviousKey(preview)
            }
            notice("原旧签名键已核对为缺席，当前身份、应用授权和命令记录保留。此操作不证明Broker已重载或备份已擦除。")
            refresh()
        } catch (error: Exception) { notice(failure(error)); refresh() }
    } }

    fun install(enrollment: DeviceEnrollment) { io.execute {
        try {
            synchronized(lock) {
                if (permit != null) throw AgentStoreFault("stop_before_import")
                store.install(enrollment)
            }
            update { it.copy(summary = summary(enrollment), notice = "材料已保存。请确认允许的应用，再开始连接。") }
            refresh()
        } catch (error: Exception) { notice(failure(error)) }
    } }

    fun authorize(application: String, allow: Boolean) { io.execute {
        try {
            synchronized(lock) {
                if (allow && store.maintenance()?.expired == true) throw AgentStoreFault("expired_identity_requires_recovery")
                store.authorize(application, allow)
            }
            val allowed = store.allowed()
            update { it.copy(allowed = allowed, notice = "") }
        } catch (error: Exception) { notice(failure(error)); refresh() }
    } }

    fun start(finished: () -> Unit) {
        synchronized(lock) { if (permit != null) return }
        // 与安装/回执统一Owner→运行锁顺序；主线程不等待长时间的APK读写。
        if (ApkInstallOwner.lock.isHeldByCurrentThread || !ApkInstallOwner.lock.tryLock()) {
            notice(failure(DeviceFault("apk_install_in_progress"))); finished(); return
        }
        val current = try {
            synchronized(lock) {
                if (permit != null) return
                AndroidApkInstallStore(context).use { updates ->
                    if (ApkInstallJournal(updates).snapshot().any { it.blocksAnotherInstall }) throw DeviceFault("apk_install_in_progress")
                }
                RunPermit().also { permit = it }
            }
        } catch (error: Exception) {
            notice(failure(error)); finished(); return
        } finally { ApkInstallOwner.lock.unlock() }
        update { it.copy(status = "connecting", notice = "") }
        Thread({
            var failed: String? = null
            try {
                val enrollment = store.load() ?: throw AgentStoreFault("credentials_unavailable")
                val backend = store.journal(enrollment.binding)
                val storage = object : DeviceStorage {
                    override fun read() = backend.read()
                    override fun commit(bytes: ByteArray) = synchronized(lock) {
                        if (!current.active) throw AgentStoreFault("connection_stopped")
                        backend.commit(bytes)
                    }
                }
                val tls = enrollment.tls()
                val applications = AndroidApplications(context, { it in store.allowed() }, lock, current, { tls.current }) { visible }
                val client = connections(DeviceMqtt(enrollment.identity, enrollment.broker, tls, storage, applications,
                    object : DeviceClock { override fun elapsedMillis() = SystemClock.elapsedRealtime() }) { state ->
                    if (current.active) update {
                        if (!current.active) return@update it
                        if (state == "invalid_credentials" && !tls.current) return@update it.copy(status = "stopped", notice = "设备证书已到期，连接已停止。请使用过期身份维护。")
                        if (state in setOf("connecting", "handshaking", "ready", "stopped", "connection_unavailable")) it.copy(status = state)
                        else it.copy(status = state, notice = state)
                    }
                })
                synchronized(lock) { mqtt = client; if (!current.active) client.close() }
                client.run()
            } catch (error: Exception) { failed = failure(error) }
            finally {
                synchronized(lock) { current.stop(); mqtt?.close(); mqtt = null; if (permit === current) permit = null }
                val lastFailure = failed
                update { if (lastFailure == null) it.copy(status = "stopped") else it.copy(status = "stopped", notice = lastFailure) }
                main.post { if (!running) finished() }
                refresh()
            }
        }, "tv-agent-mqtt").start()
    }

    fun stop() {
        synchronized(lock) { permit?.stop(); mqtt?.close() }
        update { it.copy(status = if (running) "stopping" else "stopped") }
    }

    private fun requireApkStopped() = synchronized(lock) {
        // permit直到run返回且连接清理完成后才清除；stop()置inactive不足以通过此门禁。
        if (permit != null || mqtt != null) throw DeviceFault("apk_install_stop_required")
    }

    /** 原队列/Owner下读取计划所需的实际连续性；没有安装或连接副作用。 */
    internal fun readApkContinuity(completed: (Result<ApkContinuitySnapshot>) -> Unit) { io.execute {
        val result = runCatching {
            ApkInstallOwner.lock.withLock { requireApkStopped(); store.apkContinuity() }
        }
        main.post { completed(result) }
    } }

    /** 内部同步安装操作的串行Owner入口；产品必须另接可信预检材料及可见交互。 */
    internal fun <T> withApkInstallation(
        verifyMaterials: (ApkInstallPlan) -> Unit,
        operation: (ApkInstallJournal, AndroidApkInstaller) -> T,
        completed: (Result<T>) -> Unit,
    ) = runApkInstallation(verifyMaterials, {}, operation, completed)

    /** 原签名身份认证预检文件；仅在实际效果的资格回调中读取，未知任务查询不依赖文件仍存在。 */
    internal fun <T> withApkInstallation(
        bundle: File,
        candidate: File,
        allowDebug: Boolean,
        operation: (ApkInstallJournal, AndroidApkInstaller, (ApkInstallPlan) -> java.io.InputStream) -> T,
        completed: (Result<T>) -> Unit,
    ) {
        val materials by lazy { AndroidApkMaterials.read(context, bundle, candidate, allowDebug) }
        runApkInstallation({ materials.verifyCurrent(it) }, { materials.verifyBoundary(it) },
            { journal, provider -> operation(journal, provider) { plan -> materials.openCandidate(plan) } }, completed)
    }

    internal fun prepareApkInstallation(requestId: String, bundle: File, candidate: File, allowDebug: Boolean, completed: (Result<ApkInstallRecord>) -> Unit) { io.execute {
        val result = runCatching {
            ApkInstallOwner.lock.withLock {
                requireApkStopped()
                val materials = AndroidApkMaterials.read(context, bundle, candidate, allowDebug)
                val continuity = store.apkContinuity()
                AndroidApkInstallStore(context).use { updates -> ApkInstallJournal(updates).prepare(materials.plan(requestId, continuity)) }
            }
        }
        main.post { completed(result) }
    } }

    /** 产品导入/批准入口；文件副本与安装账本共用原Owner，未批准导入不会阻止连接。 */
    internal fun apkUpdates(completed: (Result<ApkUpdateOverview>) -> Unit) = apkLocal(completed) { imports, journal ->
        val records = journal.snapshot()
        try { ApkUpdateOverview(imports.entries(), records, true) }
        catch (_: Exception) { ApkUpdateOverview(emptyList(), records, false) }
    }

    internal fun importApkPreflight(uri: Uri, completed: (Result<String>) -> Unit) = apkLocal(completed) { imports, journal ->
        requireApkStopped()
        if (journal.snapshot().any { it.blocksAnotherInstall }) throw DeviceFault("apk_install_in_progress")
        imports.begin { context.contentResolver.openInputStream(uri) ?: throw DeviceFault("apk_import_unavailable") }
    }

    internal fun importApkCandidate(requestId: String, uri: Uri, completed: (Result<Unit>) -> Unit) = apkLocal(completed) { imports, journal ->
        requireApkStopped()
        if (journal.snapshot().any { it.plan.requestId == requestId || it.blocksAnotherInstall }) throw DeviceFault("apk_install_in_progress")
        imports.candidate(requestId) { context.contentResolver.openInputStream(uri) ?: throw DeviceFault("apk_import_unavailable") }
    }

    internal fun previewApkUpdate(requestId: String, completed: (Result<ApkUpdateReview>) -> Unit) = apkLocal(completed) { imports, _ ->
        requireApkStopped()
        val files = imports.files(requestId)
        // 预览可展示开发包，批准时仍必须由本机可见页面明确允许。
        AndroidApkMaterials.read(context, files.bundle, files.candidate, true).review(requestId)
    }

    internal fun approveApkUpdate(review: ApkUpdateReview, allowDebug: Boolean, completed: (Result<ApkInstallRecord>) -> Unit) = apkLocal(completed) { imports, journal ->
        requireApkStopped()
        val files = imports.files(review.requestId)
        val materials = AndroidApkMaterials.read(context, files.bundle, files.candidate, allowDebug)
        if (materials.review(review.requestId) != review) throw DeviceFault("apk_preflight_materials_changed")
        val plan = materials.plan(review.requestId, store.apkContinuity())
        synchronized(lock) {
            requireApkStopped()
            if (!visible) throw DeviceFault("apk_install_visible_approval_required")
            journal.prepare(plan)
        }
    }

    internal fun cancelPreparedApkUpdate(requestId: String, completed: (Result<ApkInstallRecord>) -> Unit) = apkLocal(completed) { _, journal ->
        requireApkStopped()
        journal.cancelPrepared(requestId)
    }

    internal fun discardApkImport(requestId: String, completed: (Result<Unit>) -> Unit) = apkLocal(completed) { imports, journal ->
        requireApkStopped()
        if (journal.snapshot().any { it.plan.requestId == requestId }) throw DeviceFault("apk_import_record_retained")
        imports.discard(requestId)
    }

    private fun requireApkInteraction(interaction: RunPermit) = synchronized(lock) {
        requireApkStopped()
        if (!visible || !interaction.active) throw DeviceFault("apk_install_visible_approval_required")
    }

    /** 设置返回只刷新；调用方必须再次明确继续，不能用Activity结果码授予安装资格。 */
    internal fun apkSourceSettings(requestId: String, interaction: RunPermit, completed: (Result<Intent?>) -> Unit) = apkLocal(completed) { _, journal ->
        requireApkInteraction(interaction)
        val record = apkRecord(journal, requestId)
        if (record.phase !in setOf(ApkInstallPhase.PREPARED, ApkInstallPhase.CREATED, ApkInstallPhase.STAGED)) throw DeviceFault("apk_install_resolve_required")
        AndroidApkInstallPolicy(context).sourceAuthorizationIntent()
    }

    /** 只恢复创建意图；其余阶段读原账本。没有会话不能证明未创建，不能补建或重提交。 */
    internal fun recoverApkUpdate(requestId: String, completed: (Result<ApkInstallRecord>) -> Unit) = apkLocal(completed) { _, journal ->
        requireApkStopped()
        val record = apkRecord(journal, requestId)
        if (record.phase == ApkInstallPhase.CREATING) AndroidApkInstaller(context, journal, {}).resolveCreation(requestId) else record
    }

    /** 预览不改原记录；仅已有系统成功的原任务可进入本机健康核对。 */
    internal fun previewApkHealth(requestId: String, interaction: RunPermit, completed: (Result<ApkLocalHealthReview>) -> Unit) = apkLocal(completed) { _, journal ->
        requireApkInteraction(interaction)
        val record = apkRecord(journal, requestId)
        if (record.phase != ApkInstallPhase.INSTALLED_UNVERIFIED) throw DeviceFault("apk_install_health_not_ready")
        val health = AndroidApkHealth(context, store).inspect(record.plan)
        requireApkInteraction(interaction)
        ApkLocalHealthReview(requestId, health)
    }

    /** 接受时重新完整核对；只保存本机健康决定，不连接、不重放命令、不再安装。 */
    internal fun acceptApkHealth(review: ApkLocalHealthReview, interaction: RunPermit, completed: (Result<ApkInstallRecord>) -> Unit) = apkLocal(completed) { _, journal ->
        requireApkInteraction(interaction)
        val record = apkRecord(journal, review.requestId)
        if (record.phase == ApkInstallPhase.LOCAL_HEALTH_ACCEPTED) {
            if (record.localHealth != review.health) throw DeviceFault("apk_install_health_mismatch")
            return@apkLocal record
        }
        if (record.phase != ApkInstallPhase.INSTALLED_UNVERIFIED) throw DeviceFault("apk_install_health_not_ready")
        val health = AndroidApkHealth(context, store).inspect(record.plan)
        if (health != review.health) throw DeviceFault("apk_install_health_mismatch")
        synchronized(lock) {
            requireApkInteraction(interaction)
            journal.acceptLocalHealth(review.requestId) { health }
        }
    }

    private fun inspectApkPackageRecovery(record: ApkInstallRecord): ApkLocalHealth {
        if (record.phase !in setOf(ApkInstallPhase.COMMITTING, ApkInstallPhase.PENDING_USER) || record.sessionId == null)
            throw DeviceFault("apk_install_package_recovery_not_ready")
        val sessions = AndroidApkSessions(context)
        sessions.requireNoOwnedSessions()
        val health = AndroidApkHealth(context, store).inspect(record.plan)
        sessions.requireNoOwnedSessions()
        return health
    }

    /** 原回执缺失时独立核对已运行候选；预览不写账本，也不推断原系统会话成功。 */
    internal fun previewApkPackageRecovery(requestId: String, interaction: RunPermit, completed: (Result<ApkPackageRecoveryReview>) -> Unit) = apkLocal(completed) { _, journal ->
        requireApkInteraction(interaction)
        val record = apkRecord(journal, requestId)
        val health = inspectApkPackageRecovery(record)
        requireApkInteraction(interaction)
        ApkPackageRecoveryReview(requestId, record.phase, record.sessionId!!, health)
    }

    /** 可见页面再次明确接受；保留原提交/会话与缺回执事实，只解除本机连接阻断。 */
    internal fun acceptApkPackageRecovery(review: ApkPackageRecoveryReview, interaction: RunPermit, completed: (Result<ApkInstallRecord>) -> Unit) = apkLocal(completed) { _, journal ->
        requireApkInteraction(interaction)
        val record = apkRecord(journal, review.requestId)
        if (record.phase == ApkInstallPhase.LOCAL_PACKAGE_RECOVERED) {
            if (record.recoveredFrom != review.fromPhase || record.sessionId != review.sessionId || record.localHealth != review.health)
                throw DeviceFault("apk_install_health_mismatch")
            return@apkLocal record
        }
        if (record.phase != review.fromPhase || record.sessionId != review.sessionId) throw DeviceFault("apk_install_package_recovery_not_ready")
        val health = inspectApkPackageRecovery(record)
        if (health != review.health) throw DeviceFault("apk_install_health_mismatch")
        synchronized(lock) {
            requireApkInteraction(interaction)
            AndroidApkSessions(context).requireNoOwnedSessions()
            journal.recoverInstalledPackage(review.requestId, review.fromPhase) { _, _ -> health }
        }
    }

    private fun apkRecord(journal: ApkInstallJournal, requestId: String) = journal.snapshot().singleOrNull { it.plan.requestId == requestId }
        ?: throw DeviceFault("apk_install_not_found")

    private fun apkReviewedMaterials(imports: AndroidApkImports, record: ApkInstallRecord, review: ApkUpdateReview, allowDebug: Boolean): AndroidApkMaterials {
        val files = imports.files(record.plan.requestId)
        val materials = AndroidApkMaterials.read(context, files.bundle, files.candidate, allowDebug)
        if (materials.review(record.plan.requestId) != review) throw DeviceFault("apk_preflight_materials_changed")
        materials.verifyCurrent(record.plan)
        return materials
    }

    private fun verifyApkConfirmationSession(record: ApkInstallRecord) {
        val id = record.sessionId ?: throw DeviceFault("apk_install_session_mismatch")
        val claims = AndroidApkSessions(context).ownSessions().filter { it.sessionId == id }
        if (claims.singleOrNull() != ApkSessionClaim(id, record.plan.digest, ApkInstallJournal.PACKAGE, record.plan.candidateBytes))
            throw DeviceFault("apk_install_session_mismatch")
    }

    /** 显式继续原任务；每个效果边界/流块核对同一前台许可，离开后该许可永久失效。 */
    internal fun continueApkUpdate(review: ApkUpdateReview, allowDebug: Boolean, interaction: RunPermit, completed: (Result<ApkInstallRecord>) -> Unit) = apkLocal(completed) { imports, journal ->
        val original = apkRecord(journal, review.requestId)
        if (original.phase !in setOf(ApkInstallPhase.PREPARED, ApkInstallPhase.CREATED, ApkInstallPhase.STAGED))
            return@apkLocal original // 未知/已提交/终态只读；不依赖材料仍在、不补造效果。
        requireApkInteraction(interaction)
        val materials = apkReviewedMaterials(imports, original, review, allowDebug)
        val provider = AndroidApkInstaller(context, journal, { plan ->
            requireApkInteraction(interaction); materials.verifyCurrent(plan)
        }, verifyContinuity = { plan ->
            requireApkInteraction(interaction); materials.verifyBoundary(plan); store.apkContinuity().verify(plan)
        })
        var current = original
        if (current.phase == ApkInstallPhase.PREPARED) current = provider.create(review.requestId)
        if (current.phase == ApkInstallPhase.CREATED) current = provider.stage(review.requestId) { materials.openCandidate(current.plan) }
        if (current.phase == ApkInstallPhase.STAGED) current = provider.commit(review.requestId)
        current
    }

    /** 完整检查在原队列；最后在主线程重验原账本/来源/同一许可后才由可见页面启动系统确认。 */
    internal fun openApkConfirmation(
        review: ApkUpdateReview, allowDebug: Boolean, interaction: RunPermit,
        launch: (Intent) -> Unit, completed: (Result<Unit>) -> Unit,
    ) { io.execute {
        val checked = runCatching {
            ApkInstallOwner.lock.withLock {
                requireApkInteraction(interaction)
                AndroidApkInstallStore(context).use { updates ->
                    val record = apkRecord(ApkInstallJournal(updates), review.requestId)
                    if (record.phase != ApkInstallPhase.PENDING_USER) throw DeviceFault("apk_install_resolve_required")
                    val materials = apkReviewedMaterials(AndroidApkImports(context), record, review, allowDebug)
                    AndroidApkInstallPolicy(context).verify()
                    materials.verifyBoundary(record.plan); store.apkContinuity().verify(record.plan)
                    verifyApkConfirmationSession(record)
                    ApkInstallConfirmations.intent(context, record) // 临时入口存在且当前仍解析为受信任系统组件。
                    Triple(record, materials, SystemClock.elapsedRealtime())
                }
            }
        }
        main.post {
            val result = checked.mapCatching { (record, materials, checkedAt) ->
                if (!ApkInstallOwner.lock.tryLock()) throw DeviceFault("apk_install_interaction_busy")
                try {
                    synchronized(lock) {
                        requireApkInteraction(interaction)
                        if (SystemClock.elapsedRealtime() - checkedAt !in 0..5000) throw DeviceFault("apk_install_confirmation_expired")
                        AndroidApkInstallStore(context).use { updates ->
                            if (apkRecord(ApkInstallJournal(updates), review.requestId) != record) throw DeviceFault("apk_install_resolve_required")
                        }
                        AndroidApkInstallPolicy(context).verify(); materials.verifyCurrent(record.plan)
                        verifyApkConfirmationSession(record)
                        launch(ApkInstallConfirmations.intent(context, record))
                    }
                } finally { ApkInstallOwner.lock.unlock() }
            }
            completed(result)
        }
    } }

    private fun <T> apkLocal(completed: (Result<T>) -> Unit, operation: (AndroidApkImports, ApkInstallJournal) -> T) { io.execute {
        val result = runCatching {
            ApkInstallOwner.lock.withLock {
                AndroidApkInstallStore(context).use { updates -> operation(AndroidApkImports(context), ApkInstallJournal(updates)) }
            }
        }
        main.post { completed(result) }
    } }

    private fun <T> runApkInstallation(
        verifyMaterials: (ApkInstallPlan) -> Unit,
        verifyPreflightBoundary: (ApkInstallPlan) -> Unit,
        operation: (ApkInstallJournal, AndroidApkInstaller) -> T,
        completed: (Result<T>) -> Unit,
    ) { io.execute {
        val result = runCatching {
            ApkInstallOwner.lock.withLock {
                requireApkStopped()
                AndroidApkInstallStore(context).use { updates ->
                    val journal = ApkInstallJournal(updates)
                    val provider = AndroidApkInstaller(context, journal, { plan ->
                        requireApkStopped()
                        verifyMaterials(plan)
                    }, verifyContinuity = { plan ->
                        requireApkStopped()
                        verifyPreflightBoundary(plan)
                        store.apkContinuity().verify(plan)
                    })
                    operation(journal, provider)
                }
            }
        }
        main.post { completed(result) }
    } }

    fun backgroundLimit(): String = if (Build.VERSION.SDK_INT >= 29)
        "本系统限制后台启动应用。只有此页面在前台时接受应用启动；不会申请跨应用输入或系统权限。"
    else "可启动当前已安装、启用且在本机明确允许的电视应用。输入提交不代表目标界面已显示。"
}
