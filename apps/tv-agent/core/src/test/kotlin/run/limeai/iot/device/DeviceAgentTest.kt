package run.limeai.iot.device

import kotlinx.serialization.json.*
import kotlin.test.*

class DeviceAgentTest {
    companion object { private fun ledgerId(sequence: Int) = "c1-$sequence-00000000-0000-4000-8000-000000000001" }
    private class Storage : DeviceStorage {
        var bytes: ByteArray? = null
        var calls = 0
        var failAt = 0
        var failAfter = false
        var afterCommit: () -> Unit = {}
        override fun read() = bytes?.copyOf()
        override fun commit(bytes: ByteArray) {
            calls++
            if (calls == failAt && !failAfter) throw Exception("fixture")
            this.bytes = bytes.copyOf(); afterCommit()
            if (calls == failAt) throw Exception("fixture")
        }
        fun document() = DeviceDocument.parse(bytes!!, 1048576, 32768)
    }
    private class Clock : DeviceClock { var elapsed = 10000L; override fun elapsedMillis() = elapsed }
    private class Applications(val storage: Storage) : ApplicationPort {
        var allowed = true
        var fail = false
        var effects = 0
        override fun permitted(application: String) = allowed && application == "com.example.player"
        override fun submit(application: String) {
            val journal = storage.document(); val entries = journal.getValue("entries").obj()
            val attempted = entries.getValue(ledgerId(journal.integer("high_watermark").toInt())).obj()
            assertEquals(JsonNull, attempted["result"], "current attempt must be durable even when older unresolved attempts remain")
            assertEquals(application, attempted.getValue("command").obj().getValue("body").obj().getValue("operation").obj().getValue("value").obj().text("application_id"), "attempt must be durable before effect")
            effects++
            if (fail) throw Exception("ambiguous platform result")
        }
    }
    private class Fixture(val storage: Storage = Storage(), val clock: Clock = Clock(), val profile: DeviceModelProfile = DeviceModelProfile.APPLICATIONS) {
        val identity = DeviceIdentity("space-demo", "device-lamp", profile)
        val applications = Applications(storage)
        var connected = true
        val agent = DeviceAgent(identity, storage, applications, clock) { connected }
        val base = "limeiot/v1/space-demo/device-lamp"
        var session = "session-1"
        fun envelope(kind: String, body: JsonObject, messageId: String = "message-1") = obj(
            "v" to JsonPrimitive(1), "kind" to text(kind), "message_id" to text(messageId), "device_id" to text(identity.device),
            "model_revision" to text(profile.revision), "session_id" to text(session), "body" to body,
        )
        fun welcome(challenge: String, head: Long = storage.bytes?.let { DeviceDocument.parse(it, 1048576, 32768)["high_watermark"]?.jsonPrimitive?.long } ?: 0L) = envelope("welcome", obj("receipt_ledger" to JsonPrimitive(1), "command_sequence" to JsonPrimitive(head), "challenge" to text(challenge), "time" to text("2026-11-02T00:00:00Z"), "max_packet_bytes" to JsonPrimitive(16384)))
        fun open(): JsonObject {
            val hello = DeviceDocument.parse(agent.connected().payload)
            val challenge = hello.getValue("body").obj().text("challenge")
            val result = receive(welcome(challenge), "welcome").single()
            assertTrue(agent.ready); assertEquals(JsonArray(emptyList()), result.getValue("body").obj()["properties"])
            return hello
        }
        fun command(id: String = ledgerId(1), issued: String = "2026-11-02T00:00:00Z", expires: String = "2026-11-02T00:00:20Z") = envelope("command", obj(
            "command_id" to text(id), "issued_at" to text(issued), "expires_at" to text(expires),
            "operation" to obj("type" to text("action.invoke"), "path" to text("apps.launch"), "value" to obj("application_id" to text("com.example.player"))),
        ), id)
        fun receive(message: JsonObject, kind: String = "command", retained: Boolean = false) = agent.receive("$base/down/$kind", message.toString().toByteArray(), retained).map { DeviceDocument.parse(it.payload) }
        fun execute(message: JsonObject = command()) = receive(message).single().getValue("body").obj()
    }
    private fun fault(code: String, block: () -> Unit) { assertEquals(code, assertFailsWith<DeviceFault>(block = block).code) }

    @Test fun strict_documents_reject_duplicates_invalid_unicode_and_unbounded_inputs() {
        for (raw in listOf("{\"v\":1,\"v\":1}", "{\"v\":1,\"\\u0076\":1}", "{\"a\":{\"b\":1,\"b\":2}}", "{}{}", "{}\u0000", "{\"v\":1.0}", "{\"v\":1e0}", "{\"v\":9007199254740992}", "{\"v\":\"\\ud800\"}", "{\"v\":\"\\udfff\"}")) {
            fault("invalid_message") { DeviceDocument.parse(raw.toByteArray()) }
        }
        fault("invalid_message") { DeviceDocument.parse((" ".repeat(16384) + "{}").toByteArray()) }
        fault("invalid_message") { DeviceDocument.parse(("{\"x\":".repeat(20) + "{}" + "}".repeat(20)).toByteArray()) }
        fault("invalid_message") { DeviceDocument.parse("{\"a\":[1,2]}".toByteArray(), maxNodes = 2) }
        fault("invalid_message") { DeviceDocument.parse("{\"a\":\"".toByteArray() + byteArrayOf(255.toByte()) + "\"}".toByteArray()) }
        assertEquals("{\"a\":\"😀\",\"b\":1}", DeviceDocument.canonical(DeviceDocument.parse("{\"b\":1,\"a\":\"\\ud83d\\ude00\"}".toByteArray())))
    }

    @Test fun model_and_jcs_use_only_real_application_capability() {
        val model = TelevisionAgentModel.definition
        assertEquals("urn:limeiot:model:android-tv-agent:1", model.text("model_id"))
        assertEquals(1, model.getValue("services").jsonArray.size)
        assertEquals("sha256:a591ed3813a996a6c8bb37e9ecdef2c335efd044c629b2a4b4f896fd93aa562a", DeviceModelProfile.COMPOSED_REMOTE.revision, "must match the shared Rust model validator canonical projection")
        assertEquals("sha256:77abdb28f9e099bb4458e7ea695b998de74270d0bfc60f4691c812bb70be406f", DeviceDocument.digest(obj("key" to text("home"))))
        assertEquals(DeviceDocument.digest(obj("b" to text("二"), "a" to text("一"))), DeviceDocument.digest(obj("a" to text("一"), "b" to text("二"))))
    }

    @Test fun welcome_requires_current_challenge_identity_topic_and_nonretained_message() {
        val f = Fixture()
        val hello = DeviceDocument.parse(f.agent.connected().payload)
        val welcome = f.welcome(hello.getValue("body").obj().text("challenge"))
        fault("session_mismatch") { f.receive(welcome, "welcome", true) }
        fault("invalid_welcome") { f.receive(f.welcome("wrong"), "welcome") }
        fault("model_mismatch") { f.receive(JsonObject(welcome + ("device_id" to text("other"))), "welcome") }
        fault("invalid_topic") { f.agent.receive("limeiot/v1/other/device-lamp/down/welcome", welcome.toString().toByteArray()) }
        f.receive(welcome, "welcome")
        fault("session_mismatch") { f.receive(welcome, "welcome") }
        assertTrue(f.agent.ready); assertEquals(0, f.applications.effects)
    }

    @Test fun submitted_result_is_durable_before_publish_and_duplicate_does_not_execute() {
        val f = Fixture(); f.open()
        val command = f.command(); val result = f.execute(command)
        assertEquals("confirmed", result.text("status")); assertEquals(2, f.storage.calls); assertEquals(1, f.applications.effects)
        val evidence = result.getValue("evidence").obj()
        assertEquals("submitted", evidence.text("completion")); assertEquals(JsonObject(emptyMap()), evidence["output"])
        assertEquals(DeviceDocument.digest(obj("application_id" to text("com.example.player"))), evidence.text("input_digest"))
        f.clock.elapsed += 30000
        assertEquals(result, f.execute(command)); assertEquals(1, f.applications.effects); assertEquals(2, f.storage.calls)
        fault("duplicate_conflict") { f.execute(JsonObject(command + ("message_id" to text("different")))) }
    }

    @Test fun unsupported_actions_sessions_fields_and_package_syntax_have_zero_effects() {
        val f = Fixture(); f.open(); val command = f.command(); val body = command.getValue("body").obj(); val op = body.getValue("operation").obj()
        fault("session_mismatch") { f.execute(JsonObject(command + ("session_id" to text("old")))) }
        for (invalid in listOf(JsonObject(op + ("path" to text("remote.press"))), JsonObject(op + ("type" to text("property.set"))))) {
            fault("unsupported_capability") { f.execute(JsonObject(command + ("body" to JsonObject(body + ("operation" to invalid))))) }
        }
        for (value in listOf(obj("application_id" to text("com.example.player;reboot")), obj("application_id" to text("x")), obj("application_id" to text("com.example.player"), "shell" to text("x")))) {
            assertFailsWith<DeviceFault> { f.execute(JsonObject(command + ("body" to JsonObject(body + ("operation" to JsonObject(op + ("value" to value))))))) }
        }
        fault("invalid_message") { f.execute(JsonObject(command + ("extra" to JsonPrimitive(true)))) }
        assertEquals(0, f.storage.calls); assertEquals(0, f.applications.effects)
    }

    @Test fun expiry_clock_and_current_grant_are_rechecked_before_effect() {
        val expired = Fixture(); expired.open(); expired.clock.elapsed += 20000
        assertEquals("command_expired", expired.execute().text("error")); assertEquals(0, expired.applications.effects)
        val future = Fixture(); future.open()
        assertEquals("command_expired", future.execute(future.command(issued = "2026-11-02T00:00:03Z")).text("error"))
        val invalidWindow = Fixture(); invalidWindow.open()
        assertEquals("command_expired", invalidWindow.execute(invalidWindow.command(expires = "2026-11-02T00:00:31Z")).text("error"))
        val revoked = Fixture(); revoked.open(); revoked.storage.afterCommit = { revoked.applications.allowed = false }
        assertEquals("authorization_changed", revoked.execute().text("error")); assertEquals(0, revoked.applications.effects)
        val delayed = Fixture(); delayed.open(); delayed.storage.afterCommit = { delayed.clock.elapsed += 21000 }
        assertEquals("command_expired", delayed.execute().text("error")); assertEquals(0, delayed.applications.effects)
        val rollback = Fixture(); rollback.open(); rollback.clock.elapsed--
        fault("invalid_time") { rollback.execute() }; assertFalse(rollback.agent.ready); assertEquals(0, rollback.applications.effects)
    }

    @Test fun discovery_without_local_grant_is_a_durable_refusal() {
        val f = Fixture(); f.open(); f.applications.allowed = false
        val result = f.execute(); assertEquals("application_not_authorized", result.text("error"))
        f.applications.allowed = true
        assertEquals(result, f.execute()); assertEquals(0, f.applications.effects); assertEquals(1, f.storage.calls)
    }

    @Test fun connection_loss_at_commit_prevents_effect_and_message_id_cannot_name_two_commands() {
        val f = Fixture(); f.open(); f.storage.afterCommit = { f.connected = false }
        assertEquals("authorization_changed", f.execute().text("error")); assertEquals(0, f.applications.effects)
        val reused = Fixture(); reused.open(); val command = reused.command(); reused.execute(command)
        val second = JsonObject(reused.command(ledgerId(2)) + ("message_id" to command.getValue("message_id")))
        fault("duplicate_conflict") { reused.execute(second) }; assertEquals(1, reused.applications.effects)
    }

    @Test fun storage_failure_before_attempt_blocks_object_and_never_calls_platform() {
        for (after in listOf(false, true)) {
            val f = Fixture(); f.open(); f.storage.failAt = 1; f.storage.failAfter = after
            fault("storage_unavailable") { f.execute() }
            assertTrue(f.agent.blocked); assertFalse(f.agent.ready); assertEquals(0, f.applications.effects)
            fault("storage_unavailable") { f.agent.connected() }
            fault("storage_unavailable") { f.execute(f.command(ledgerId(2))) }
            val reopened = Fixture(f.storage); reopened.session = "session-2"; reopened.open()
            if (after) fault("duplicate_conflict") { reopened.execute() }
            assertEquals(0, reopened.applications.effects)
        }
    }

    @Test fun ambiguous_effect_and_failed_final_commit_are_never_replayed_after_reopen() {
        for (after in listOf(false, true)) {
            val f = Fixture(); f.open(); f.storage.failAt = 2; f.storage.failAfter = after
            fault("storage_unavailable") { f.execute() }; assertEquals(1, f.applications.effects)
            val reopened = Fixture(f.storage); reopened.session = "session-2"; reopened.open()
            fault("duplicate_conflict") { reopened.execute() }
            assertEquals(0, reopened.applications.effects)
        }
        val unknown = Fixture(); unknown.open(); unknown.applications.fail = true
        val result = unknown.execute(); assertEquals("unknown", result.text("status")); assertEquals("execution_unknown", result.text("error"))
        assertEquals(result, unknown.execute()); assertEquals(1, unknown.applications.effects)
    }

    @Test fun reconnect_changes_session_and_restart_changes_boot_without_replaying() {
        val f = Fixture(); val first = f.open(); f.execute()
        f.agent.disconnected(); assertNull(f.agent.heartbeat())
        f.session = "session-2"; val second = f.open()
        assertEquals(first.text("boot_id"), second.text("boot_id")); assertTrue(second.integer("seq") > first.integer("seq"))
        fault("duplicate_conflict") { f.execute() }; assertEquals(1, f.applications.effects)
        val reopened = Fixture(f.storage); val nextBoot = reopened.open()
        assertNotEquals(first.text("boot_id"), nextBoot.text("boot_id")); assertEquals(0, reopened.applications.effects)
    }

    @Test fun corrupt_journal_scope_envelope_and_results_fail_closed_without_rewrite() {
        val f = Fixture(); f.open(); f.execute(); val original = f.storage.bytes!!.copyOf()
        val doc = f.storage.document(); val entries = doc.getValue("entries").obj(); val entry = entries.getValue(ledgerId(1)).obj()
        val command = entry.getValue("command").obj(); val result = entry.getValue("result").obj()
        val badEntry = JsonObject(entry + ("result" to JsonObject(result + ("status" to text("invented")))))
        val badCommand = JsonObject(command + ("model_revision" to text("bad")))
        val badCommandEntry = JsonObject(entry + ("command" to badCommand))
        val values = listOf(
            JsonObject(doc + ("device_id" to text("other"))),
            JsonObject(doc + ("version" to JsonPrimitive(4))),
            JsonObject(doc + ("high_watermark" to JsonPrimitive(0))),
            JsonObject(doc + ("entries" to obj(ledgerId(1) to badEntry))),
            JsonObject(doc + ("entries" to obj("other" to entry))),
            JsonObject(doc + ("entries" to obj(ledgerId(1) to badCommandEntry))),
        )
        for (invalid in values) {
            f.storage.bytes = invalid.toString().toByteArray(); val before = f.storage.bytes!!.copyOf(); val calls = f.storage.calls
            fault("storage_corrupt") { Fixture(f.storage) }; assertContentEquals(before, f.storage.bytes); assertEquals(calls, f.storage.calls)
        }
        f.storage.bytes = original; Fixture(f.storage)
    }

    @Test fun bounded_journal_never_evicts_unknown_or_old_operations() {
        for (unknown in listOf(false, true)) {
            val f = Fixture(); f.open(); f.applications.fail = unknown
            repeat(128) { f.execute(f.command(ledgerId(it + 1))) }
            fault("capacity_exceeded") { f.execute(f.command(ledgerId(129))) }
            assertEquals(128, f.applications.effects); assertEquals(128, f.storage.document().getValue("entries").obj().size)
        }
    }

    private fun ack(f: Fixture, command: JsonObject = f.command(), result: JsonObject = f.storage.document().getValue("entries").obj().getValue(command.getValue("body").obj().text("command_id")).obj().getValue("result").obj()) = f.envelope("receipt", obj(
        "command_id" to command.getValue("body").obj().getValue("command_id"),
        "command_digest" to text(DeviceDocument.digest(command)), "result_digest" to text(DeviceDocument.digest(result)),
    ), "receipt-ack")

    @Test fun acknowledged_results_release_capacity_but_old_ids_and_messages_stay_retired() {
        val f = Fixture(); f.open(); val first = f.command()
        repeat(260) { i ->
            val command = f.command(ledgerId(i + 1)); f.execute(command)
            assertNotNull(f.agent.pendingReceipt())
            f.receive(ack(f, command), "receipt")
            assertNull(f.agent.pendingReceipt())
        }
        assertEquals(260, f.applications.effects)
        assertTrue(f.storage.document().getValue("entries").obj().isEmpty())
        assertEquals(260L, f.storage.document().integer("high_watermark"))
        fault("command_retired") { f.execute(first) }
        val body = first.getValue("body").obj(); val operation = body.getValue("operation").obj()
        val changedOperation = JsonObject(operation + ("value" to obj("application_id" to text("com.example.other"))))
        val changedBody = JsonObject(body + ("operation" to changedOperation))
        val changed = JsonObject(first + ("body" to changedBody))
        fault("command_retired") { f.execute(changed) }
        val newer = f.command(ledgerId(261))
        fault("invalid_command_sequence") { f.execute(JsonObject(newer + ("message_id" to first.getValue("message_id")))) }
        f.session = "session-next"; f.open()
        fault("command_retired") { f.execute(f.command()) }
        val reopened = Fixture(f.storage); reopened.open()
        fault("command_retired") { reopened.execute() }
        assertEquals(0, reopened.applications.effects)
    }

    @Test fun wrong_or_stale_ack_keeps_original_result_and_unknown_is_never_retired() {
        val f = Fixture(); f.open(); f.execute(); val valid = ack(f)
        val body = valid.getValue("body").obj(); val before = f.storage.bytes!!.copyOf()
        for (field in listOf("command_digest", "result_digest")) {
            fault("invalid_receipt") { f.receive(JsonObject(valid + ("body" to JsonObject(body + (field to text("sha256:" + "0".repeat(64)))))), "receipt") }
            assertContentEquals(before, f.storage.bytes)
        }
        fault("session_mismatch") { f.receive(JsonObject(valid + ("session_id" to text("old"))), "receipt") }
        f.receive(valid, "receipt"); val calls = f.storage.calls
        f.receive(valid, "receipt"); assertEquals(calls, f.storage.calls)
        val unknown = Fixture(); unknown.open(); unknown.applications.fail = true; unknown.execute()
        fault("invalid_receipt") { unknown.receive(ack(unknown), "receipt") }
        assertEquals(1, unknown.storage.document().getValue("entries").obj().size)
        assertNull(unknown.agent.pendingReceipt()); assertEquals(1, unknown.applications.effects)
    }

    @Test fun retirement_commit_failure_blocks_and_reopen_uses_only_actual_durable_state() {
        for (after in listOf(false, true)) {
            val f = Fixture(); f.open(); f.execute(); val receipt = ack(f)
            f.storage.failAt = f.storage.calls + 1; f.storage.failAfter = after
            fault("storage_unavailable") { f.receive(receipt, "receipt") }
            assertTrue(f.agent.blocked); assertEquals(1, f.applications.effects)
            val reopened = Fixture(f.storage); reopened.session = "new-session"; reopened.open()
            fault(if (after) "command_retired" else "duplicate_conflict") { reopened.execute() }
            assertEquals(0, reopened.applications.effects)
        }
    }

    @Test fun gateway_history_rollback_is_rejected_and_device_backup_recovers_boundary_before_ready() {
        val f = Fixture(); f.open(); f.execute(); f.agent.disconnected()
        val hello = DeviceDocument.parse(f.agent.connected().payload); val challenge = hello.getValue("body").obj().text("challenge")
        val before = f.storage.bytes!!.copyOf()
        fault("gateway_history_rollback") { f.receive(f.welcome(challenge, 0), "welcome") }
        assertFalse(f.agent.ready); assertContentEquals(before, f.storage.bytes)
        f.receive(f.welcome(challenge, 100), "welcome")
        assertEquals(100L, f.storage.document().integer("high_watermark"))
        fault("command_retired") { f.execute(f.command(ledgerId(2))) }
        val restored = Fixture(); val newHello = DeviceDocument.parse(restored.agent.connected().payload)
        restored.receive(restored.welcome(newHello.getValue("body").obj().text("challenge"), 100), "welcome")
        fault("command_retired") { restored.execute() }
        assertEquals(100L, restored.storage.document().integer("high_watermark")); assertEquals(0, restored.applications.effects)
        val failing = Fixture(); failing.storage.failAt = 1
        val failingHello = DeviceDocument.parse(failing.agent.connected().payload)
        fault("storage_unavailable") { failing.receive(failing.welcome(failingHello.getValue("body").obj().text("challenge"), 100), "welcome") }
        assertFalse(failing.agent.ready); assertTrue(failing.agent.blocked)
    }

    @Test fun version_one_opaque_receipt_migrates_without_replaying_or_dropping_original() {
        val original = Fixture(); original.open(); original.execute()
        val entry = original.storage.document().getValue("entries").obj().values.single().obj()
        val legacyId = "legacy-command"; val command = entry.getValue("command").obj()
        val legacy = JsonObject(command + ("message_id" to text("legacy-message")) + ("body" to JsonObject(command.getValue("body").obj() + ("command_id" to text(legacyId)))))
        val result = JsonObject(entry.getValue("result").obj() + ("command_id" to text(legacyId)))
        val doc = original.storage.document().toMutableMap().apply {
            this["version"] = JsonPrimitive(1); remove("high_watermark")
            this["entries"] = obj(legacyId to obj("command" to legacy, "result" to result))
        }
        original.storage.bytes = JsonObject(doc).toString().toByteArray(); val before = original.storage.bytes!!.copyOf()
        val reopened = Fixture(original.storage); assertContentEquals(before, reopened.storage.bytes); reopened.open()
        val report = DeviceDocument.parse(reopened.agent.pendingReceipt()!!.payload).getValue("body").obj()
        assertEquals(legacy, report["command"]); assertEquals(result, report["result"])
        reopened.receive(ack(reopened, legacy, result), "receipt")
        assertEquals(2L, reopened.storage.document().integer("version")); assertTrue(reopened.storage.document().getValue("entries").obj().isEmpty())
        assertEquals(0, reopened.applications.effects)
        fault("invalid_command_sequence") { reopened.execute(legacy) }
    }

    @Test fun timestamp_parsing_is_strict_and_handles_gateway_fractional_seconds() {
        assertEquals(DeviceTime.parse("2026-11-02T00:00:00.123Z"), DeviceTime.parse("2026-11-02T08:00:00.123456789+08:00"))
        for (invalid in listOf("2026-02-29T00:00:00Z", "2026-11-02T24:00:00Z", "2026-11-02T00:00:00+24:00", "2026-11-02T00:00:00Z\n", "2026-11-02T00:00:60Z")) fault("invalid_time") { DeviceTime.parse(invalid) }
    }

    @Test fun explicit_model_migration_keeps_original_envelopes_unknown_attempts_and_retirement_boundary() {
        val old = Fixture(); old.open(); old.execute(); old.applications.fail = true
        old.execute(old.command(ledgerId(2))); old.execute(old.command(ledgerId(3)))
        val doc = old.storage.document(); val original = doc.getValue("entries").obj().toMutableMap()
        original[ledgerId(3)] = JsonObject(original.getValue(ledgerId(3)).obj() + ("result" to JsonNull))
        old.storage.bytes = JsonObject(doc + ("entries" to JsonObject(original))).toString().toByteArray()
        val before = old.storage.bytes!!.copyOf()
        val current = Fixture(old.storage, profile = DeviceModelProfile.COMPOSED_REMOTE)
        assertContentEquals(before, current.storage.bytes, "construction only validates; it must not rewrite history")
        val hello = current.open()
        assertEquals(DeviceModelProfile.COMPOSED_REMOTE.revision, hello.text("model_revision"))
        assertEquals(JsonArray(listOf(text("apps.launch"))), hello.getValue("body").obj()["execution_paths"])
        val migrated = current.storage.document()
        assertEquals(3L, migrated.integer("version")); assertEquals(3L, migrated.integer("high_watermark"))
        assertEquals(JsonObject(original), migrated["entries"], "original models, full requests and results must remain unchanged")
        val receipt = DeviceDocument.parse(current.agent.pendingReceipt()!!.payload)
        assertEquals(DeviceModelProfile.COMPOSED_REMOTE.revision, receipt.text("model_revision"))
        val command = original.getValue(ledgerId(1)).obj().getValue("command").obj()
        val result = original.getValue(ledgerId(1)).obj().getValue("result").obj()
        assertEquals(command, receipt.getValue("body").obj()["command"])
        current.receive(ack(current, command, result), "receipt")
        assertEquals(2, current.storage.document().getValue("entries").obj().size)
        assertNull(current.agent.pendingReceipt(), "unknown and unresolved attempts cannot be reclaimed")
        fault("duplicate_conflict") { current.execute(current.command(ledgerId(2))) }
        fault("duplicate_conflict") { current.execute(current.command(ledgerId(3))) }
        fault("command_retired") { current.execute(current.command()) }
        assertEquals(0, current.applications.effects)
        assertEquals("confirmed", current.execute(current.command(ledgerId(4))).text("status"))
        assertEquals(1, current.applications.effects)
        fault("storage_corrupt") { Fixture(current.storage) }
    }

    @Test fun model_migration_commit_failure_stops_before_hello_and_never_drops_ambiguous_records() {
        for (after in listOf(false, true)) {
            val old = Fixture(); old.open(); old.applications.fail = true; old.execute()
            val before = old.storage.bytes!!.copyOf(); old.storage.failAt = old.storage.calls + 1; old.storage.failAfter = after
            val current = Fixture(old.storage, profile = DeviceModelProfile.COMPOSED_REMOTE)
            fault("storage_unavailable") { current.agent.connected() }
            assertTrue(current.agent.blocked); assertFalse(current.agent.ready); assertEquals(0, current.applications.effects)
            if (!after) assertContentEquals(before, current.storage.bytes)
            val reopened = Fixture(old.storage, profile = DeviceModelProfile.COMPOSED_REMOTE); reopened.open()
            assertEquals("unknown", reopened.storage.document().getValue("entries").obj().values.single().obj().getValue("result").obj().text("status"))
            assertEquals(1L, reopened.storage.document().integer("high_watermark")); assertEquals(0, reopened.applications.effects)
        }
    }

    @Test fun composed_model_does_not_grant_remote_keys_or_accept_other_live_model_revisions() {
        val f = Fixture(profile = DeviceModelProfile.COMPOSED_REMOTE); f.open()
        val command = f.command()
        fault("model_mismatch") { f.execute(JsonObject(command + ("model_revision" to text(TelevisionAgentModel.revision)))) }
        val body = command.getValue("body").obj()
        val remote = obj("type" to text("action.invoke"), "path" to text("remote.press"), "value" to obj("key" to text("home")))
        fault("unsupported_capability") { f.execute(JsonObject(command + ("body" to JsonObject(body + ("operation" to remote))))) }
        assertEquals(0, f.applications.effects)
        val before = f.storage.bytes!!.copyOf()
        val invalid = JsonObject(f.storage.document() + ("model_revision" to text(TelevisionAgentModel.revision)))
        fault("storage_corrupt") { DeviceJournalMigration.prepare(f.identity, invalid.toString().toByteArray()) }
        assertContentEquals(before, f.storage.bytes)
        fault("unsupported_model_profile") { DeviceModelProfile.parse("arbitrary-model") }
    }
}
