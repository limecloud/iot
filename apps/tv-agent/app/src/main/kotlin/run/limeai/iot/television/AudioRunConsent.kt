package run.limeai.iot.television

import run.limeai.iot.device.DeviceFault
import run.limeai.iot.device.DeviceModelProfile

/** 仅进程内审阅，不进入Intent、Bundle或持久存储。 */
internal data class AudioStartReview(val summary: EnrollmentSummary, internal val foreground: RunPermit)
internal class AudioStartApproval(val run: RunPermit, val review: AudioStartReview)

/** 与运行/系统音频共用锁；可见审阅与已批准的一次运行各自拥有不可复活的许可。 */
internal class AudioRunConsent(private val lock: Any) {
    private var visible = false
    private var foreground: RunPermit? = null
    private var pending: AudioStartReview? = null
    private var issued: AudioStartApproval? = null
    private var active: RunPermit? = null
    val authorized: Boolean get() = synchronized(lock) { active?.active == true }

    fun visible(value: Boolean) = synchronized(lock) {
        visible = value
        if (!value) { foreground?.stop(); foreground = null; pending = null }
        else if (foreground == null) foreground = RunPermit()
    }

    private fun eligible(summary: EnrollmentSummary) {
        if (summary.expired || !DeviceModelProfile.parse(summary.model).hasAudio) throw DeviceFault("audio_consent_unavailable")
    }

    fun review(summary: EnrollmentSummary): AudioStartReview = synchronized(lock) {
        eligible(summary)
        AudioStartReview(summary, foreground?.takeIf { it.active } ?: throw DeviceFault("audio_review_expired"))
    }

    fun approve(review: AudioStartReview, summary: EnrollmentSummary) = synchronized(lock) {
        eligible(summary)
        if (review.summary != summary || foreground !== review.foreground || !review.foreground.active)
            throw DeviceFault("audio_review_expired")
        pending = review
    }

    fun consume(run: RunPermit): AudioStartApproval? = synchronized(lock) {
        if (issued != null || !run.active) throw DeviceFault("audio_consent_required")
        val review = pending; pending = null
        if (review != null && (foreground !== review.foreground || !review.foreground.active)) throw DeviceFault("audio_review_expired")
        review?.let { AudioStartApproval(run, it) }.also { issued = it }
    }

    fun bind(run: RunPermit, summary: EnrollmentSummary, approval: AudioStartApproval?) = synchronized(lock) {
        eligible(summary)
        if (!run.active || approval == null || issued !== approval || approval.run !== run || approval.review.summary != summary || active != null)
            throw DeviceFault("audio_consent_required")
        issued = null; active = run
    }

    fun allowed(run: RunPermit): Boolean = synchronized(lock) { active === run && run.active }

    fun clear() = synchronized(lock) {
        active = null; pending = null; issued = null
        foreground?.stop(); foreground = if (visible) RunPermit() else null
    }
}
