package run.limeai.iot.television

import android.Manifest
import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageManager
import android.os.Looper
import kotlinx.serialization.json.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import org.robolectric.util.ReflectionHelpers
import run.limeai.iot.device.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.*

internal fun pumpAudio(condition: () -> Boolean) {
    val deadline = System.nanoTime() + 2_000_000_000L
    while (!condition() && System.nanoTime() < deadline) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(5) }
    shadowOf(Looper.getMainLooper()).idle()
    assertTrue(condition(), "音频结果未在2秒观察预算内到达")
}

/** Runtime真实线程/SQLite/TLS材料检查；连接在线与音频服务是明确宿主夹具，不建立Socket。 */
internal class AudioRuntimeFixture(application: Context) : AutoCloseable {
    @Volatile var permission = true
    val blockOpen = AtomicBoolean()
    val openEntered = CountDownLatch(1)
    val releaseOpen = CountDownLatch(1)
    val context = object : ContextWrapper(application) {
        override fun checkSelfPermission(name: String) = if (name == Manifest.permission.MODIFY_AUDIO_SETTINGS) {
            if (permission) PackageManager.PERMISSION_GRANTED else PackageManager.PERMISSION_DENIED
        } else super.checkSelfPermission(name)
    }
    private val vault = object : EnrollmentVault {
        override fun seal(bytes: ByteArray, binding: String) = bytes.copyOf()
        override fun open(bytes: ByteArray, binding: String): ByteArray {
            if (Thread.currentThread().name == "tv-agent-mqtt" && blockOpen.compareAndSet(true, false)) {
                openEntered.countDown(); check(releaseOpen.await(5, TimeUnit.SECONDS))
            }
            return bytes.copyOf()
        }
    }
    val enrollment = DeviceEnrollment.parse(JsonObject(DeviceDocument.parse(Fixtures.enrollment.encoded()) + mapOf(
        "schema_version" to JsonPrimitive(2), "model_profile" to JsonPrimitive("android-tv-audio-agent"))).toString().toByteArray())
    val agentStore = AndroidAgentStore(context, vault)
    val connections = CopyOnWriteArrayList<Connection>()
    val finished = AtomicInteger()
    val runtime: AgentRuntime
    init {
        agentStore.install(enrollment)
        runtime = AgentRuntime(context, { agentStore }) { mqtt -> Connection(mqtt).also(connections::add) }
        runtime.refresh(); pumpAudio { runtime.screen.summary != null }
        runtime.setVisible(true)
    }
    fun approve(): AudioStartReview = runtime.reviewAudioStart().also { assertTrue(runtime.approveAudioStart(it)) }
    fun start(): Connection {
        val size = connections.size
        runtime.start { finished.incrementAndGet() }
        pumpAudio { connections.size == size + 1 && connections.last().entered.count == 0L }
        return connections.last()
    }
    fun release(connection: Connection, stop: Boolean = true) {
        val count = finished.get()
        if (stop) runtime.stop()
        connection.released.set(true)
        pumpAudio { !runtime.running && finished.get() > count }
    }
    override fun close() {
        releaseOpen.countDown(); runtime.stop(); connections.forEach { it.released.set(true) }
        pumpAudio { !runtime.running }
        val storage = ReflectionHelpers.getField<ExecutorService>(runtime, "io")
        storage.shutdown()
        assertTrue(storage.awaitTermination(2, TimeUnit.SECONDS), "原存储队列未在2秒观察预算内退出")
        agentStore.close()
    }

    inner class Connection(private val mqtt: DeviceMqtt) : AgentConnection {
        val entered = CountDownLatch(1)
        val released = AtomicBoolean()
        val closes = AtomicInteger()
        private val jobs = LinkedBlockingQueue<() -> Unit>()
        private val agent = ReflectionHelpers.getField<DeviceAgent>(mqtt, "agent")
        val port: AudioPort = ReflectionHelpers.getField(agent, "audio")
        private val epoch = System.currentTimeMillis()
        override fun run() {
            // 只设置宿主连接事实，实际DeviceMqtt.run及MQTT/TLS网络均不执行。
            ReflectionHelpers.getField<AtomicBoolean>(mqtt, "online").set(true)
            entered.countDown()
            val deadline = System.nanoTime() + 5_000_000_000L
            while (!released.get()) {
                check(System.nanoTime() < deadline) { "fixture worker not released" }
                jobs.poll(20, TimeUnit.MILLISECONDS)?.invoke()
            }
        }
        override fun close() { mqtt.close(); closes.incrementAndGet() }
        private fun <T> call(action: () -> T): T {
            val result = CompletableFuture<T>()
            jobs.put { try { result.complete(action()) } catch (error: Throwable) { result.completeExceptionally(error) } }
            return result.get(2, TimeUnit.SECONDS)
        }
        private fun time(offset: Long = 0) = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date(epoch + offset))
        private fun envelope(kind: String, body: JsonObject, id: String = "message") = buildJsonObject {
            put("v", 1); put("kind", kind); put("message_id", id); put("device_id", enrollment.identity.device)
            put("model_revision", enrollment.identity.profile.revision); put("session_id", "session"); put("body", body)
        }
        fun handshake(): JsonObject = call {
            val hello = DeviceDocument.parse(agent.connected().payload)
            val welcome = envelope("welcome", buildJsonObject {
                put("challenge", hello.getValue("body").jsonObject.getValue("challenge")); put("time", time())
                put("max_packet_bytes", 16384); put("receipt_ledger", 1); put("command_sequence", 0)
            })
            val topic = "limeiot/v1/${enrollment.identity.space}/${enrollment.identity.device}/down/welcome"
            DeviceDocument.parse(agent.receive(topic, welcome.toString().toByteArray()).single().payload)
        }
        fun volume(percent: Int, sequence: Int = 1): JsonObject = call {
            val id = "c1-$sequence-00000000-0000-4000-8000-000000000001"
            val command = envelope("command", buildJsonObject {
                put("command_id", id); put("issued_at", time()); put("expires_at", time(20000))
                put("operation", buildJsonObject {
                    put("type", "action.invoke"); put("path", "audio.set_volume")
                    put("value", buildJsonObject { put("percent", percent) })
                })
            }, id)
            val topic = "limeiot/v1/${enrollment.identity.space}/${enrollment.identity.device}/down/command"
            DeviceDocument.parse(agent.receive(topic, command.toString().toByteArray()).single().payload).getValue("body").jsonObject
        }
        fun heartbeat(): JsonObject = call { DeviceDocument.parse(agent.heartbeat()!!.payload) }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, shadows = [AndroidAudioTest.Mixer::class, ApkImportLinuxFixture::class])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class AudioRuntimeTest {
    @Before fun setup() { AndroidAudioTest.Mixer.reset() }
    private fun fixture() = AudioRuntimeFixture(RuntimeEnvironment.getApplication())

    @Test fun no_explicit_approval_refuses_connection_creation_and_keeps_audio_untouched() {
        fixture().use { f ->
            f.runtime.start { f.finished.incrementAndGet() }
            pumpAudio { !f.runtime.running && f.finished.get() == 1 }
            assertTrue(f.connections.isEmpty()); assertFalse(f.runtime.screen.audioAuthorized)
            assertTrue(AndroidAudioTest.Mixer.volumes.isEmpty()); assertTrue(AndroidAudioTest.Mixer.adjustments.isEmpty())
            assertTrue(f.runtime.screen.notice.contains("尚未允许"))
        }
    }

    @Test fun explicit_run_connects_real_audio_port_to_consumer_and_native_observations_stay_independent() {
        fixture().use { f ->
            f.approve(); val connection = f.start(); val state = connection.handshake()
            pumpAudio { f.runtime.screen.audioAuthorized }
            assertEquals(setOf("audio.volume", "audio.muted"), state.getValue("body").jsonObject.getValue("properties").jsonArray.map { it.jsonObject.getValue("path").jsonPrimitive.content }.toSet())
            val result = connection.volume(5)
            assertEquals("confirmed", result.getValue("status").jsonPrimitive.content)
            assertEquals("submitted", result.getValue("evidence").jsonObject.getValue("completion").jsonPrimitive.content)
            assertEquals(1, AndroidAudioTest.Mixer.volumes.single().second); assertEquals(0, AndroidAudioTest.Mixer.volumes.single().third)
            assertEquals(1, DeviceJournalInspection.inspect(f.enrollment.identity, f.agentStore.journal(f.enrollment.binding).read()).confirmed)
            AndroidAudioTest.Mixer.index = 1
            val properties = connection.heartbeat().getValue("body").jsonObject.getValue("properties").jsonArray
            assertEquals(7, properties.single { it.jsonObject.getValue("path").jsonPrimitive.content == "audio.volume" }.jsonObject.getValue("value").jsonPrimitive.int)
            assertEquals(result, connection.volume(5)); assertEquals(1, AndroidAudioTest.Mixer.volumes.size)
            f.release(connection)
        }
    }

    @Test fun revoke_during_original_credential_load_prevents_later_bind_or_connection() {
        fixture().use { f ->
            f.approve(); f.blockOpen.set(true)
            f.runtime.start { f.finished.incrementAndGet() }
            assertTrue(f.openEntered.await(2, TimeUnit.SECONDS))
            f.runtime.revokeAudio(); f.releaseOpen.countDown()
            pumpAudio { !f.runtime.running && f.finished.get() == 1 }
            assertTrue(f.connections.isEmpty()); assertFalse(f.runtime.screen.audioAuthorized)
            assertTrue(AndroidAudioTest.Mixer.volumes.isEmpty()); assertTrue(AndroidAudioTest.Mixer.adjustments.isEmpty())
        }
    }

    @Test fun stop_or_revoke_invalidates_old_port_and_new_approval_never_reactivates_it() {
        fixture().use { f ->
            val review = f.approve(); val old = f.start(); assertTrue(old.port.permitted())
            f.runtime.revokeAudio()
            assertTrue(f.runtime.running); assertFalse(old.port.permitted())
            assertFailsWith<DeviceFault> { old.port.setMuted(true) }
            assertFalse(f.runtime.approveAudioStart(review))
            assertFailsWith<DeviceFault> { f.runtime.reviewAudioStart() }
            f.release(old)
            f.approve(); val fresh = f.start()
            assertTrue(fresh.port.permitted()); assertFalse(old.port.permitted())
            assertFailsWith<DeviceFault> { old.port.setVolume(50) }
            f.release(fresh)
            assertTrue(AndroidAudioTest.Mixer.volumes.isEmpty()); assertTrue(AndroidAudioTest.Mixer.adjustments.isEmpty())
        }
    }

    @Test fun approved_background_run_keeps_scope_but_system_permission_or_fixed_volume_blocks_effects() {
        fixture().use { f ->
            f.approve(); val connection = f.start()
            f.runtime.setVisible(false); assertTrue(connection.port.permitted())
            f.permission = false
            assertFalse(connection.port.permitted()); assertFailsWith<DeviceFault> { connection.port.setVolume(50) }
            f.permission = true; AndroidAudioTest.Mixer.fixed = true
            assertFalse(connection.port.permitted()); assertFailsWith<DeviceFault> { connection.port.setMuted(true) }
            AndroidAudioTest.Mixer.fixed = false; assertTrue(connection.port.permitted())
            f.release(connection)
            assertTrue(AndroidAudioTest.Mixer.volumes.isEmpty()); assertTrue(AndroidAudioTest.Mixer.adjustments.isEmpty())
        }
    }

    @Test fun normal_worker_exit_clears_scope_without_persisting_it_or_authorizing_another_start() {
        fixture().use { f ->
            val before = f.agentStore.journal(f.enrollment.binding).read()
            f.approve(); val connection = f.start(); f.release(connection, stop = false)
            assertFalse(f.runtime.screen.audioAuthorized)
            val count = f.finished.get(); f.runtime.start { f.finished.incrementAndGet() }
            pumpAudio { !f.runtime.running && f.finished.get() > count }
            assertEquals(1, f.connections.size)
            assertContentEquals(before, f.agentStore.journal(f.enrollment.binding).read()); assertTrue(f.agentStore.allowed().isEmpty())
        }
    }
}
