package run.limeai.iot.television

import org.junit.Test
import run.limeai.iot.device.DeviceFault
import kotlin.test.*

class AudioRunConsentTest {
    private val summary = EnrollmentSummary("home", "tv", "ssl://localhost:8883", "ca", "certificate", "expiry",
        "android-tv-audio-agent", "revision", false)
    private fun consent() = AudioRunConsent(Any()).also { it.visible(true) }
    private fun approval(consent: AudioRunConsent, run: RunPermit = RunPermit()): AudioStartApproval {
        val review = consent.review(summary); consent.approve(review, summary)
        return consent.consume(run)!!
    }

    @Test fun default_authority_requires_visible_review_an_audio_profile_and_current_credentials() {
        val consent = AudioRunConsent(Any())
        assertFalse(consent.authorized)
        assertFailsWith<DeviceFault> { consent.review(summary) }
        consent.visible(true)
        for (invalid in listOf(summary.copy(model = "android-tv-agent"), summary.copy(expired = true)))
            assertFailsWith<DeviceFault> { consent.review(invalid) }
        assertNull(consent.consume(RunPermit()))
        assertFailsWith<DeviceFault> { consent.bind(RunPermit(), summary, null) }
        assertFalse(consent.authorized)
    }

    @Test fun leaving_or_stopping_invalidates_unconsumed_review_and_does_not_revive_on_return() {
        for (stop in listOf(false, true)) {
            val consent = consent(); val review = consent.review(summary); consent.approve(review, summary)
            if (stop) consent.clear() else { consent.visible(false); consent.visible(true) }
            assertNull(consent.consume(RunPermit()))
            assertFailsWith<DeviceFault> { consent.approve(review, summary) }
            assertFalse(consent.authorized)
        }
    }

    @Test fun changed_device_model_broker_certificate_or_trust_requires_another_review() {
        for (changed in listOf(summary.copy(space = "other"), summary.copy(device = "other"), summary.copy(broker = "ssl://other:8883"),
            summary.copy(ca = "other"), summary.copy(certificate = "other"), summary.copy(revision = "other"),
            summary.copy(model = "android-tv-audio-remote"), summary.copy(expires = "other"))) {
            val consent = consent(); val review = consent.review(summary)
            assertFailsWith<DeviceFault> { consent.approve(review, changed) }
            val approved = approval(consent)
            assertFailsWith<DeviceFault> { consent.bind(approved.run, changed, approved) }
            assertFalse(consent.authorized)
        }
    }

    @Test fun approval_is_single_use_and_bound_to_the_original_run_and_actual_review() {
        val consent = consent(); val approved = approval(consent)
        assertFailsWith<DeviceFault> { consent.consume(RunPermit()) }
        assertFailsWith<DeviceFault> { consent.bind(RunPermit(), summary, approved) }
        assertFailsWith<DeviceFault> { consent.bind(approved.run, summary, AudioStartApproval(approved.run, approved.review)) }
        consent.bind(approved.run, summary, approved)
        assertTrue(consent.allowed(approved.run)); assertFalse(consent.allowed(RunPermit()))
        assertFailsWith<DeviceFault> { consent.bind(approved.run, summary, approved) }
    }

    @Test fun consumed_authority_may_outlive_page_visibility_within_the_same_running_session() {
        val consent = consent(); val approved = approval(consent)
        consent.visible(false)
        consent.bind(approved.run, summary, approved)
        assertTrue(consent.authorized); assertTrue(consent.allowed(approved.run))
        assertFailsWith<DeviceFault> { consent.review(summary) }
        consent.clear(); assertFalse(consent.allowed(approved.run))
    }

    @Test fun withdrawal_between_start_and_bind_cancels_the_issued_approval_even_before_run_stop() {
        val consent = consent(); val approved = approval(consent)
        consent.clear()
        assertTrue(approved.run.active)
        assertFailsWith<DeviceFault> { consent.bind(approved.run, summary, approved) }
        assertFailsWith<DeviceFault> { consent.approve(approved.review, summary) }
        assertFalse(consent.authorized)
    }

    @Test fun a_new_authorization_or_runtime_cannot_reactivate_old_ports_or_old_reviews() {
        val consent = consent(); val old = approval(consent); consent.bind(old.run, summary, old)
        consent.clear()
        val fresh = approval(consent); consent.bind(fresh.run, summary, fresh)
        assertTrue(old.run.active); assertFalse(consent.allowed(old.run)); assertTrue(consent.allowed(fresh.run))
        val restarted = consent()
        assertFalse(restarted.authorized)
        assertFailsWith<DeviceFault> { restarted.approve(old.review, summary) }
        assertFailsWith<DeviceFault> { restarted.bind(old.run, summary, old) }
    }

    @Test fun a_stopped_run_cannot_consume_or_activate_an_approval() {
        val consent = consent(); val stopped = RunPermit().apply { stop() }
        assertFailsWith<DeviceFault> { consent.consume(stopped) }
        val approved = approval(consent); approved.run.stop()
        assertFailsWith<DeviceFault> { consent.bind(approved.run, summary, approved) }
        assertFalse(consent.authorized); assertFalse(consent.allowed(approved.run))
    }
}
