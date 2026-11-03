package run.limeai.iot.television

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Build
import run.limeai.iot.device.AudioPort
import run.limeai.iot.device.AudioState
import run.limeai.iot.device.DeviceFault

/** 只操作公开的媒体音频流；不显示系统音量界面，不保存或推测系统读数。 */
internal class AndroidAudio(
    private val context: Context,
    private val authorized: () -> Boolean,
    private val lock: Any,
    private val permit: RunPermit,
    private val credentialsValid: () -> Boolean,
) : AudioPort {
    private val manager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        ?: throw DeviceFault("audio_unavailable")

    private fun requireAvailable() {
        if (!permit.active || !authorized() || !credentialsValid()) throw DeviceFault("audio_not_authorized")
        if (context.checkSelfPermission(Manifest.permission.MODIFY_AUDIO_SETTINGS) != PackageManager.PERMISSION_GRANTED)
            throw DeviceFault("audio_permission_required")
        if (manager.isVolumeFixed) throw DeviceFault("audio_volume_fixed")
    }

    private fun minimum() = if (Build.VERSION.SDK_INT >= 28) manager.getStreamMinVolume(AudioManager.STREAM_MUSIC) else 0

    private fun sample(): AudioState {
        val low = minimum()
        val high = manager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val state = AudioState(low, high, manager.getStreamVolume(AudioManager.STREAM_MUSIC), manager.isStreamMute(AudioManager.STREAM_MUSIC))
        // 音频路由切换可能改变范围；不能使用跨两个范围拼接的样本或写入刻度。
        if (minimum() != low || manager.getStreamMaxVolume(AudioManager.STREAM_MUSIC) != high)
            throw DeviceFault("audio_state_changed")
        return state
    }

    override fun permitted(): Boolean = try { read(); true } catch (_: Exception) { false }

    override fun read(): AudioState = synchronized(lock) {
        requireAvailable()
        val state = sample()
        requireAvailable()
        state
    }

    override fun setVolume(percent: Int) = synchronized(lock) {
        requireAvailable()
        val index = sample().indexFor(percent)
        requireAvailable()
        manager.setStreamVolume(AudioManager.STREAM_MUSIC, index, 0)
    }

    override fun setMuted(muted: Boolean) = synchronized(lock) {
        requireAvailable()
        sample()
        requireAvailable()
        manager.adjustStreamVolume(AudioManager.STREAM_MUSIC, if (muted) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE, 0)
    }
}
