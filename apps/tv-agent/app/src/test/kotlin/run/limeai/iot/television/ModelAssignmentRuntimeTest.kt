package run.limeai.iot.television

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import org.robolectric.util.ReflectionHelpers
import run.limeai.iot.device.*
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.withLock
import kotlin.test.*

internal fun pumpModel(condition: () -> Boolean) {
    val deadline = System.nanoTime() + 2_000_000_000L
    while (!condition() && System.nanoTime() < deadline) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(5) }
    shadowOf(Looper.getMainLooper()).idle()
    assertTrue(condition(), "能力配置结果未在2秒观察预算内到达")
}

/** 实际Runtime队列、EC与SQLite；受控连接不运行MQTT或接触电视。 */
internal class ModelAssignmentRuntimeFixture(private val context: Context) : AutoCloseable {
    val keys = LocalIdentityStoreTest.TestKeys()
    private val vault = LocalIdentityStoreTest.TestVault()
    fun storage() = AndroidAgentStore(context, vault, keys)
    val original = storage().use { store ->
        val view = store.requestIdentity(IdentityFixtures.setup("model-assignment", "ssl://localhost:8883"))
        store.previewCertificate(IdentityFixtures.sign(view.request!!.pem)).also {
            store.activateIdentity(it); store.journal(it.binding).commit(ApkJournalFixture.bytes(it.identity))
        }
    }
    val connections = CopyOnWriteArrayList<Connection>()
    val runtime = AgentRuntime(context, ::storage) { mqtt -> Connection(mqtt).also(connections::add) }
    init { runtime.refresh(); pumpModel { runtime.screen.summary != null }; runtime.setVisible(true) }
    fun <T> awaitResult(operation: ((Result<T>) -> Unit) -> Unit): Result<T> {
        val result = AtomicReference<Result<T>?>(null)
        operation { result.set(it) }; pumpModel { result.get() != null }
        return result.get()!!
    }
    fun review(target: DeviceModelProfile = DeviceModelProfile.AUDIO_APPLICATIONS) = awaitResult<ModelAssignmentReview> {
        runtime.previewModelAssignment(target, it)
    }
    fun approve(review: ModelAssignmentReview) = awaitResult<Unit> { runtime.approveModelAssignment(review, it) }
    fun <T> inspect(action: (AndroidAgentStore) -> T): T = awaitResult<T> { completed ->
        ReflectionHelpers.getField<ExecutorService>(runtime, "io").execute {
            val result = runCatching { action(ReflectionHelpers.getField(runtime, "store")) }
            Handler(Looper.getMainLooper()).post { completed(result) }
        }
    }.getOrThrow()
    fun start(): Connection {
        runtime.start {}
        pumpModel { connections.lastOrNull()?.entered?.count == 0L }
        return connections.last()
    }
    override fun close() {
        runtime.stop(); connections.forEach { it.release.countDown() }; pumpModel { !runtime.running }
        ReflectionHelpers.getField<ExecutorService>(runtime, "io").also {
            it.shutdown(); assertTrue(it.awaitTermination(2, TimeUnit.SECONDS))
        }
        ReflectionHelpers.getField<AndroidAgentStore>(runtime, "store").close()
    }
    class Connection(private val mqtt: DeviceMqtt) : AgentConnection {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        override fun run() { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
        override fun close() { mqtt.close() }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, shadows = [ApkImportLinuxFixture::class])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class ModelAssignmentRuntimeTest {
    private fun fixture() = ModelAssignmentRuntimeFixture(RuntimeEnvironment.getApplication())
    private fun code(result: Result<*>): String = when (val error = result.exceptionOrNull()) {
        is DeviceFault -> error.code
        is AgentStoreFault -> error.code
        else -> fail("预期明确拒绝，实际为$error")
    }

    @Test fun foreground_review_expires_after_background_and_forged_cancelled_or_duplicate_approvals_are_refused() {
        fixture().use { f ->
            val old = f.review().getOrThrow()
            f.runtime.setVisible(false); f.runtime.setVisible(true)
            assertEquals("model_review_expired", code(f.approve(old)))
            val cancelled = f.review().getOrThrow(); f.runtime.cancelModelAssignment(cancelled)
            assertEquals("model_review_expired", code(f.approve(cancelled)))
            val review = f.review().getOrThrow()
            assertEquals("model_review_expired", code(f.approve(ModelAssignmentReview(review.preview, review.foreground))))
            f.approve(review).getOrThrow()
            assertEquals("model_review_expired", code(f.approve(review)))
            f.inspect {
                val next = it.load()!!
                assertEquals(DeviceModelProfile.AUDIO_APPLICATIONS, next.identity.profile)
                assertEquals(f.original.keyReference, next.keyReference); assertEquals(f.original.certificateFingerprint, next.certificateFingerprint)
            }
            assertTrue(f.connections.isEmpty()); assertFalse(f.runtime.running); assertFalse(f.runtime.screen.audioAuthorized)
            assertEquals(1, f.keys.creates); assertEquals(0, f.keys.retirements)
        }
    }

    @Test fun exact_storage_changes_are_rechecked_and_failed_approval_is_consumed() {
        fixture().use { f ->
            val review = f.review().getOrThrow()
            f.inspect { it.authorize("com.example.player", true) }
            assertEquals("model_assignment_changed", code(f.approve(review)))
            assertEquals("model_review_expired", code(f.approve(review)))
            f.approve(f.review().getOrThrow()).getOrThrow()
            f.inspect { assertEquals(setOf("com.example.player"), it.allowed()) }
        }
    }

    @Test fun running_and_stop_requested_workers_block_assignment_until_connection_cleanup() {
        fixture().use { f ->
            val old = f.review().getOrThrow()
            val connection = f.start()
            assertEquals("apk_install_stop_required", code(f.review()))
            f.runtime.stop(); assertTrue(f.runtime.running)
            assertEquals("apk_install_stop_required", code(f.review()))
            connection.release.countDown(); pumpModel { !f.runtime.running }
            assertEquals("model_review_expired", code(f.approve(old)))
            f.approve(f.review().getOrThrow()).getOrThrow()
            assertEquals(1, f.connections.size)
        }
    }

    @Test fun original_apk_task_blocks_both_preview_and_previously_reviewed_assignment() {
        fixture().use { f ->
            val review = f.review().getOrThrow()
            ApkInstallOwner.lock.withLock {
                AndroidApkInstallStore(RuntimeEnvironment.getApplication()).use {
                    fun pin(c: Char) = "sha256:" + c.toString().repeat(64)
                    ApkInstallJournal(it).prepare(ApkInstallPlan("model-update", f.original.binding, pin('a'), pin('b'), pin('c'), 3, 4, 3, pin('d'), pin('e')))
                }
            }
            assertEquals("apk_install_in_progress", code(f.approve(review)))
            assertEquals("apk_install_in_progress", code(f.review()))
            f.inspect { assertEquals(DeviceModelProfile.APPLICATIONS, it.load()!!.identity.profile) }
            assertTrue(f.connections.isEmpty())
        }
    }

    @Test fun background_while_waiting_for_install_owner_cannot_create_a_new_valid_review() {
        fixture().use { f ->
            val result = AtomicReference<Result<ModelAssignmentReview>?>(null)
            ApkInstallOwner.lock.withLock {
                f.runtime.previewModelAssignment(DeviceModelProfile.AUDIO_APPLICATIONS) { result.set(it) }
                f.runtime.setVisible(false); f.runtime.setVisible(true)
            }
            pumpModel { result.get() != null }
            assertEquals("model_review_expired", code(result.get()!!))
            assertEquals(DeviceModelProfile.APPLICATIONS, f.inspect { it.load()!!.identity.profile })
        }
    }

    @Test fun stop_while_waiting_for_owner_invalidates_captured_foreground_even_without_a_worker() {
        fixture().use { f ->
            val result = AtomicReference<Result<ModelAssignmentReview>?>(null)
            ApkInstallOwner.lock.withLock {
                f.runtime.previewModelAssignment(DeviceModelProfile.AUDIO_APPLICATIONS) { result.set(it) }
                f.runtime.stop()
            }
            pumpModel { result.get() != null }
            assertEquals("model_review_expired", code(result.get()!!))
            f.approve(f.review().getOrThrow()).getOrThrow()
            assertTrue(f.connections.isEmpty())
        }
    }
}
