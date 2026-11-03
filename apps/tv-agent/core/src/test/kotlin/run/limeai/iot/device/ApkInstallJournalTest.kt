package run.limeai.iot.device

import kotlinx.serialization.json.*
import kotlin.test.*

class ApkInstallJournalTest {
    private class Storage : ApkInstallStorage {
        var bytes: ByteArray? = null
        var writes = 0
        var failAt = 0
        var failAfter = false
        override fun read() = bytes?.copyOf()
        override fun compareAndSet(expected: ByteArray?, updated: ByteArray): Boolean {
            writes++
            if (bytes == null && expected != null || bytes != null && (expected == null || !bytes!!.contentEquals(expected))) return false
            if (writes == failAt && !failAfter) throw Exception("before commit")
            bytes = updated.copyOf()
            if (writes == failAt) throw Exception("after durable commit")
            return true
        }
    }
    private fun fingerprint(character: Char) = "sha256:" + character.toString().repeat(64)
    private fun plan(id: String = "update-one") = ApkInstallPlan(id, "space-demo/device-tv/${fingerprint('a')}", fingerprint('b'), fingerprint('c'), fingerprint('d'), 3, 4, 12345, fingerprint('e'), fingerprint('f'))
    private fun fault(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<DeviceFault>(block = block).code)
    private fun phase(storage: Storage) = ApkInstallJournal(storage).snapshot().single().phase
    private fun staged(storage: Storage): ApkInstallJournal = ApkInstallJournal(storage).also { journal ->
        val p = plan(); journal.prepare(p); journal.createSession(p.requestId, {}, { 17 }); journal.staged(p.requestId, 17, p.candidateSha256, p.candidateBytes)
    }

    @Test fun original_request_is_idempotent_and_does_not_grant_installation_or_clear_history() {
        val storage = Storage(); val journal = ApkInstallJournal(storage); val p = plan()
        val original = journal.prepare(p); val writes = storage.writes
        assertEquals(original, journal.prepare(p)); assertEquals(writes, storage.writes)
        fault("apk_install_idempotency_conflict") { journal.prepare(p.copy(candidateBytes = 12346)) }
        fault("apk_install_in_progress") { journal.prepare(plan("other")) }
        journal.cancelPrepared(p.requestId)
        assertEquals(ApkInstallPhase.CANCELLED, journal.prepare(p).phase)
        assertEquals(1, journal.snapshot().size)
        assertEquals(ApkInstallPhase.PREPARED, journal.prepare(plan("other")).phase)
    }

    @Test fun create_and_commit_intents_are_durable_before_each_system_effect() {
        val storage = Storage(); val journal = ApkInstallJournal(storage); val p = plan(); var creates = 0; var submits = 0
        journal.prepare(p)
        journal.createSession(p.requestId, { assertEquals(p, it) }) {
            assertEquals(ApkInstallPhase.CREATING, phase(storage)); creates++; 17
        }
        fault("apk_install_stage_mismatch") { journal.staged(p.requestId, 18, p.candidateSha256, p.candidateBytes) }
        fault("apk_install_stage_mismatch") { journal.staged(p.requestId, 17, fingerprint('0'), p.candidateBytes) }
        fault("apk_install_not_staged") { journal.commit(p.requestId, {}, { _, _ -> submits++ }) }
        journal.staged(p.requestId, 17, p.candidateSha256, p.candidateBytes)
        var checks = 0
        journal.commit(p.requestId, { checks++ }) { actual, session ->
            assertEquals(p, actual); assertEquals(17, session); assertEquals(ApkInstallPhase.COMMITTING, phase(storage)); submits++
        }
        assertEquals(2, checks); assertEquals(1, creates); assertEquals(1, submits)
        journal.commit(p.requestId, { fail("must not revalidate as a new submission") }, { _, _ -> submits++ })
        assertEquals(1, submits)
        assertEquals(ApkInstallPhase.COMMITTING, ApkInstallJournal(storage).snapshot().single().phase)
    }

    @Test fun missing_creation_response_only_adopts_one_matching_original_session() {
        val storage = Storage(); val journal = ApkInstallJournal(storage); val p = plan(); var creates = 0
        journal.prepare(p)
        fault("apk_install_creation_unknown") { journal.createSession(p.requestId, {}, { creates++; throw Exception("lost return after create") }) }
        val reopened = ApkInstallJournal(storage)
        assertEquals(ApkInstallPhase.CREATING, reopened.createSession(p.requestId, {}, { creates++; 99 }).phase)
        val before = storage.bytes!!.copyOf()
        assertEquals(ApkInstallPhase.CREATING, reopened.resolveCreation(p.requestId, emptyList()).phase)
        assertContentEquals(before, storage.bytes)
        val found = ApkSessionClaim(17, p.digest, ApkInstallJournal.PACKAGE, p.candidateBytes)
        fault("apk_install_ambiguous_session") { reopened.resolveCreation(p.requestId, listOf(found, found.copy(sessionId = 18))) }
        fault("apk_install_session_mismatch") { reopened.resolveCreation(p.requestId, listOf(found.copy(size = 1))) }
        fault("apk_install_session_mismatch") { reopened.resolveCreation(p.requestId, listOf(found.copy(packageName = "example.other"))) }
        assertEquals(17, reopened.resolveCreation(p.requestId, listOf(found)).sessionId)
        assertEquals(1, creates)
    }

    @Test fun lost_commit_response_and_restart_never_resubmit_or_infer_success() {
        val storage = Storage(); val journal = staged(storage); var submits = 0
        fault("apk_install_commit_unknown") { journal.commit("update-one", {}, { _, _ -> submits++; throw Exception("lost system response") }) }
        val reopened = ApkInstallJournal(storage)
        assertEquals(ApkInstallPhase.COMMITTING, reopened.snapshot().single().phase)
        reopened.commit("update-one", {}, { _, _ -> submits++ })
        assertEquals(1, submits)
        fault("apk_install_in_progress") { reopened.prepare(plan("new-request")) }
        fault("apk_install_resolve_required") { reopened.cancelPrepared("update-one") }
    }

    @Test fun immediate_system_result_is_preserved_in_the_commit_return_and_original_record() {
        val storage = Storage(); val journal = staged(storage)
        val result = journal.commit("update-one", {}, { _, session -> journal.systemResult("update-one", session, ApkSystemResult.INSTALLED) })
        assertEquals(ApkInstallPhase.INSTALLED_UNVERIFIED, result.phase)
        assertEquals(result, ApkInstallJournal(storage).snapshot().single())
    }

    @Test fun pending_user_and_installed_results_preserve_original_session_and_still_block_another_install() {
        val storage = Storage(); val journal = staged(storage); journal.commit("update-one", {}, { _, _ -> })
        fault("apk_install_session_mismatch") { journal.systemResult("update-one", 18, ApkSystemResult.INSTALLED) }
        assertEquals(ApkInstallPhase.PENDING_USER, journal.systemResult("update-one", 17, ApkSystemResult.PENDING_USER_ACTION).phase)
        val writes = storage.writes
        journal.systemResult("update-one", 17, ApkSystemResult.PENDING_USER_ACTION); assertEquals(writes, storage.writes)
        val reopened = ApkInstallJournal(storage)
        reopened.commit("update-one", { fail("pending confirmation must not commit again") }, { _, _ -> fail("duplicate") })
        val installed = reopened.systemResult("update-one", 17, ApkSystemResult.INSTALLED)
        assertEquals(ApkInstallPhase.INSTALLED_UNVERIFIED, installed.phase); assertTrue(installed.blocksAnotherInstall)
        fault("apk_install_result_conflict") { reopened.systemResult("update-one", 17, ApkSystemResult.FAILED) }
        fault("apk_install_in_progress") { reopened.prepare(plan("next")) }
        assertEquals(ApkInstallPhase.INSTALLED_UNVERIFIED, ApkInstallJournal(storage).snapshot().single().phase)
    }

    @Test fun only_original_system_failure_or_cancellation_releases_occupancy() {
        for (result in listOf(ApkSystemResult.FAILED, ApkSystemResult.CANCELLED)) {
            val storage = Storage(); val journal = staged(storage); journal.commit("update-one", {}, { _, _ -> })
            val final = journal.systemResult("update-one", 17, result)
            assertFalse(final.blocksAnotherInstall)
            assertEquals(final, journal.prepare(plan()))
            journal.prepare(plan("next"))
            fault("apk_install_creation_unknown") { journal.createSession("next", {}, { 17 }) }
            assertEquals(listOf(final.phase, ApkInstallPhase.CREATING), journal.snapshot().map { it.phase })
        }
    }

    @Test fun stale_instances_cannot_overwrite_another_original_decision_or_invoke_effects() {
        val storage = Storage(); val first = ApkInstallJournal(storage); val stale = ApkInstallJournal(storage)
        first.prepare(plan())
        fault("apk_install_storage_conflict") { stale.prepare(plan("stale")) }
        assertTrue(stale.blocked)
        fault("apk_install_storage_reopen_required") { stale.createSession("stale", {}, { fail("not allowed") }) }
        assertEquals(listOf("update-one"), ApkInstallJournal(storage).snapshot().map { it.plan.requestId })
        val stalePrepared = ApkInstallJournal(storage)
        first.cancelPrepared("update-one")
        fault("apk_install_storage_conflict") { stalePrepared.createSession("update-one", {}, { fail("CAS must precede system create") }) }
        assertEquals(ApkInstallPhase.CANCELLED, phase(storage))
    }

    @Test fun storage_failures_before_and_after_durability_freeze_and_reopen_actual_phase_without_effects() {
        for (point in 1..6) for (after in listOf(false, true)) {
            val storage = Storage().apply { failAt = point; failAfter = after }
            val journal = ApkInstallJournal(storage); val p = plan(); var creates = 0; var submits = 0
            fault("apk_install_storage_unavailable") {
                journal.prepare(p)
                journal.createSession(p.requestId, {}, { creates++; 17 })
                journal.staged(p.requestId, 17, p.candidateSha256, p.candidateBytes)
                journal.commit(p.requestId, {}, { _, _ -> submits++ })
                journal.systemResult(p.requestId, 17, ApkSystemResult.INSTALLED)
            }
            assertTrue(journal.blocked)
            assertEquals(if (point <= 2) 0 else 1, creates, "create boundary $point/$after")
            assertEquals(if (point <= 5) 0 else 1, submits, "commit boundary $point/$after")
            fault("apk_install_storage_reopen_required") { journal.snapshot() }
            val reopened = ApkInstallJournal(storage).snapshot()
            val phases = listOf(null, ApkInstallPhase.PREPARED, ApkInstallPhase.CREATING, ApkInstallPhase.CREATED, ApkInstallPhase.STAGED, ApkInstallPhase.COMMITTING, ApkInstallPhase.INSTALLED_UNVERIFIED)
            assertEquals(phases[point - if (after) 0 else 1], reopened.singleOrNull()?.phase)
        }
    }

    @Test fun recheck_failure_before_or_after_intent_is_zero_commit_without_retry_fallback() {
        for (failCheck in listOf(1, 2)) {
            val storage = Storage(); val journal = staged(storage); var checks = 0; var effects = 0
            assertFailsWith<IllegalStateException> { journal.commit("update-one", { if (++checks == failCheck) error("current eligibility refused") }, { _, _ -> effects++ }) }
            assertEquals(0, effects)
            assertEquals(if (failCheck == 1) ApkInstallPhase.STAGED else ApkInstallPhase.COMMITTING, phase(storage))
            if (failCheck == 2) ApkInstallJournal(storage).commit("update-one", {}, { _, _ -> effects++ })
            assertEquals(0, effects)
        }
    }

    @Test fun invalid_plans_and_corrupt_future_or_conflicting_records_are_never_rewritten() {
        val p = plan()
        for (change in listOf<() -> ApkInstallPlan>({ p.copy(candidateVersion = 3) }, { p.copy(requestId = "") }, { p.copy(candidateBytes = 0) }, { p.copy(candidateSha256 = p.baselineSha256) }, { p.copy(continuityDigest = "bad") }))
            fault("invalid_apk_install_plan") { change() }
        val storage = Storage(); staged(storage)
        val original = DeviceDocument.parse(storage.bytes!!)
        val operations = original["operations"]!!.jsonArray
        val item = operations.single().jsonObject
        val variants = listOf(
            JsonObject(original + ("schema_version" to JsonPrimitive(4))),
            JsonObject(original + ("extra" to JsonPrimitive(true))),
            JsonObject(original + ("operations" to JsonArray(listOf(item, item)))),
            JsonObject(original + ("operations" to JsonArray(listOf(JsonObject(item + ("session_id" to JsonPrimitive(0))))))),
            JsonObject(original + ("operations" to JsonArray(listOf(JsonObject(item + ("request_digest" to JsonPrimitive(fingerprint('0')))))))),
        )
        for (variant in variants) {
            val corrupt = Storage().apply { bytes = variant.toString().toByteArray() }; val before = corrupt.bytes!!.copyOf()
            fault("apk_install_storage_corrupt") { ApkInstallJournal(corrupt) }
            assertContentEquals(before, corrupt.bytes); assertEquals(0, corrupt.writes)
        }
    }

    @Test fun bounded_original_history_has_no_automatic_retirement_or_id_reuse() {
        val storage = Storage(); val journal = ApkInstallJournal(storage)
        repeat(128) { index -> journal.prepare(plan("update-$index")); journal.cancelPrepared("update-$index") }
        val before = storage.bytes!!.copyOf()
        fault("apk_install_capacity") { journal.prepare(plan("too-many")) }
        assertEquals(128, ApkInstallJournal(storage).snapshot().size)
        assertContentEquals(before, storage.bytes)
        assertEquals(ApkInstallPhase.CANCELLED, journal.prepare(plan("update-0")).phase)
    }

    private fun health(p: ApkInstallPlan = plan()) = ApkLocalHealth(p.digest, p.candidateSha256, p.candidateBytes, p.signerSha256,
        p.candidateVersion, p.continuityDigest, fingerprint('1'), 2)
    private fun installed(storage: Storage) = staged(storage).also {
        it.commit("update-one", {}, { _, _ -> }); it.systemResult("update-one", 17, ApkSystemResult.INSTALLED)
    }

    @Test fun health_requires_original_system_success_and_exact_plan_facts_without_writing_on_refusal() {
        val storage = Storage(); val journal = staged(storage); val h = health()
        fault("apk_install_health_not_ready") { journal.acceptLocalHealth("update-one") { fail("no check before system success") } }
        journal.commit("update-one", {}, { _, _ -> })
        fault("apk_install_health_not_ready") { journal.acceptLocalHealth("update-one") { h } }
        journal.systemResult("update-one", 17, ApkSystemResult.PENDING_USER_ACTION)
        fault("apk_install_health_not_ready") { journal.acceptLocalHealth("update-one") { h } }
        journal.systemResult("update-one", 17, ApkSystemResult.INSTALLED)
        val before = storage.bytes!!.copyOf(); val writes = storage.writes
        for (wrong in listOf(h.copy(planDigest = fingerprint('0')), h.copy(installedSha256 = fingerprint('0')), h.copy(installedBytes = 1),
            h.copy(signerSha256 = fingerprint('0')), h.copy(runningVersion = 3), h.copy(continuityDigest = fingerprint('0')),
            h.copy(certificateSha256 = "bad"), h.copy(discoveredApplications = 129))) {
            fault("apk_install_health_mismatch") { journal.acceptLocalHealth("update-one") { wrong } }
        }
        assertFailsWith<IllegalStateException> { journal.acceptLocalHealth("update-one") { error("identity check failed") } }
        assertContentEquals(before, storage.bytes); assertEquals(writes, storage.writes)
        assertTrue(journal.snapshot().single().blocksAnotherInstall)
    }

    @Test fun explicit_local_health_acceptance_is_durable_idempotent_and_preserves_original_session_and_history() {
        val storage = Storage(); val journal = installed(storage)
        val accepted = journal.acceptLocalHealth("update-one") { health(it) }
        assertEquals(ApkInstallPhase.LOCAL_HEALTH_ACCEPTED, accepted.phase); assertFalse(accepted.blocksAnotherInstall)
        assertEquals(17, accepted.sessionId); assertEquals(health(), accepted.localHealth)
        val writes = storage.writes
        assertEquals(accepted, ApkInstallJournal(storage).acceptLocalHealth("update-one") { fail("accepted decision is read-only") })
        assertEquals(accepted, journal.systemResult("update-one", 17, ApkSystemResult.INSTALLED))
        journal.commit("update-one", { fail("no recheck") }, { _, _ -> fail("no reinstall") })
        assertEquals(writes, storage.writes)
        fault("apk_install_result_conflict") { journal.systemResult("update-one", 17, ApkSystemResult.FAILED) }
        fault("apk_install_session_mismatch") { journal.systemResult("update-one", 18, ApkSystemResult.INSTALLED) }
        journal.prepare(plan("next"))
        assertEquals(accepted, ApkInstallJournal(storage).snapshot().first())
    }

    @Test fun original_v1_records_are_read_only_until_a_current_cas_and_old_schema_cannot_claim_health() {
        val storage = Storage(); installed(storage)
        val original = DeviceDocument.parse(storage.bytes!!)
        val legacy = JsonObject(original + mapOf("schema_version" to JsonPrimitive(1), "operations" to JsonArray(original.getValue("operations").jsonArray.map {
            JsonObject(it.jsonObject - setOf("local_health", "recovered_from", "recovery_result"))
        })))
        storage.bytes = legacy.toString().toByteArray(); val before = storage.bytes!!.copyOf(); val writes = storage.writes
        val reopened = ApkInstallJournal(storage)
        assertEquals(ApkInstallPhase.INSTALLED_UNVERIFIED, reopened.snapshot().single().phase)
        assertContentEquals(before, storage.bytes); assertEquals(writes, storage.writes)
        reopened.acceptLocalHealth("update-one") { health(it) }
        assertEquals(3, DeviceDocument.parse(storage.bytes!!).getValue("schema_version").jsonPrimitive.int)
        val v2 = DeviceDocument.parse(storage.bytes!!)
        storage.bytes = JsonObject(v2 + ("schema_version" to JsonPrimitive(1))).toString().toByteArray()
        fault("apk_install_storage_corrupt") { ApkInstallJournal(storage) }
    }

    @Test fun health_write_before_and_after_durability_and_stale_cas_reopen_without_install_effects() {
        for (after in listOf(false, true)) {
            val storage = Storage(); val journal = installed(storage)
            storage.failAt = storage.writes + 1; storage.failAfter = after
            fault("apk_install_storage_unavailable") { journal.acceptLocalHealth("update-one") { health(it) } }
            fault("apk_install_storage_reopen_required") { journal.snapshot() }
            val reopened = ApkInstallJournal(storage)
            assertEquals(if (after) ApkInstallPhase.LOCAL_HEALTH_ACCEPTED else ApkInstallPhase.INSTALLED_UNVERIFIED, reopened.snapshot().single().phase)
            storage.failAt = 0
            reopened.acceptLocalHealth("update-one") { health(it) }
            assertFalse(ApkInstallJournal(storage).snapshot().single().blocksAnotherInstall)
        }
        val storage = Storage(); val first = installed(storage); val stale = ApkInstallJournal(storage)
        first.acceptLocalHealth("update-one") { health(it) }
        fault("apk_install_storage_conflict") { stale.acceptLocalHealth("update-one") { health(it) } }
        assertEquals(health(), ApkInstallJournal(storage).snapshot().single().localHealth)
    }

    @Test fun tampered_or_inconsistent_health_receipts_are_rejected_without_rewrite() {
        val storage = Storage(); installed(storage).acceptLocalHealth("update-one") { health(it) }
        val original = DeviceDocument.parse(storage.bytes!!); val item = original.getValue("operations").jsonArray.single().jsonObject
        val variants = listOf(
            JsonObject(item + ("local_health" to JsonNull)),
            JsonObject(item + ("phase" to JsonPrimitive("installed_unverified"))),
            JsonObject(item + ("local_health" to JsonObject(item.getValue("local_health").jsonObject + ("running_version" to JsonPrimitive(3))))),
            JsonObject(item + ("local_health" to JsonObject(item.getValue("local_health").jsonObject + ("extra" to JsonPrimitive(true))))),
            JsonObject(item + ("session_id" to JsonNull)),
        )
        for (variant in variants) {
            val corrupt = Storage().apply { bytes = JsonObject(original + ("operations" to JsonArray(listOf(variant)))).toString().toByteArray() }
            val before = corrupt.bytes!!.copyOf()
            fault("apk_install_storage_corrupt") { ApkInstallJournal(corrupt) }
            assertContentEquals(before, corrupt.bytes); assertEquals(0, corrupt.writes)
        }
    }

    private fun unresolved(storage: Storage, pending: Boolean = false) = staged(storage).also {
        it.commit("update-one", {}, { _, _ -> })
        if (pending) it.systemResult("update-one", 17, ApkSystemResult.PENDING_USER_ACTION)
    }

    @Test fun actual_package_recovery_keeps_original_unknown_phase_and_session_without_claiming_system_success() {
        for (pending in listOf(false, true)) {
            val storage = Storage(); val journal = unresolved(storage, pending)
            val phase = journal.snapshot().single().phase
            val recovered = journal.recoverInstalledPackage("update-one", phase) { original, session ->
                assertEquals(plan(), original); assertEquals(17, session); health(original)
            }
            assertEquals(ApkInstallPhase.LOCAL_PACKAGE_RECOVERED, recovered.phase)
            assertEquals(phase, recovered.recoveredFrom); assertEquals(health(), recovered.localHealth)
            assertEquals(17, recovered.sessionId); assertNull(recovered.recoveryResult); assertFalse(recovered.blocksAnotherInstall)
            val writes = storage.writes
            assertEquals(recovered, ApkInstallJournal(storage).recoverInstalledPackage("update-one", phase) { _, _ -> fail("read-only duplicate") })
            journal.commit("update-one", { fail("cannot recheck for another commit") }, { _, _ -> fail("cannot install again") })
            journal.createSession("update-one", { fail("cannot create again") }, { fail("cannot create again") })
            assertEquals(writes, storage.writes)
            journal.prepare(plan("next")); assertEquals(recovered, ApkInstallJournal(storage).snapshot().first())
        }
    }

    @Test fun package_recovery_refuses_precommit_wrong_original_phase_and_bad_health_without_any_write() {
        val storage = Storage(); val journal = staged(storage)
        fault("apk_install_package_recovery_not_ready") { journal.recoverInstalledPackage("update-one", ApkInstallPhase.COMMITTING) { _, _ -> fail("precommit must refuse") } }
        journal.commit("update-one", {}, { _, _ -> })
        val original = storage.bytes!!.copyOf(); val writes = storage.writes
        for (phase in listOf(ApkInstallPhase.PREPARED, ApkInstallPhase.STAGED, ApkInstallPhase.PENDING_USER, ApkInstallPhase.INSTALLED_UNVERIFIED))
            fault("apk_install_package_recovery_not_ready") { journal.recoverInstalledPackage("update-one", phase) { _, _ -> fail("wrong phase") } }
        fault("apk_install_health_mismatch") { journal.recoverInstalledPackage("update-one", ApkInstallPhase.COMMITTING) { p, _ -> health(p).copy(installedBytes = 1) } }
        assertFailsWith<IllegalStateException> { journal.recoverInstalledPackage("update-one", ApkInstallPhase.COMMITTING) { _, _ -> error("candidate or sessions refused") } }
        assertContentEquals(original, storage.bytes); assertEquals(writes, storage.writes)
        journal.systemResult("update-one", 17, ApkSystemResult.INSTALLED)
        fault("apk_install_package_recovery_not_ready") { journal.recoverInstalledPackage("update-one", ApkInstallPhase.COMMITTING) { _, _ -> fail("must use system-success health path") } }
    }

    @Test fun late_original_system_outcomes_are_durable_separate_and_never_overwrite_local_recovery() {
        for (result in listOf(ApkSystemResult.INSTALLED, ApkSystemResult.FAILED, ApkSystemResult.CANCELLED)) {
            val storage = Storage(); val journal = unresolved(storage)
            val recovered = journal.recoverInstalledPackage("update-one", ApkInstallPhase.COMMITTING) { p, _ -> health(p) }
            val writes = storage.writes
            assertEquals(recovered, journal.systemResult("update-one", 17, ApkSystemResult.PENDING_USER_ACTION)); assertEquals(writes, storage.writes)
            journal.prepare(plan("next"))
            val outcome = journal.systemResult("update-one", 17, result)
            assertEquals(recovered.copy(recoveryResult = result), outcome)
            assertEquals(outcome, ApkInstallJournal(storage).snapshot().first())
            val original = storage.bytes!!.copyOf()
            assertEquals(outcome, journal.systemResult("update-one", 17, result)); assertContentEquals(original, storage.bytes)
            val conflicting = if (result == ApkSystemResult.INSTALLED) ApkSystemResult.FAILED else ApkSystemResult.INSTALLED
            fault("apk_install_result_conflict") { journal.systemResult("update-one", 17, conflicting) }
            fault("apk_install_session_mismatch") { journal.systemResult("update-one", 18, result) }
            assertContentEquals(original, storage.bytes)
        }
    }

    @Test fun recovery_and_late_outcome_commit_faults_reopen_actual_durable_state_and_stale_cas_cannot_replace_it() {
        for (outcomeWrite in listOf(false, true)) for (after in listOf(false, true)) {
            val storage = Storage(); val journal = unresolved(storage)
            if (outcomeWrite) journal.recoverInstalledPackage("update-one", ApkInstallPhase.COMMITTING) { p, _ -> health(p) }
            storage.failAt = storage.writes + 1; storage.failAfter = after
            fault("apk_install_storage_unavailable") {
                if (outcomeWrite) journal.systemResult("update-one", 17, ApkSystemResult.FAILED)
                else journal.recoverInstalledPackage("update-one", ApkInstallPhase.COMMITTING) { p, _ -> health(p) }
            }
            fault("apk_install_storage_reopen_required") { journal.snapshot() }
            val reopened = ApkInstallJournal(storage); val actual = reopened.snapshot().single()
            assertEquals(if (outcomeWrite || after) ApkInstallPhase.LOCAL_PACKAGE_RECOVERED else ApkInstallPhase.COMMITTING, actual.phase)
            assertEquals(if (outcomeWrite && after) ApkSystemResult.FAILED else null, actual.recoveryResult)
            storage.failAt = 0
            if (outcomeWrite) reopened.systemResult("update-one", 17, ApkSystemResult.FAILED)
            else reopened.recoverInstalledPackage("update-one", ApkInstallPhase.COMMITTING) { p, _ -> health(p) }
            assertFalse(ApkInstallJournal(storage).snapshot().single().blocksAnotherInstall)
        }
        val storage = Storage(); val first = unresolved(storage); val stale = ApkInstallJournal(storage)
        first.systemResult("update-one", 17, ApkSystemResult.CANCELLED)
        fault("apk_install_storage_conflict") { stale.recoverInstalledPackage("update-one", ApkInstallPhase.COMMITTING) { p, _ -> health(p) } }
        assertEquals(ApkInstallPhase.CANCELLED, ApkInstallJournal(storage).snapshot().single().phase)
    }

    @Test fun v2_health_decisions_reopen_without_writing_and_next_cas_preserves_history_in_v3() {
        val storage = Storage(); val accepted = installed(storage).acceptLocalHealth("update-one") { health(it) }
        val original = DeviceDocument.parse(storage.bytes!!)
        storage.bytes = JsonObject(original + mapOf("schema_version" to JsonPrimitive(2), "operations" to JsonArray(original.getValue("operations").jsonArray.map {
            JsonObject(it.jsonObject - setOf("recovered_from", "recovery_result"))
        }))).toString().toByteArray()
        val before = storage.bytes!!.copyOf(); val writes = storage.writes
        val reopened = ApkInstallJournal(storage); assertEquals(accepted, reopened.snapshot().single())
        assertContentEquals(before, storage.bytes); assertEquals(writes, storage.writes)
        reopened.prepare(plan("next"))
        assertEquals(3, DeviceDocument.parse(storage.bytes!!).getValue("schema_version").jsonPrimitive.int)
        assertEquals(accepted, ApkInstallJournal(storage).snapshot().first())
    }

    @Test fun inconsistent_recovery_provenance_and_late_outcomes_are_corrupt_and_not_rewritten() {
        val storage = Storage(); unresolved(storage).recoverInstalledPackage("update-one", ApkInstallPhase.COMMITTING) { p, _ -> health(p) }
        val original = DeviceDocument.parse(storage.bytes!!); val item = original.getValue("operations").jsonArray.single().jsonObject
        val variants = listOf(
            JsonObject(item + ("recovered_from" to JsonNull)),
            JsonObject(item + ("recovered_from" to JsonPrimitive("staged"))),
            JsonObject(item + ("recovery_result" to JsonPrimitive("pending_user_action"))),
            JsonObject(item + ("phase" to JsonPrimitive("local_health_accepted"))),
            JsonObject(item + ("local_health" to JsonNull)),
            JsonObject(item + ("session_id" to JsonNull)),
        )
        val documents = variants.map { JsonObject(original + ("operations" to JsonArray(listOf(it)))) } + listOf(1, 2).map { version ->
            val legacy = JsonObject(item - setOf("recovered_from", "recovery_result") - if (version == 1) setOf("local_health") else emptySet())
            JsonObject(original + mapOf("schema_version" to JsonPrimitive(version), "operations" to JsonArray(listOf(legacy))))
        }
        for (document in documents) {
            val corrupt = Storage().apply { bytes = document.toString().toByteArray() }; val before = corrupt.bytes!!.copyOf()
            fault("apk_install_storage_corrupt") { ApkInstallJournal(corrupt) }
            assertContentEquals(before, corrupt.bytes); assertEquals(0, corrupt.writes)
        }
    }
}
