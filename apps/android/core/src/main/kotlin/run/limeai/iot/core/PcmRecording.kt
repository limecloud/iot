package run.limeai.iot.core

import java.nio.ByteBuffer
import java.nio.ByteOrder

object PcmRecording {
    const val SAMPLE_RATE = 16000
    const val MAX_SECONDS = 60
    const val MAX_FRAMES = SAMPLE_RATE * MAX_SECONDS
    const val MAX_BYTES = 44 + MAX_FRAMES * 2

    fun encode(samples: ShortArray): ByteArray {
        require(samples.isNotEmpty() && samples.size <= MAX_FRAMES) { "invalid_recording_audio" }
        val buffer = ByteBuffer.allocate(44 + samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        buffer.put("RIFF".toByteArray(Charsets.US_ASCII)); buffer.putInt(buffer.capacity() - 8)
        buffer.put("WAVEfmt ".toByteArray(Charsets.US_ASCII)); buffer.putInt(16)
        buffer.putShort(1); buffer.putShort(1); buffer.putInt(SAMPLE_RATE); buffer.putInt(SAMPLE_RATE * 2)
        buffer.putShort(2); buffer.putShort(16); buffer.put("data".toByteArray(Charsets.US_ASCII)); buffer.putInt(samples.size * 2)
        samples.forEach(buffer::putShort)
        return buffer.array().also { MediaChanges.upload(it, 600) }
    }
}
