package run.limeai.iot.television

import android.Manifest
import android.app.Application
import android.content.ContextWrapper
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Build
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowAudioManager
import run.limeai.iot.device.AudioState
import run.limeai.iot.device.DeviceFault
import kotlin.test.*

/** 公开系统音频API的宿主边界；系统范围、实际读数和效果均为明确夹具，不访问电视。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [23, 28], application = Application::class, shadows = [AndroidAudioTest.Mixer::class])
class AndroidAudioTest {
    @Implements(AudioManager::class)
    class Mixer : ShadowAudioManager() {
        @Implementation fun isVolumeFixed() = fixed
        @Implementation(minSdk = 28) fun getStreamMinVolume(stream: Int): Int { music(stream); return minimum }
        @Implementation public override fun getStreamMaxVolume(stream: Int): Int { music(stream); onMaximumRead(++maximumReads); return maximum }
        @Implementation public override fun getStreamVolume(stream: Int): Int { music(stream); onVolumeRead(); return index }
        @Implementation public override fun isStreamMute(stream: Int): Boolean { music(stream); return muted }
        @Implementation public override fun setStreamVolume(stream: Int, value: Int, flags: Int) {
            music(stream); volumes += Triple(stream, value, flags)
            check(!failWrite) { "fixture native volume call failed after entry" }
        }
        @Implementation public override fun adjustStreamVolume(stream: Int, direction: Int, flags: Int) {
            music(stream); adjustments += Triple(stream, direction, flags)
            check(!failWrite) { "fixture native mute call failed after entry" }
        }
        companion object {
            var minimum = 0; var maximum = 15; var index = 4; var muted = false; var fixed = false; var failWrite = false
            var maximumReads = 0
            var onMaximumRead: (Int) -> Unit = {}; var onVolumeRead: () -> Unit = {}
            val volumes = mutableListOf<Triple<Int, Int, Int>>()
            val adjustments = mutableListOf<Triple<Int, Int, Int>>()
            private fun music(stream: Int) { assertEquals(AudioManager.STREAM_MUSIC, stream) }
            fun reset() {
                minimum = 0; maximum = 15; index = 4; muted = false; fixed = false; failWrite = false; maximumReads = 0
                onMaximumRead = {}; onVolumeRead = {}; volumes.clear(); adjustments.clear()
            }
        }
    }

    private var authorized = true
    private var credentials = true
    private var permission = true
    private var permit = RunPermit()
    private val lock = Any()
    private val context by lazy { object : ContextWrapper(RuntimeEnvironment.getApplication()) {
        override fun checkSelfPermission(name: String): Int = if (name == Manifest.permission.MODIFY_AUDIO_SETTINGS) {
            if (permission) PackageManager.PERMISSION_GRANTED else PackageManager.PERMISSION_DENIED
        } else super.checkSelfPermission(name)
    } }
    private fun audio() = AndroidAudio(context, { authorized }, lock, permit, { credentials })
    private fun fault(code: String, action: () -> Any?) = assertEquals(code, assertFailsWith<DeviceFault> { action() }.code)
    private fun noEffects() { assertTrue(Mixer.volumes.isEmpty()); assertTrue(Mixer.adjustments.isEmpty()) }

    @Before fun setup() { Mixer.reset(); authorized = true; credentials = true; permission = true; permit = RunPermit() }

    @Test fun read_uses_actual_music_range_volume_and_independent_mute_without_effects() {
        Mixer.minimum = 2; Mixer.index = 3; Mixer.muted = true
        val state = audio().read()
        assertEquals(AudioState(if (Build.VERSION.SDK_INT >= 28) 2 else 0, 15, 3, true), state)
        Mixer.index = 0; Mixer.minimum = 0; Mixer.muted = false
        assertEquals(AudioState(0, 15, 0, false), audio().read()); noEffects()
    }

    @Test fun volume_quantizes_to_native_index_without_ui_or_fabricated_readback() {
        val audio = audio(); audio.setVolume(50)
        assertEquals(listOf(Triple(AudioManager.STREAM_MUSIC, 8, 0)), Mixer.volumes)
        assertEquals(27, audio.read().percent); assertEquals(4, audio.read().index)
        assertTrue(Mixer.adjustments.isEmpty())
        Mixer.index = 8
        assertEquals(53, audio.read().percent)
    }

    @Test fun mute_and_unmute_use_explicit_directions_and_do_not_rewrite_volume_or_state() {
        val audio = audio(); audio.setMuted(true); audio.setMuted(false)
        assertEquals(listOf(Triple(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_MUTE, 0),
            Triple(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_UNMUTE, 0)), Mixer.adjustments)
        assertTrue(Mixer.volumes.isEmpty()); assertFalse(audio.read().muted)
        Mixer.index = 0; Mixer.muted = true
        assertTrue(audio.read().muted); assertEquals(0, audio.read().percent)
    }

    @Test fun missing_grant_permission_credentials_fixed_volume_and_stopped_permit_refuse_effects() {
        for (case in 0..4) {
            authorized = true; credentials = true; permission = true; Mixer.fixed = false; permit = RunPermit()
            val audio = audio()
            val code = when (case) {
                0 -> { authorized = false; "audio_not_authorized" }
                1 -> { credentials = false; "audio_not_authorized" }
                2 -> { permission = false; "audio_permission_required" }
                3 -> { Mixer.fixed = true; "audio_volume_fixed" }
                else -> { permit.stop(); "audio_not_authorized" }
            }
            assertFalse(audio.permitted()); fault(code) { audio.read() }; fault(code) { audio.setVolume(50) }; fault(code) { audio.setMuted(true) }
            noEffects()
        }
        val stopped = audio(); permit = RunPermit()
        assertFalse(stopped.permitted()); assertTrue(audio().permitted()); noEffects()
    }

    @Test fun revocation_during_native_sampling_prevents_control_and_reuses_no_old_authority() {
        val audio = audio()
        Mixer.onVolumeRead = { authorized = false }
        fault("audio_not_authorized") { audio.setVolume(50) }; noEffects()
        authorized = true; Mixer.onVolumeRead = { credentials = false }
        fault("audio_not_authorized") { audio.setMuted(true) }; noEffects()
        credentials = true; Mixer.onVolumeRead = { permission = false }
        fault("audio_permission_required") { audio.read() }; noEffects()
        permission = true; Mixer.onVolumeRead = { permit.stop() }
        fault("audio_not_authorized") { audio.setVolume(50) }; noEffects()
    }

    @Test fun invalid_or_changing_system_ranges_and_invalid_percentages_refuse_effects() {
        val audio = audio()
        Mixer.index = 16; fault("invalid_audio_state") { audio.read() }; assertFalse(audio.permitted())
        Mixer.index = 4; Mixer.maximum = 0; fault("invalid_audio_state") { audio.setMuted(true) }
        Mixer.maximum = 15
        fault("invalid_audio_volume") { audio.setVolume(-1) }; fault("invalid_audio_volume") { audio.setVolume(101) }
        Mixer.maximumReads = 0; Mixer.onMaximumRead = { if (it == 2) Mixer.maximum = 14 }
        fault("audio_state_changed") { audio.setVolume(50) }; noEffects()
    }

    @Test fun native_call_failure_propagates_without_retry_fallback_or_invented_observation() {
        val audio = audio(); Mixer.failWrite = true
        assertFailsWith<IllegalStateException> { audio.setVolume(50) }
        assertEquals(listOf(Triple(AudioManager.STREAM_MUSIC, 8, 0)), Mixer.volumes); assertTrue(Mixer.adjustments.isEmpty())
        assertEquals(27, audio.read().percent)
        assertFailsWith<IllegalStateException> { audio.setMuted(true) }
        assertEquals(1, Mixer.volumes.size); assertEquals(listOf(Triple(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_MUTE, 0)), Mixer.adjustments)
        assertFalse(audio.read().muted)
    }
}
