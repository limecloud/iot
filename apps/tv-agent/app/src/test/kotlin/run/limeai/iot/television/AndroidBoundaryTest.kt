package run.limeai.iot.television

import android.app.Application
import android.content.ComponentName
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.database.sqlite.SQLiteDatabase
import kotlinx.serialization.json.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import run.limeai.iot.device.*
import java.nio.file.Files
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import kotlin.test.*

/** 宿主Android沙箱与原生SQLite；不证明端上Keystore、Flash耐久性或电视行为。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class AndroidBoundaryTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private class TestVault : EnrollmentVault {
        private val key = KeyGenerator.getInstance("AES").apply { init(128) }.generateKey()
        override fun seal(bytes: ByteArray, binding: String): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, key); updateAAD(binding.toByteArray()); iv + doFinal(bytes)
        }
        override fun open(bytes: ByteArray, binding: String): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12))); updateAAD(binding.toByteArray()); doFinal(bytes.copyOfRange(12, bytes.size))
        }
    }
    private fun database() = SQLiteDatabase.openDatabase(context.getDatabasePath("tv-agent.db").path, null, SQLiteDatabase.OPEN_READWRITE)
    private fun store(vault: EnrollmentVault = TestVault()) = AndroidAgentStore(context, vault)

    @Test fun renewal_and_reopen_preserve_journal_authorization_and_identity_pin() {
        val vault = TestVault(); val first = Fixtures.enrollment; val renewed = Fixtures.renewed
        val bytes = "original-unresolved-record".toByteArray()
        store(vault).use {
            it.install(first); it.authorize(PLAYER, true); it.journal(first.binding).commit(bytes)
            it.install(renewed)
            assertNotEquals(first.certificateFingerprint, it.load()!!.certificateFingerprint)
            val foreign = DeviceDocument.parse(first.encoded()).toMutableMap().apply { this["space_id"] = JsonPrimitive("different-space") }
            assertEquals("identity_change_refused", assertFailsWith<AgentStoreFault> { it.install(DeviceEnrollment.parse(JsonObject(foreign).toString().toByteArray())) }.code)
        }
        store(vault).use {
            assertEquals(renewed.certificateFingerprint, it.load()!!.certificateFingerprint)
            assertContentEquals(bytes, it.journal(first.binding).read()); assertEquals(setOf(PLAYER), it.allowed())
            assertFailsWith<AgentStoreFault> { it.journal("different-binding").commit("changed".toByteArray()) }
            assertContentEquals(bytes, it.journal(first.binding).read())
        }
    }

    @Test fun unreadable_credentials_never_erase_original_journal_or_authorization() {
        val vault = TestVault(); val enrollment = Fixtures.enrollment
        store(vault).use { it.install(enrollment); it.journal(enrollment.binding).commit("original".toByteArray()); it.authorize(PLAYER, true) }
        database().use { it.execSQL("UPDATE agent SET credentials=zeroblob(length(credentials)) WHERE slot=1") }
        store(vault).use {
            assertFails { it.load() }
            assertContentEquals("original".toByteArray(), it.journal(enrollment.binding).read())
            assertEquals(setOf(PLAYER), it.allowed())
        }
        assertTrue(context.getDatabasePath("tv-agent.db").exists())
    }

    @Test fun unknown_database_version_refuses_without_resetting_records() {
        val enrollment = Fixtures.enrollment
        store().use { it.install(enrollment); it.journal(enrollment.binding).commit("original".toByteArray()) }
        database().use { it.version = 9 }
        store().use { assertEquals("storage_version", assertFailsWith<AgentStoreFault> { it.load() }.code) }
        database().use {
            assertEquals(9, it.version)
            it.rawQuery("SELECT journal FROM agent", null).use { rows -> assertTrue(rows.moveToFirst()); assertContentEquals("original".toByteArray(), rows.getBlob(0)) }
        }
    }

    @Test fun corrupt_database_refuses_without_android_default_file_deletion() {
        store().use { it.install(Fixtures.enrollment); it.journal(Fixtures.enrollment.binding).commit("original".toByteArray()) }
        val path = context.getDatabasePath("tv-agent.db").toPath()
        val corrupt = Files.readAllBytes(path).apply { for (index in 0..15) this[index] = 0x7f }
        Files.write(path, corrupt)
        store().use { assertFails { it.load() } }
        assertContentEquals(corrupt, Files.readAllBytes(path), "corruption must not trigger framework deletion or replacement")
    }

    @Test fun sqlite_failure_before_attempt_is_zero_android_launch_and_preserves_original() {
        installPlayer()
        val enrollment = Fixtures.enrollment; val vault = TestVault()
        store(vault).use { storage ->
            storage.install(enrollment); storage.authorize(PLAYER, true)
            database().use { it.execSQL("CREATE TRIGGER fail_attempt BEFORE UPDATE OF journal ON agent BEGIN SELECT RAISE(ABORT,'injected'); END") }
            val agent = agent(storage, RunPermit(), context)
            assertEquals("storage_unavailable", assertFailsWith<DeviceFault> { command(agent) }.code)
            assertTrue(agent.blocked); assertNull(shadowOf(context).nextStartedActivity)
            assertNull(storage.journal(enrollment.binding).read())
        }
        store(vault).use { assertEquals(enrollment.binding, it.load()!!.binding); assertNull(it.journal(enrollment.binding).read()) }
    }

    @Test fun native_sqlite_and_android_launch_preserve_durable_attempt_without_replay() {
        installPlayer()
        val enrollment = Fixtures.enrollment
        store().use { storage ->
            storage.install(enrollment); storage.authorize(PLAYER, true)
            var effects = 0
            val portContext = object : ContextWrapper(context) {
                override fun startActivity(intent: Intent) {
                    val journal = DeviceDocument.parse(storage.journal(enrollment.binding).read()!!, 1048576, 32768)
                    val entries = journal.getValue("entries") as JsonObject
                    assertEquals(JsonNull, (entries.getValue("c1-1-00000000-0000-4000-8000-000000000001") as JsonObject)["result"])
                    assertEquals(ComponentName(PLAYER, "$PLAYER.Main"), intent.component)
                    effects++; super.startActivity(intent)
                }
            }
            val run = RunPermit(); val agent = agent(storage, run, portContext)
            assertEquals("confirmed", result(command(agent)))
            assertEquals("confirmed", result(command(agent))); assertEquals(1, effects)
            assertNotNull(shadowOf(context).nextStartedActivity); assertNull(shadowOf(context).nextStartedActivity)
            run.stop()
            val reopened = agent(storage, RunPermit(), portContext)
            // 新会话不能消费旧包；重开日志也没有再次进入系统端口。
            assertFailsWith<DeviceFault> { command(reopened, session = "session-one") }
            assertEquals(1, effects)
        }
    }

    @Test fun credential_expiry_between_permission_review_and_submit_prevents_android_launch() {
        installPlayer()
        var current = true
        val port = AndroidApplications(context, { true }, Any(), RunPermit(), { current }) { true }
        assertTrue(port.permitted(PLAYER))
        current = false
        assertFalse(port.permitted(PLAYER)); assertFails { port.submit(PLAYER) }
        assertNull(shadowOf(context).nextStartedActivity)
    }

    @Test fun stop_revoke_and_disabled_component_refuse_old_or_new_runs_without_launch() {
        installPlayer()
        store().use {
            it.install(Fixtures.enrollment); it.authorize(PLAYER, true)
            val lock = Any(); val old = RunPermit(); val port = AndroidApplications(context, { app -> app in it.allowed() }, lock, old) { true }
            assertTrue(port.permitted(PLAYER)); old.stop()
            assertFalse(port.permitted(PLAYER)); assertFails { port.submit(PLAYER) }
            val newPort = AndroidApplications(context, { app -> app in it.allowed() }, lock, RunPermit()) { true }
            assertTrue(newPort.permitted(PLAYER)); it.authorize(PLAYER, false)
            assertFalse(newPort.permitted(PLAYER)); assertFails { newPort.submit(PLAYER) }
            it.authorize(PLAYER, true)
            context.packageManager.setComponentEnabledSetting(ComponentName(PLAYER, "$PLAYER.Main"), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, 0)
            assertFalse(newPort.permitted(PLAYER)); assertFalse(port.permitted(PLAYER))
            assertNull(shadowOf(context).nextStartedActivity)
        }
    }

    @Test @Config(sdk = [29])
    fun android10_background_launch_is_denied_even_when_device_is_authorized() {
        installPlayer()
        store().use {
            it.install(Fixtures.enrollment); it.authorize(PLAYER, true)
            var visible = false
            val port = AndroidApplications(context, { app -> app in it.allowed() }, Any(), RunPermit()) { visible }
            assertFalse(port.permitted(PLAYER)); assertFails { port.submit(PLAYER) }
            visible = true; assertTrue(port.permitted(PLAYER))
            visible = false; assertFails { port.submit(PLAYER) }
            assertNull(shadowOf(context).nextStartedActivity)
        }
    }

    @Test @Config(sdk = [23])
    fun api23_real_application_port_checks_explicit_target_stop_and_current_grants() {
        installPlayer()
        var allowed = true; val run = RunPermit()
        val port = AndroidApplications(context, { allowed && it == PLAYER }, Any(), run) { false }
        assertTrue(port.permitted(PLAYER)); port.submit(PLAYER)
        assertEquals(ComponentName(PLAYER, "$PLAYER.Main"), shadowOf(context).nextStartedActivity.component)
        allowed = false; assertFalse(port.permitted(PLAYER)); assertFails { port.submit(PLAYER) }
        allowed = true; run.stop(); assertFalse(port.permitted(PLAYER)); assertFails { port.submit(PLAYER) }
        assertNull(shadowOf(context).nextStartedActivity)
    }

    @Test fun confirmed_receipt_reclaims_sqlite_record_and_reopen_keeps_replay_boundary() {
        installPlayer(); val vault = TestVault(); val enrollment = Fixtures.enrollment
        store(vault).use { storage ->
            storage.install(enrollment); storage.authorize(PLAYER, true)
            val agent = agent(storage, RunPermit(), context); command(agent)
            assertNotNull(shadowOf(context).nextStartedActivity)
            val journal = DeviceDocument.parse(storage.journal(enrollment.binding).read()!!, 1048576, 32768)
            val entry = (journal.getValue("entries") as JsonObject).values.single() as JsonObject
            val original = entry.getValue("command") as JsonObject
            val ack = buildJsonObject {
                put("command_id", (original.getValue("body") as JsonObject).getValue("command_id"))
                put("command_digest", DeviceDocument.digest(original)); put("result_digest", DeviceDocument.digest(entry.getValue("result")))
            }
            agent.receive(TOPIC + "receipt", envelope("receipt", "receipt-id", "session-$sessions", ack))
        }
        store(vault).use { storage ->
            val journal = DeviceDocument.parse(storage.journal(enrollment.binding).read()!!, 1048576, 32768)
            assertTrue((journal.getValue("entries") as JsonObject).isEmpty())
            assertEquals(1L, (journal.getValue("high_watermark") as JsonPrimitive).long)
            val reopened = agent(storage, RunPermit(), context)
            assertEquals("command_retired", assertFailsWith<DeviceFault> { command(reopened) }.code)
            assertNull(shadowOf(context).nextStartedActivity)
            assertEquals(setOf(PLAYER), storage.allowed())
        }
    }

    @Test fun model_import_atomically_migrates_credentials_and_unknown_journal_without_losing_grants() {
        installPlayer(); val vault = TestVault(); val legacy = Fixtures.enrollment
        val composed = composedEnrollment()
        val target = object : ContextWrapper(context) { override fun startActivity(intent: Intent) { throw IllegalStateException("ambiguous launch") } }
        store(vault).use { storage ->
            storage.install(legacy); storage.authorize(PLAYER, true)
            assertEquals("unknown", result(command(agent(storage, RunPermit(), target))))
            val original = storage.journal(legacy.binding).read()!!
            database().use { it.execSQL("CREATE TRIGGER fail_model BEFORE UPDATE OF journal ON agent BEGIN SELECT RAISE(ABORT,'injected'); END") }
            assertFails { storage.install(composed) }
            assertEquals(DeviceModelProfile.APPLICATIONS, storage.load()!!.identity.profile)
            assertContentEquals(original, storage.journal(legacy.binding).read())
            assertEquals(setOf(PLAYER), storage.allowed())
            database().use { it.execSQL("DROP TRIGGER fail_model") }
            storage.install(composed)
            val migrated = DeviceDocument.parse(storage.journal(legacy.binding).read()!!, 1048576, 32768)
            assertEquals(3L, migrated["version"]!!.jsonPrimitive.long)
            assertEquals(DeviceDocument.parse(original, 1048576, 32768)["entries"], migrated["entries"])
            assertEquals(1L, migrated["high_watermark"]!!.jsonPrimitive.long)
        }
        store(vault).use { storage ->
            assertEquals(DeviceModelProfile.COMPOSED_REMOTE, storage.load()!!.identity.profile)
            val reopened = agent(storage, RunPermit(), context, composed)
            assertNull(reopened.pendingReceipt(), "unknown cannot become a successful or reclaimed record")
            assertEquals("duplicate_conflict", assertFailsWith<DeviceFault> { command(reopened, profile = composed.identity.profile) }.code)
            assertNull(shadowOf(context).nextStartedActivity)
            assertEquals("confirmed", result(command(reopened, sequence = 2, profile = composed.identity.profile)))
            assertNotNull(shadowOf(context).nextStartedActivity); assertNull(shadowOf(context).nextStartedActivity)
            val bytes = storage.journal(legacy.binding).read()!!
            assertEquals("model_rollback_refused", assertFailsWith<AgentStoreFault> { storage.install(legacy) }.code)
            assertContentEquals(bytes, storage.journal(legacy.binding).read()); assertEquals(setOf(PLAYER), storage.allowed())
        }
    }

    @Test fun model_import_refuses_corrupt_legacy_journal_without_replacing_credentials() {
        val vault = TestVault(); val legacy = Fixtures.enrollment
        store(vault).use { storage ->
            storage.install(legacy); storage.authorize(PLAYER, true)
            val corrupt = "original-unreadable-history".toByteArray(); storage.journal(legacy.binding).commit(corrupt)
            assertEquals("storage_corrupt", assertFailsWith<DeviceFault> { storage.install(composedEnrollment()) }.code)
            assertEquals(DeviceModelProfile.APPLICATIONS, storage.load()!!.identity.profile)
            assertContentEquals(corrupt, storage.journal(legacy.binding).read()); assertEquals(setOf(PLAYER), storage.allowed())
        }
    }

    @Test fun audio_model_expansion_is_atomic_and_preserves_original_unknown_and_grants() {
        installPlayer(); val vault = TestVault(); val legacy = Fixtures.enrollment
        fun enrollment(profile: DeviceModelProfile) = DeviceEnrollment.parse(JsonObject(
            DeviceDocument.parse(legacy.encoded()) + mapOf("schema_version" to JsonPrimitive(2), "model_profile" to JsonPrimitive(profile.id)),
        ).toString().toByteArray())
        val audio = enrollment(DeviceModelProfile.AUDIO_APPLICATIONS)
        val composed = enrollment(DeviceModelProfile.AUDIO_COMPOSED_REMOTE)
        val target = object : ContextWrapper(context) { override fun startActivity(intent: Intent) { throw IllegalStateException("ambiguous launch") } }
        store(vault).use { storage ->
            storage.install(legacy); storage.authorize(PLAYER, true)
            assertEquals("unknown", result(command(agent(storage, RunPermit(), target))))
            val original = storage.journal(legacy.binding).read()!!
            database().use { it.execSQL("CREATE TRIGGER fail_audio_model BEFORE UPDATE OF journal ON agent BEGIN SELECT RAISE(ABORT,'injected'); END") }
            assertFails { storage.install(audio) }
            assertEquals(DeviceModelProfile.APPLICATIONS, storage.load()!!.identity.profile)
            assertContentEquals(original, storage.journal(legacy.binding).read())
            database().use { it.execSQL("DROP TRIGGER fail_audio_model") }
            storage.install(audio)
            val migrated = storage.journal(legacy.binding).read()!!
            val doc = DeviceDocument.parse(migrated, 1048576, 32768)
            assertEquals(4L, doc.getValue("version").jsonPrimitive.long)
            assertEquals(DeviceDocument.parse(original, 1048576, 32768)["entries"], doc["entries"])
            assertEquals(DeviceJournalInspection(1, 0, 0, 1, 0, false), DeviceJournalInspection.inspect(audio.identity, migrated))
            storage.install(composed)
            val current = storage.journal(legacy.binding).read()!!
            for (old in listOf(legacy, audio, composedEnrollment())) {
                assertEquals("model_rollback_refused", assertFailsWith<AgentStoreFault> { storage.install(old) }.code)
                assertContentEquals(current, storage.journal(legacy.binding).read())
            }
            assertEquals(setOf(PLAYER), storage.allowed())
            database().use { db -> db.rawQuery("PRAGMA user_version", null).use { assertTrue(it.moveToFirst()); assertEquals(3, it.getInt(0)) } }
        }
        store(vault).use { storage ->
            assertEquals(DeviceModelProfile.AUDIO_COMPOSED_REMOTE, storage.load()!!.identity.profile)
            assertEquals(setOf(PLAYER), storage.allowed())
            assertEquals(1, DeviceJournalInspection.inspect(composed.identity, storage.journal(legacy.binding).read()).unknown)
        }
    }

    private fun composedEnrollment(): DeviceEnrollment = DeviceEnrollment.parse(JsonObject(
        DeviceDocument.parse(Fixtures.enrollment.encoded()) + mapOf("schema_version" to JsonPrimitive(2), "model_profile" to JsonPrimitive("android-tv-remote")),
    ).toString().toByteArray())

    private fun installPlayer() {
        val app = ApplicationInfo().apply { packageName = PLAYER; enabled = true; uid = 12345 }
        val activity = ActivityInfo().apply { packageName = PLAYER; name = "$PLAYER.Main"; enabled = true; exported = true; applicationInfo = app }
        shadowOf(context.packageManager).installPackage(PackageInfo().apply { packageName = PLAYER; applicationInfo = app; activities = arrayOf(activity) })
        shadowOf(context.packageManager).addResolveInfoForIntent(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER).setPackage(PLAYER), ResolveInfo().apply { activityInfo = activity })
    }
    private fun agent(store: AndroidAgentStore, permit: RunPermit, target: android.content.Context, enrollment: DeviceEnrollment = Fixtures.enrollment): DeviceAgent {
        val agent = DeviceAgent(enrollment.identity, store.journal(enrollment.binding), AndroidApplications(target, { it in store.allowed() }, Any(), permit) { true }, object : DeviceClock { override fun elapsedMillis() = 1000L }) { permit.active }
        val hello = DeviceDocument.parse(agent.connected().payload)
        val body = buildJsonObject {
            put("challenge", (hello.getValue("body") as JsonObject).getValue("challenge")); put("time", time(Date().time)); put("max_packet_bytes", 16384); put("receipt_ledger", 1); put("command_sequence", store.journal(Fixtures.enrollment.binding).read()?.let { (DeviceDocument.parse(it, 1048576, 32768)["high_watermark"] as? JsonPrimitive)?.long } ?: 0L)
        }
        agent.receive(TOPIC + "welcome", envelope("welcome", "welcome-id", "session-${++sessions}", body, enrollment.identity.profile))
        return agent
    }
    private var sessions = 0
    private var commandTime: Long? = null
    private fun command(agent: DeviceAgent, session: String = "session-$sessions", sequence: Int = 1, profile: DeviceModelProfile = DeviceModelProfile.APPLICATIONS): List<DevicePublication> {
        val now = commandTime ?: Date().time.also { commandTime = it }
        val body = buildJsonObject {
            put("command_id", "c1-$sequence-00000000-0000-4000-8000-000000000001"); put("issued_at", time(now - 1000)); put("expires_at", time(now + 10000))
            put("operation", buildJsonObject { put("type", "action.invoke"); put("path", "apps.launch"); put("value", buildJsonObject { put("application_id", PLAYER) }) })
        }
        return agent.receive(TOPIC + "command", envelope("command", "c1-$sequence-00000000-0000-4000-8000-000000000001", session, body, profile))
    }
    private fun envelope(kind: String, message: String, session: String, body: JsonObject, profile: DeviceModelProfile = DeviceModelProfile.APPLICATIONS) = buildJsonObject {
        put("v", 1); put("kind", kind); put("message_id", message); put("device_id", "device-tv"); put("model_revision", profile.revision); put("session_id", session); put("body", body)
    }.toString().toByteArray()
    private fun result(messages: List<DevicePublication>) = ((DeviceDocument.parse(messages.single().payload)["body"] as JsonObject)["status"] as JsonPrimitive).content
    private fun time(epoch: Long) = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(epoch))
    companion object { private const val PLAYER = "com.example.player"; private const val TOPIC = "limeiot/v1/space-demo/device-tv/down/" }
}

internal object Fixtures {
    private val directory = Files.createTempDirectory("limeiot-tv-android-fixtures-")
    private fun openssl(vararg args: String) {
        val process = ProcessBuilder(listOf("openssl") + args).directory(directory.toFile()).redirectErrorStream(true).start()
        val output = process.inputStream.readBytes()
        check(process.waitFor() == 0) { "test certificate preparation failed (${output.size} diagnostic bytes)" }
    }
    init {
        openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2", "-subj", "/CN=Test CA", "-keyout", "ca.key", "-out", "ca.crt", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign")
        Files.write(directory.resolve("client.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n".toByteArray())
    }
    private fun create(name: String): DeviceEnrollment {
        openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=device-tv", "-keyout", "$name.key", "-out", "$name.csr")
        openssl("x509", "-req", "-in", "$name.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1", "-extfile", "client.ext", "-out", "$name.crt")
        fun read(file: String) = String(Files.readAllBytes(directory.resolve(file)), Charsets.US_ASCII)
        return DeviceEnrollment.parse(buildJsonObject {
            put("schema_version", 1); put("space_id", "space-demo"); put("device_id", "device-tv"); put("broker", "ssl://127.0.0.1:8883")
            put("ca_pem", read("ca.crt")); put("certificate_pem", read("$name.crt")); put("private_key_pem", read("$name.key"))
        }.toString().toByteArray())
    }
    val enrollment: DeviceEnrollment by lazy { create("first") }
    val renewed: DeviceEnrollment by lazy { create("renewed") }
}
