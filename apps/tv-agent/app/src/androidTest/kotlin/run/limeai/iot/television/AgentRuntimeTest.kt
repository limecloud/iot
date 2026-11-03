package run.limeai.iot.television

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Build
import android.os.SystemClock
import android.widget.Button
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import run.limeai.iot.device.*
import java.io.File
import java.net.Socket
import java.net.URI
import java.security.KeyStore
import java.util.concurrent.atomic.AtomicReference

/** 只在测试APK中运行；实际目标进程记录Activity启动次数，宿主独立核对。 */
class RuntimeTargetActivity : Activity() {
    private fun record(kind: String) {
        File(filesDir, "runtime-launches.jsonl").appendText(JSONObject()
            .put("delivery", kind).put("created_elapsed_ms", SystemClock.elapsedRealtime()).toString() + "\n")
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        record("create")
        setContentView(TextView(this).apply { text = "LimeIoT TV runtime fixture"; textSize = 24f })
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); record("new_intent") }
}

private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
private val context get() = instrumentation.targetContext
private fun enrollment(): DeviceEnrollment = instrumentation.context.assets.open("enrollment.json")
    .use { DeviceEnrollment.parse(it.readBytes()) }
private fun waitFor(label: String, timeout: Long = 15000, predicate: () -> Boolean) {
    val deadline = SystemClock.elapsedRealtime() + timeout
    while (SystemClock.elapsedRealtime() < deadline) {
        if (predicate()) return
        Thread.sleep(50)
    }
    fail("runtime timeout: $label")
}
private fun phase(value: String) {
    File(context.filesDir, "runtime-phase.next").writeText(value)
    check(File(context.filesDir, "runtime-phase.next").renameTo(File(context.filesDir, "runtime-phase")))
}
private fun signal(value: String) = waitFor("host signal $value", 60000) {
    File(context.filesDir, "runtime-signal").takeIf { it.isFile }?.readText() == value
}

@RunWith(AndroidJUnit4::class)
class AgentSecurityRuntimeTest {
    @Test fun actual_keystore_ciphertext_is_bound_and_corruption_is_rejected() {
        val vault = AndroidEnrollmentVault()
        val plain = "isolated runtime vault proof".toByteArray()
        val cipher = vault.seal(plain, "runtime-binding")
        assertFalse(cipher.contentEquals(plain))
        assertFalse(cipher.contentEquals(vault.seal(plain, "runtime-binding")))
        assertArrayEquals(plain, vault.open(cipher, "runtime-binding"))
        for ((bytes, binding) in listOf(cipher to "wrong-binding", cipher.copyOf().apply {
            this[lastIndex] = (this[lastIndex].toInt() xor 1).toByte()
        } to "runtime-binding")) {
            var rejected = false
            try { vault.open(bytes, binding) } catch (_: Exception) { rejected = true }
            assertTrue("GCM must reject wrong AAD and modified ciphertext", rejected)
        }
        val key = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            .getKey("limeiot-tv-enrollment-v1", null)
        assertNotNull(key)
        assertNull("Keystore AES key must not be exportable", key.encoded)
        assertArrayEquals(plain, vault.open(cipher, "runtime-binding"))
    }

    @Test fun actual_android_transport_rejects_reachable_wrong_hostname() {
        val enrolled = enrollment()
        val port = URI(enrolled.broker).port
        // 同一本AVD的reverse监听器；证书只有127.0.0.1，不涵盖localhost。
        Socket("localhost", port).use { assertTrue(it.isConnected) }
        val status = AtomicReference("")
        val probe = DeviceMqtt(enrolled.identity, "ssl://localhost:$port", enrolled.tls(),
            object : DeviceStorage {
                override fun read(): ByteArray? = null
                override fun commit(bytes: ByteArray) { fail("wrong hostname reached protocol storage") }
            }, object : ApplicationPort {
                override fun permitted(application: String) = false
                override fun submit(application: String) { fail("TLS probe cannot launch apps") }
            }, object : DeviceClock { override fun elapsedMillis() = SystemClock.elapsedRealtime() }) { status.set(it) }
        val thread = Thread { probe.run() }
        thread.start()
        try {
            waitFor("hostname rejection", 10000) { status.get() in setOf("connection_unavailable", "ready") }
            assertEquals("connection_unavailable", status.get())
        } finally { probe.close(); thread.join(10000) }
        assertFalse(thread.isAlive)
    }
}

@RunWith(AndroidJUnit4::class)
class AgentJourneyRuntimeTest {
    @Test fun actual_service_mtls_sqlite_and_leanback_application() {
        val enrolled = enrollment()
        val fixture = instrumentation.context.packageName
        AndroidAgentStore(context).use { store ->
            store.install(enrolled)
            store.authorize(fixture, true)
            assertEquals(enrolled.binding, AndroidAgentStore(context).use { it.load()!!.binding })
            assertTrue(AndroidApplications.discover(context).any { it.packageName == fixture })
        }
        val application = context.applicationContext as TelevisionApplication
        val runtime = application.runtime
        fun foreground(): Activity {
            // 手机系统镜像默认触摸模式；先设置遥控器输入，再等待真实窗口取得焦点。
            instrumentation.setInTouchMode(false)
            val opened = instrumentation.startActivitySync(Intent(context, TelevisionActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            instrumentation.waitForIdleSync()
            waitFor("foreground window focus") {
                val focused = AtomicReference(false)
                instrumentation.runOnMainSync { focused.set(opened.hasWindowFocus()) }
                focused.get()
            }
            return opened
        }
        var activity = foreground()
        try {
            instrumentation.runOnMainSync {
                val decor = activity.window.decorView
                assertTrue("remote focus must be a button; touch=${decor.isInTouchMode}, focus=${decor.findFocus()?.javaClass?.name}",
                    decor.findFocus() is Button)
                val start = Intent(context, AgentService::class.java).setAction(AgentService.ACTION_START)
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(start) else context.startService(start)
            }
            waitFor("actual service ready") { runtime.screen.status == "ready" }
            phase("ready")
            signal("foreground") // 宿主核对首次启动及后台拒绝之后才继续。
            activity = foreground()
            AndroidAgentStore(context).use { it.authorize(fixture, false) }
            phase("revoked")
            signal("stop")
            waitFor("all original results retired") {
                AndroidAgentStore(context).use { store ->
                    val journal = JSONObject(String(store.journal(enrolled.binding).read()!!))
                    journal.getJSONObject("entries").length() == 0 && journal.getLong("high_watermark") >= 3
                }
            }
            runtime.stop()
            context.stopService(Intent(context, AgentService::class.java))
            waitFor("service stopped") { !runtime.running && runtime.screen.status == "stopped" }
            AndroidAgentStore(context).use { store ->
                val journal = JSONObject(String(store.journal(enrolled.binding).read()!!))
                assertEquals(2, journal.getInt("version"))
                assertEquals(0, journal.getJSONObject("entries").length())
                assertTrue(journal.getLong("high_watermark") >= 3)
            }
            phase("stopped")
        } finally {
            runtime.stop()
            context.stopService(Intent(context, AgentService::class.java))
            instrumentation.runOnMainSync { activity.finish() }
        }
    }
}

@RunWith(AndroidJUnit4::class)
class AgentResumeRuntimeTest {
    @Test fun new_process_decrypts_original_store_without_automatic_control() {
        val expected = enrollment()
        val runtime = (context.applicationContext as TelevisionApplication).runtime
        assertFalse(runtime.running)
        assertEquals("stopped", runtime.screen.status)
        AndroidAgentStore(context).use { store ->
            val actual = store.load()!!
            assertEquals(expected.binding, actual.binding)
            assertEquals(expected.certificateFingerprint, actual.certificateFingerprint)
            assertFalse(store.allowed().contains(instrumentation.context.packageName))
            val journal = JSONObject(String(store.journal(actual.binding).read()!!))
            assertEquals(2, journal.getInt("version"))
            assertEquals(0, journal.getJSONObject("entries").length())
            assertTrue(journal.getLong("high_watermark") >= 3)
        }
        phase("restored")
    }
}
