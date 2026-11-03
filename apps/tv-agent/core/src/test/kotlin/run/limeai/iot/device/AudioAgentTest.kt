package run.limeai.iot.device

import kotlinx.serialization.json.*
import kotlin.test.*

/** 设备消费者与耐久日志；所有音频效果均为显式端口夹具。 */
class AudioAgentTest {
    private class Storage : DeviceStorage {
        var bytes: ByteArray? = null
        var commits = 0
        var failAt = 0
        var failAfter = false
        var afterCommit: () -> Unit = {}
        override fun read() = bytes?.copyOf()
        override fun commit(bytes: ByteArray) {
            commits++
            if (commits == failAt && !failAfter) throw IllegalStateException("before commit")
            this.bytes = bytes.copyOf(); afterCommit()
            if (commits == failAt) throw IllegalStateException("after durable commit")
        }
        fun document() = DeviceDocument.parse(bytes!!, 1048576, 32768)
        fun entries() = document().getValue("entries").jsonObject
    }
    private class Clock : DeviceClock { var elapsed = 1000L; override fun elapsedMillis() = elapsed }
    private class Audio(private val storage: Storage) : AudioPort {
        var allowed = true
        var failRead = false
        var failWrite = false
        var reads = 0
        var onRead: () -> Unit = {}
        var state = AudioState(0, 15, 4, false)
        val calls = mutableListOf<JsonObject>()
        override fun permitted() = allowed
        override fun read(): AudioState { reads++; onRead(); check(!failRead); check(allowed); return state }
        private fun effect(input: JsonObject) {
            assertEquals(JsonNull, storage.entries().values.last().jsonObject["result"], "intent must be durable before audio effect")
            calls += input
            check(!failWrite) { "ambiguous native call" }
        }
        override fun setVolume(percent: Int) = effect(obj("percent" to JsonPrimitive(percent)))
        override fun setMuted(muted: Boolean) = effect(obj("muted" to JsonPrimitive(muted)))
    }
    private class Fixture(val profile: DeviceModelProfile = DeviceModelProfile.AUDIO_APPLICATIONS, val storage: Storage = Storage(), useAudio: Boolean = true) {
        val identity = DeviceIdentity("home", "tv", profile)
        val clock = Clock()
        val audio = Audio(storage)
        var online = true
        var appEffects = 0
        var appFail = false
        val applications = object : ApplicationPort {
            override fun permitted(application: String) = application == "com.example.player"
            override fun submit(application: String) { appEffects++; check(!appFail) { "ambiguous application call" } }
        }
        val agent = DeviceAgent(identity, storage, applications, clock, if (useAudio) audio else null) { online }
        val base = "limeiot/v1/home/tv"
        fun envelope(kind: String, body: JsonObject, id: String = "message") = obj(
            "v" to JsonPrimitive(1), "kind" to text(kind), "message_id" to text(id), "device_id" to text("tv"),
            "model_revision" to text(profile.revision), "session_id" to text("session"), "body" to body)
        fun receive(kind: String, value: JsonObject) = agent.receive("$base/down/$kind", value.toString().toByteArray()).map { DeviceDocument.parse(it.payload) }
        fun open(): Pair<JsonObject, JsonObject> {
            val hello = DeviceDocument.parse(agent.connected().payload)
            assertFalse(agent.ready)
            val state = receive("welcome", envelope("welcome", obj("challenge" to hello.getValue("body").jsonObject.getValue("challenge"),
                "time" to text("2026-11-03T00:00:00Z"), "max_packet_bytes" to JsonPrimitive(16384), "receipt_ledger" to JsonPrimitive(1),
                "command_sequence" to JsonPrimitive(storage.bytes?.let { storage.document().integer("high_watermark") } ?: 0L)))).single()
            assertTrue(agent.ready)
            return hello to state
        }
        fun command(path: String = "audio.set_volume", input: JsonObject = obj("percent" to JsonPrimitive(5)), sequence: Int = 1): JsonObject {
            val id = "c1-$sequence-00000000-0000-4000-8000-000000000001"
            return envelope("command", obj("command_id" to text(id), "issued_at" to text("2026-11-03T00:00:00Z"),
                "expires_at" to text("2026-11-03T00:00:20Z"), "operation" to obj("type" to text("action.invoke"), "path" to text(path), "value" to input)), id)
        }
        fun execute(command: JsonObject = command()) = receive("command", command).single().getValue("body").jsonObject
        fun properties(message: JsonObject) = message.getValue("body").jsonObject.getValue("properties").jsonArray.associate {
            val entry = it.jsonObject
            assertEquals("confirmed", entry.text("quality")); assertEquals("tv-agent.audio", entry.text("source"))
            DeviceTime.parse(entry.text("observed_at")); entry.text("path") to entry.getValue("value")
        }
    }
    private fun fault(code: String, action: () -> Any?) = assertEquals(code, assertFailsWith<DeviceFault> { action() }.code)

    @Test fun exact_profiles_separate_readonly_observations_and_submitted_actions() {
        for (profile in listOf(DeviceModelProfile.AUDIO_APPLICATIONS, DeviceModelProfile.AUDIO_COMPOSED_REMOTE)) {
            assertSame(profile, DeviceModelProfile.parse(profile.id))
            val expectedRevision = if (profile == DeviceModelProfile.AUDIO_APPLICATIONS)
                "sha256:ea5dee8c71de2ed4e64b306d50c0ff640c7f7bc0de268501a029876bf116cca6"
                else "sha256:6c224009f763bcfb5007cbd3626d235d7876bad98ebf0383d7bb9302abb12327"
            assertEquals(expectedRevision, profile.revision, "must match the shared Rust validator canonical projection")
            val audio = profile.definition.getValue("services").jsonArray.single { it.jsonObject.text("id") == "audio" }.jsonObject
            assertEquals(setOf("volume", "muted"), audio.getValue("properties").jsonArray.map { it.jsonObject.text("id") }.toSet())
            for (property in audio.getValue("properties").jsonArray) assertEquals(setOf("read", "notify"), property.jsonObject.getValue("access").jsonArray.map { it.jsonPrimitive.content }.toSet())
            for (action in audio.getValue("actions").jsonArray) assertEquals("submitted", action.jsonObject.text("completion"))
            val f = Fixture(profile); val (hello, state) = f.open()
            assertEquals(profile.nativePaths, hello.getValue("body").jsonObject.getValue("execution_paths").jsonArray.map { it.jsonPrimitive.content })
            assertEquals(mapOf("audio.volume" to JsonPrimitive(27), "audio.muted" to JsonPrimitive(false)), f.properties(state))
            assertTrue(f.audio.calls.isEmpty()); assertEquals(0, f.appEffects)
        }
    }

    @Test fun missing_authority_or_read_failure_never_advertises_audio_or_sends_an_empty_snapshot() {
        val missing = Fixture(useAudio = false); fault("audio_not_authorized") { missing.agent.connected() }; assertNull(missing.storage.bytes)
        val denied = Fixture(); denied.audio.allowed = false
        fault("audio_not_authorized") { denied.agent.connected() }; assertNull(denied.storage.bytes)
        val f = Fixture(); f.open(); f.audio.failRead = true
        assertFailsWith<IllegalStateException> { f.agent.heartbeat() }; assertFalse(f.agent.ready); assertNull(f.agent.heartbeat())
        val stopped = Fixture(); stopped.open(); stopped.audio.onRead = { stopped.online = false }
        fault("session_mismatch") { stopped.agent.heartbeat() }; assertFalse(stopped.agent.ready)
        assertTrue(f.audio.calls.isEmpty()); assertTrue(stopped.audio.calls.isEmpty())
    }

    @Test fun submitted_volume_and_explicit_mute_do_not_fabricate_actual_readings() {
        val f = Fixture(); f.open()
        val command = f.command(); val result = f.execute(command)
        assertEquals("confirmed", result.text("status"))
        val evidence = result.getValue("evidence").jsonObject
        assertEquals("audio.set_volume", evidence.text("path")); assertEquals("submitted", evidence.text("completion"))
        assertEquals(DeviceDocument.digest(obj("percent" to JsonPrimitive(5))), evidence.text("input_digest"))
        assertEquals(JsonObject(emptyMap()), evidence["output"])
        assertEquals(JsonPrimitive(27), f.properties(DeviceDocument.parse(f.agent.heartbeat()!!.payload))["audio.volume"])
        f.audio.state = AudioState(0, 15, 1, true)
        assertEquals(mapOf("audio.volume" to JsonPrimitive(7), "audio.muted" to JsonPrimitive(true)), f.properties(DeviceDocument.parse(f.agent.heartbeat()!!.payload)))
        f.execute(f.command("audio.set_muted", obj("muted" to JsonPrimitive(true)), 2))
        f.execute(f.command("audio.set_muted", obj("muted" to JsonPrimitive(false)), 3))
        assertEquals(listOf(obj("percent" to JsonPrimitive(5)), obj("muted" to JsonPrimitive(true)), obj("muted" to JsonPrimitive(false))), f.audio.calls)
        assertEquals(result, f.execute(command)); assertEquals(3, f.audio.calls.size)
    }

    @Test fun strict_inputs_and_old_models_refuse_audio_without_creating_an_intent() {
        val f = Fixture(); f.open(); val commits = f.storage.commits
        for ((path, input) in listOf(
            "audio.set_volume" to obj("percent" to JsonPrimitive(-1)), "audio.set_volume" to obj("percent" to JsonPrimitive(101)),
            "audio.set_volume" to obj("percent" to text("5")), "audio.set_volume" to obj("percent" to JsonPrimitive(true)),
            "audio.set_muted" to obj("muted" to text("true")), "audio.set_muted" to obj("muted" to JsonPrimitive(1)),
            "audio.set_muted" to obj("muted" to JsonNull), "audio.set_muted" to obj("muted" to JsonPrimitive(true), "extra" to JsonPrimitive(1)),
            "remote.press" to obj("key" to text("home")))) assertFailsWith<DeviceFault> { f.execute(f.command(path, input)) }
        assertEquals(commits, f.storage.commits); assertTrue(f.audio.calls.isEmpty())
        for (profile in listOf(DeviceModelProfile.APPLICATIONS, DeviceModelProfile.COMPOSED_REMOTE)) {
            val old = Fixture(profile); old.open(); fault("unsupported_capability") { old.execute() }
            assertEquals(0, old.audio.reads); assertTrue(old.audio.calls.isEmpty())
        }
    }

    @Test fun revocation_and_expiry_after_durable_intent_prevent_any_audio_effect() {
        for (expire in listOf(false, true)) {
            val f = Fixture(); f.open()
            f.storage.afterCommit = { if (expire) f.clock.elapsed += 30000 else f.audio.allowed = false }
            val result = f.execute()
            assertEquals("failed", result.text("status")); assertEquals(if (expire) "command_expired" else "authorization_changed", result.text("error"))
            assertTrue(f.audio.calls.isEmpty())
            assertEquals(1, DeviceJournalInspection.inspect(f.identity, f.storage.bytes).failed)
        }
        val denied = Fixture(); denied.open(); denied.audio.allowed = false
        assertEquals("audio_not_authorized", denied.execute().text("error")); assertTrue(denied.audio.calls.isEmpty())
    }

    @Test fun ambiguous_audio_call_and_original_unknown_survive_reopen_without_reexecution() {
        val f = Fixture(); f.open(); f.audio.failWrite = true
        val command = f.command(); val result = f.execute(command)
        assertEquals("unknown", result.text("status")); assertEquals(result, f.execute(command)); assertEquals(1, f.audio.calls.size)
        val original = f.storage.bytes!!.copyOf(); val reopened = Fixture(storage = f.storage); reopened.open()
        assertEquals(result, reopened.execute(command)); assertTrue(reopened.audio.calls.isEmpty()); assertNull(reopened.agent.pendingReceipt())
        assertContentEquals(original, f.storage.bytes); assertEquals(1, DeviceJournalInspection.inspect(f.identity, original).unknown)
    }

    @Test fun storage_failure_before_or_after_commit_freezes_consumer_and_preserves_actual_outcome() {
        for (after in listOf(false, true)) for (resultWrite in listOf(false, true)) {
            val f = Fixture(); f.open(); f.storage.failAt = f.storage.commits + if (resultWrite) 2 else 1; f.storage.failAfter = after
            fault("storage_unavailable") { f.execute() }; assertTrue(f.agent.blocked); assertFalse(f.agent.ready)
            assertEquals(if (resultWrite) 1 else 0, f.audio.calls.size)
            f.storage.failAt = 0
            val reopened = Fixture(storage = f.storage); reopened.open()
            val inspection = DeviceJournalInspection.inspect(f.identity, f.storage.bytes)
            assertEquals(if (resultWrite && after) 1 else 0, inspection.confirmed)
            if (resultWrite || after) {
                assertEquals(if (resultWrite && after) "confirmed" else "unknown", reopened.execute().text("status"))
                assertTrue(reopened.audio.calls.isEmpty())
            } else assertEquals(0, inspection.entries)
        }
    }

    @Test fun monotonic_model_migration_preserves_original_commands_results_and_high_watermark() {
        val allowed = mapOf(
            DeviceModelProfile.APPLICATIONS to DeviceModelProfile.values().toSet(),
            DeviceModelProfile.COMPOSED_REMOTE to setOf(DeviceModelProfile.COMPOSED_REMOTE, DeviceModelProfile.AUDIO_COMPOSED_REMOTE),
            DeviceModelProfile.AUDIO_APPLICATIONS to setOf(DeviceModelProfile.AUDIO_APPLICATIONS, DeviceModelProfile.AUDIO_COMPOSED_REMOTE),
            DeviceModelProfile.AUDIO_COMPOSED_REMOTE to setOf(DeviceModelProfile.AUDIO_COMPOSED_REMOTE),
        )
        for (source in DeviceModelProfile.values()) for (target in DeviceModelProfile.values()) {
            val f = Fixture(source); f.open(); f.execute(f.command("apps.launch", obj("application_id" to text("com.example.player"))))
            f.execute(f.command("apps.launch", obj("application_id" to text("com.example.denied")), 2))
            f.appFail = true; f.execute(f.command("apps.launch", obj("application_id" to text("com.example.player")), 3))
            val unresolved = f.command("apps.launch", obj("application_id" to text("com.example.player")), 4)
            val entries = f.storage.entries() + (unresolved.getValue("body").jsonObject.text("command_id") to obj("command" to unresolved, "result" to JsonNull))
            f.storage.bytes = DeviceDocument.canonical(DeviceJournal.encode(f.identity, entries.mapValues { it.value.jsonObject }, 4)).toByteArray()
            val original = f.storage.bytes!!.copyOf(); val identity = DeviceIdentity("home", "tv", target)
            val expectedAllowed = target in allowed.getValue(source)
            assertEquals(expectedAllowed, target.acceptsHistory(source))
            if (!expectedAllowed) {
                fault("storage_corrupt") { DeviceJournalMigration.prepare(identity, original) }
            } else {
                val migrated = DeviceJournalMigration.prepare(identity, original)
                assertEquals(f.storage.entries(), DeviceDocument.parse(migrated, 1048576, 32768).getValue("entries"))
                assertEquals(DeviceJournalInspection(4, 1, 1, 1, 1, false), DeviceJournalInspection.inspect(identity, migrated))
                val current = Fixture(target, Storage().also { it.bytes = migrated }); current.open()
                assertNotNull(current.agent.pendingReceipt()); assertTrue(current.audio.calls.isEmpty()); assertEquals(0, current.appEffects)
            }
            assertContentEquals(original, f.storage.bytes)
        }
    }

    @Test fun corrupted_audio_result_or_legacy_envelope_cannot_be_accepted_as_history() {
        val f = Fixture(); f.open(); f.execute(); val doc = f.storage.document(); val id = f.storage.entries().keys.single()
        val entry = f.storage.entries().getValue(id).jsonObject; val result = entry.getValue("result").jsonObject
        val evidence = result.getValue("evidence").jsonObject; val command = entry.getValue("command").jsonObject
        val badEntries = listOf(
            JsonObject(entry + ("result" to JsonObject(result + ("evidence" to JsonObject(evidence + ("path" to text("apps.launch"))))))),
            JsonObject(entry + ("command" to JsonObject(command + ("model_revision" to text(DeviceModelProfile.APPLICATIONS.revision)))))
        )
        for (bad in badEntries) fault("storage_corrupt") {
            DeviceJournalInspection.inspect(f.identity, JsonObject(doc + ("entries" to obj(id to bad))).toString().toByteArray())
        }
        for (version in listOf(1, 2, 3, 5)) fault("storage_corrupt") {
            DeviceJournalInspection.inspect(f.identity, JsonObject(doc + ("version" to JsonPrimitive(version))).toString().toByteArray())
        }
    }

    @Test fun audio_receipt_reclaims_only_exact_final_result_and_sequence_remains_retired() {
        val f = Fixture(); f.open(); val command = f.command(); val result = f.execute(command)
        val body = obj("command_id" to command.getValue("body").jsonObject.getValue("command_id"),
            "command_digest" to text(DeviceDocument.digest(command)), "result_digest" to text(DeviceDocument.digest(result)))
        assertNotNull(f.agent.pendingReceipt())
        val bad = JsonObject(body + ("result_digest" to text("sha256:" + "0".repeat(64))))
        fault("invalid_receipt") { f.receive("receipt", f.envelope("receipt", bad)) }
        f.receive("receipt", f.envelope("receipt", body)); assertNull(f.agent.pendingReceipt())
        assertTrue(f.storage.entries().isEmpty()); assertEquals(1L, f.storage.document().integer("high_watermark"))
        fault("command_retired") { f.execute(command) }; assertEquals(1, f.audio.calls.size)
    }
}
