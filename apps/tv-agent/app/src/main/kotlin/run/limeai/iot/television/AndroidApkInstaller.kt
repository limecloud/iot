package run.limeai.iot.television

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import run.limeai.iot.device.*
import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** 安装机制专用端口；系统权限和停止/在途门禁由调用方强制核对。 */
internal interface ApkSessionApi {
    fun create(plan: ApkInstallPlan): Int
    fun ownSessions(): List<ApkSessionClaim>
    fun open(sessionId: Int): ApkSessionIo
}

internal interface ApkSessionIo : Closeable {
    fun names(): List<String>
    fun write(length: Long): OutputStream
    fun fsync(output: OutputStream)
    fun read(): InputStream
    fun commit(receiver: IntentSender)
}

/** 只使用API21已有的会话能力；没有静默安装、放宽签名或自动确认选项。 */
internal class AndroidApkSessions(private val context: Context) : ApkSessionApi {
    private val installer get() = context.packageManager.packageInstaller
    override fun create(plan: ApkInstallPlan): Int {
        if (context.packageName != ApkInstallJournal.PACKAGE) throw DeviceFault("apk_install_package_mismatch")
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(ApkInstallJournal.PACKAGE)
            setSize(plan.candidateBytes)
            setAppLabel(LABEL_PREFIX + plan.digest + "/" + plan.candidateBytes)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
        }
        return installer.createSession(params)
    }
    override fun ownSessions(): List<ApkSessionClaim> = installer.mySessions.mapNotNull { info ->
        // mySessions限定调用UID，再核对系统记录的安装来源；外部文件不能提供会话声明。
        if (info.installerPackageName != context.packageName) return@mapNotNull null
        val label = info.appLabel?.toString() ?: return@mapNotNull null
        if (!label.startsWith(LABEL_PREFIX)) return@mapNotNull null
        val fields = label.removePrefix(LABEL_PREFIX).split('/')
        if (fields.size != 2 || !Regex("sha256:[0-9a-f]{64}").matches(fields[0])) return@mapNotNull null
        val length = fields[1].toLongOrNull()?.takeIf { it in 1..268435456L && it.toString() == fields[1] } ?: return@mapNotNull null
        // API23没有getSize（API27）；声明长度来自系统保存的原创建元数据，实际字节另行读回验证。
        if (Build.VERSION.SDK_INT >= 27 && info.size != length) return@mapNotNull null
        ApkSessionClaim(info.sessionId, fields[0], info.appPackageName ?: "", length)
    }
    /** 独立恢复必须读取未过滤的原UID会话；坏标签不能被误当成会话已经消失。 */
    fun requireNoOwnedSessions() {
        try {
            if (context.packageName != ApkInstallJournal.PACKAGE) throw DeviceFault("apk_install_package_mismatch")
            val current = installer.mySessions
            if (current.size > 128) throw DeviceFault("apk_install_recovery_sessions_unavailable")
            if (current.isNotEmpty()) throw DeviceFault("apk_install_recovery_sessions_present")
        } catch (fault: DeviceFault) { throw fault }
        catch (_: Exception) { throw DeviceFault("apk_install_recovery_sessions_unavailable") }
    }
    override fun open(sessionId: Int): ApkSessionIo {
        val session = installer.openSession(sessionId)
        return object : ApkSessionIo {
            override fun names() = session.names.toList()
            override fun write(length: Long) = session.openWrite(BASE_APK, 0, length)
            override fun fsync(output: OutputStream) = session.fsync(output)
            override fun read() = session.openRead(BASE_APK)
            override fun commit(receiver: IntentSender) = session.commit(receiver)
            override fun close() = session.close()
        }
    }
    companion object {
        const val BASE_APK = "base.apk"
        const val LABEL_PREFIX = "LimeIoT update "
    }
}

/** 进程内所有提供方/回执共用Owner锁；跨实例决定仍由账本CAS防护。 */
internal object ApkInstallOwner { val lock = ReentrantLock() }

/** 必须在调用方持有停止/身份/材料门禁时使用；原阶段决定是否允许产生系统效果。 */
internal class AndroidApkInstaller(
    private val context: Context,
    private val journal: ApkInstallJournal,
    private val verifyCurrent: (ApkInstallPlan) -> Unit,
    private val sessions: ApkSessionApi = AndroidApkSessions(context),
    private val verifyInstalled: (ApkInstallPlan) -> Unit = AndroidInstalledApk(context)::verifyBaseline,
    private val verifyInstallPolicy: () -> Unit = AndroidApkInstallPolicy(context)::verify,
    private val verifyContinuity: (ApkInstallPlan) -> Unit = {},
) {
    private fun verifyEligibility(plan: ApkInstallPlan) {
        verifyInstallPolicy()
        verifyCurrent(plan)
    }
    private fun verifyBoundary(plan: ApkInstallPlan) {
        verifyInstalled(plan)
        verifyEligibility(plan)
        verifyContinuity(plan)
    }
    private fun record(requestId: String) = journal.snapshot().singleOrNull { it.plan.requestId == requestId }
        ?: throw DeviceFault("apk_install_not_found")

    private fun owned(record: ApkInstallRecord): Int {
        val id = record.sessionId ?: throw DeviceFault("apk_install_session_mismatch")
        val matches = sessions.ownSessions().filter { it.sessionId == id }
        if (matches.size != 1 || matches.single() != ApkSessionClaim(id, record.plan.digest, ApkInstallJournal.PACKAGE, record.plan.candidateBytes))
            throw DeviceFault("apk_install_session_mismatch")
        return id
    }

    fun create(requestId: String): ApkInstallRecord = ApkInstallOwner.lock.withLock {
        journal.createSession(requestId, ::verifyBoundary) { plan ->
            verifyBoundary(plan) // 创建意图已提交后再次核对，失权时不创建系统会话。
            sessions.create(plan)
        }
    }

    fun resolveCreation(requestId: String): ApkInstallRecord = ApkInstallOwner.lock.withLock {
        journal.resolveCreation(requestId, sessions.ownSessions())
    }

    /** 已有写入只读核对；部分写入或错误字节保留原会话，不自动覆盖、放弃或重建。 */
    fun stage(requestId: String, candidate: () -> InputStream): ApkInstallRecord = ApkInstallOwner.lock.withLock {
        val current = record(requestId)
        if (current.phase == ApkInstallPhase.STAGED) return@withLock current
        if (current.phase != ApkInstallPhase.CREATED) throw DeviceFault("apk_install_resolve_required")
        verifyBoundary(current.plan)
        sessions.open(owned(current)).use { session ->
            val names = session.names()
            if (names.isEmpty()) {
                verifyEligibility(current.plan)
                candidate().use { input ->
                    session.write(current.plan.candidateBytes).use { output ->
                        digest(input, current.plan) { block, count ->
                            verifyEligibility(current.plan)
                            output.write(block, 0, count)
                        }
                        verifyEligibility(current.plan)
                        session.fsync(output)
                    }
                }
            } else if (names != listOf(AndroidApkSessions.BASE_APK)) throw DeviceFault("apk_install_stage_mismatch")
            verifyBytes(session, current.plan)
        }
        verifyBoundary(current.plan)
        journal.staged(requestId, current.sessionId!!, current.plan.candidateSha256, current.plan.candidateBytes)
    }

    fun commit(requestId: String): ApkInstallRecord = ApkInstallOwner.lock.withLock {
        journal.commit(requestId, { plan ->
            verifyBoundary(plan)
            sessions.open(owned(record(requestId))).use { verifyBytes(it, plan) }
            verifyBoundary(plan)
        }) { _, sessionId ->
            // 账本意图已耐久且第二次核对已完成；Binder失败后沿原会话恢复，不再提交。
            sessions.open(sessionId).use { it.commit(resultSender(context, record(requestId))) }
        }
    }

    private fun verifyBytes(session: ApkSessionIo, plan: ApkInstallPlan) {
        if (session.names() != listOf(AndroidApkSessions.BASE_APK)) throw DeviceFault("apk_install_stage_mismatch")
        session.read().use { digest(it, plan) }
    }

    private fun digest(input: InputStream, plan: ApkInstallPlan, write: ((ByteArray, Int) -> Unit)? = null) {
        val hash = MessageDigest.getInstance("SHA-256")
        val block = ByteArray(65536)
        var size = 0L
        while (true) {
            verifyEligibility(plan)
            val count = input.read(block)
            verifyEligibility(plan)
            if (count < 0) break
            if (count == 0) throw DeviceFault("apk_install_stage_mismatch")
            size += count
            if (size > plan.candidateBytes) throw DeviceFault("apk_install_stage_mismatch")
            hash.update(block, 0, count)
            write?.invoke(block, count)
        }
        val value = "sha256:" + hash.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
        if (size != plan.candidateBytes || value != plan.candidateSha256) throw DeviceFault("apk_install_stage_mismatch")
    }

    companion object {
        const val RESULT_ACTION = "run.limeai.iot.television.APK_INSTALL_RESULT"
        fun resultIntent(context: Context, record: ApkInstallRecord): Intent {
            val id = record.sessionId ?: throw DeviceFault("apk_install_session_mismatch")
            val data = Uri.Builder().scheme("limeiot-apk").authority("result")
                .appendPath(record.plan.requestId).appendPath(record.plan.digest).appendPath(id.toString()).build()
            return Intent(context, ApkInstallResultReceiver::class.java).setAction(RESULT_ACTION).setData(data)
        }
        private fun resultSender(context: Context, record: ApkInstallRecord): IntentSender {
            // 系统须填充状态/确认Intent；固定显式组件及data身份，不能使用不可变或一次性PI。
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            return PendingIntent.getBroadcast(context, record.sessionId!!, resultIntent(context, record), flags).intentSender
        }
    }
}
