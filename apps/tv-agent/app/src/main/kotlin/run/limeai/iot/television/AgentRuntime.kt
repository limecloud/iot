package run.limeai.iot.television

import android.app.Application
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import run.limeai.iot.device.*
import java.io.ByteArrayOutputStream
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors

class TelevisionApplication : Application() {
    val runtime: AgentRuntime by lazy { AgentRuntime(this) }
}

data class EnrollmentSummary(val space: String, val device: String, val broker: String, val ca: String, val certificate: String, val expires: String, val model: String, val revision: String)
data class AgentScreen(
    val status: String = "stopped", val notice: String = "", val summary: EnrollmentSummary? = null,
    val applications: List<AndroidApplications.Entry> = emptyList(), val allowed: Set<String> = emptySet(),
)

/** 单进程、单运行实例；Activity不是连接Owner，旧许可从不复活。 */
class AgentRuntime(private val context: Context) {
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor { Thread(it, "tv-agent-storage") }
    private val store = AndroidAgentStore(context)
    private val lock = Any()
    private val observers = CopyOnWriteArraySet<() -> Unit>()
    private var permit: RunPermit? = null
    private var mqtt: DeviceMqtt? = null
    private var visible = false
    @Volatile var screen = AgentScreen(); private set
    val running: Boolean get() = synchronized(lock) { permit != null }
    fun observe(observer: () -> Unit) { observers += observer; observer() }
    fun remove(observer: () -> Unit) { observers -= observer }
    fun setVisible(value: Boolean) { synchronized(lock) { visible = value } }
    private fun update(change: (AgentScreen) -> AgentScreen) { main.post { screen = change(screen); observers.forEach { it() } } }
    fun notice(value: String) { update { it.copy(notice = value) } }
    private fun failure(error: Exception): String = when (error) {
        is AgentStoreFault -> error.code
        is DeviceFault -> error.code
        else -> "storage_or_credentials_unavailable"
    }
    fun summary(enrollment: DeviceEnrollment) = EnrollmentSummary(enrollment.identity.space, enrollment.identity.device, enrollment.broker,
        enrollment.caFingerprint, enrollment.certificateFingerprint, DateFormat.getDateTimeInstance().format(Date(enrollment.certificateExpiresAt)), enrollment.identity.profile.id, enrollment.identity.profile.revision)

    fun refresh() { io.execute {
        try {
            val enrollment = store.load(); val allowed = store.allowed(); val applications = AndroidApplications.discover(context)
            update { it.copy(summary = enrollment?.let(::summary), applications = applications, allowed = allowed) }
        } catch (error: Exception) { notice(failure(error)) }
    } }

    fun readEnrollment(uri: Uri, callback: (DeviceEnrollment) -> Unit) { io.execute {
        try {
            val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
                val output = ByteArrayOutputStream(); val block = ByteArray(4096)
                while (true) {
                    val n = input.read(block); if (n < 0) break
                    if (output.size() + n > 32768) throw DeviceFault("invalid_enrollment")
                    output.write(block, 0, n)
                }
                output.toByteArray()
            } ?: throw DeviceFault("invalid_enrollment")
            val enrollment = try { DeviceEnrollment.parse(bytes) } finally { bytes.fill(0) }
            main.post { callback(enrollment) }
        } catch (error: Exception) { notice(failure(error)) }
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
            synchronized(lock) { store.authorize(application, allow) }
            val allowed = store.allowed()
            update { it.copy(allowed = allowed, notice = "") }
        } catch (error: Exception) { notice(failure(error)); refresh() }
    } }

    fun start(finished: () -> Unit) {
        val current = synchronized(lock) {
            if (permit != null) return
            RunPermit().also { permit = it }
        }
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
                val applications = AndroidApplications(context, { it in store.allowed() }, lock, current) { visible }
                val client = DeviceMqtt(enrollment.identity, enrollment.broker, enrollment.tls(), storage, applications,
                    object : DeviceClock { override fun elapsedMillis() = SystemClock.elapsedRealtime() }) { state ->
                    if (current.active) update {
                        if (!current.active) return@update it
                        if (state in setOf("connecting", "handshaking", "ready", "stopped", "connection_unavailable")) it.copy(status = state)
                        else it.copy(status = state, notice = state)
                    }
                }
                synchronized(lock) { mqtt = client; if (!current.active) client.close() }
                client.run()
            } catch (error: Exception) { failed = failure(error) }
            finally {
                synchronized(lock) { current.stop(); mqtt?.close(); mqtt = null; if (permit === current) permit = null }
                val lastFailure = failed
                update { if (lastFailure == null) it.copy(status = "stopped") else it.copy(status = "stopped", notice = lastFailure) }
                main.post { if (!running) finished() }
            }
        }, "tv-agent-mqtt").start()
    }

    fun stop() {
        synchronized(lock) { permit?.stop(); mqtt?.close() }
        update { it.copy(status = if (running) "stopping" else "stopped") }
    }

    fun backgroundLimit(): String = if (Build.VERSION.SDK_INT >= 29)
        "本系统限制后台启动应用。只有此页面在前台时接受应用启动；不会申请跨应用输入或系统权限。"
    else "可启动当前已安装、启用且在本机明确允许的电视应用。输入提交不代表目标界面已显示。"
}
