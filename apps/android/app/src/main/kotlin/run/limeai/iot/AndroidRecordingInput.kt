package run.limeai.iot

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.annotation.RequiresPermission
import kotlinx.coroutines.*
import java.util.concurrent.atomic.AtomicBoolean
import run.limeai.iot.core.PcmRecording

internal class AndroidRecordingInput @RequiresPermission(Manifest.permission.RECORD_AUDIO) private constructor() : RecordingInput {
    private val gate = Any()
    private val closed = AtomicBoolean(false)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val recorder: AudioRecord
    init {
        val minimum = AudioRecord.getMinBufferSize(PcmRecording.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(minimum > 0 && minimum <= 1024 * 1024) { "recording_not_supported" }
        recorder = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            .setAudioFormat(AudioFormat.Builder().setSampleRate(PcmRecording.SAMPLE_RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(maxOf(minimum, 4096)).build()
        if (recorder.state != AudioRecord.STATE_INITIALIZED || recorder.sampleRate != PcmRecording.SAMPLE_RATE || recorder.channelCount != 1) { recorder.release(); error("recording_not_supported") }
    }
    override fun start(samples: (ShortArray, Int) -> Unit, interrupted: () -> Unit) {
        synchronized(gate) {
            check(!closed.get())
            recorder.startRecording(); check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING)
        }
        scope.launch {
            val buffer = ShortArray(1024)
            try {
                while (isActive && !closed.get()) {
                    val count = recorder.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                    if (closed.get()) return@launch
                    check(count in 1..buffer.size)
                    samples(buffer, count)
                }
            } catch (error: Exception) { if (!closed.get() && error !is CancellationException) interrupted() }
            finally { buffer.fill(0) }
        }
    }
    override fun close() {
        synchronized(gate) {
            if (!closed.compareAndSet(false, true)) return
            scope.cancel()
            try { if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop() }
            finally { recorder.release() }
        }
    }
    companion object {
        fun create(context: Context): RecordingInput {
            if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) throw SecurityException("recording_permission_denied")
            return AndroidRecordingInput()
        }
    }
}
