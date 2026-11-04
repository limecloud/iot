package run.limeai.iot.core

import java.io.ByteArrayInputStream
import java.io.File
import javax.sound.sampled.AudioSystem
import kotlin.test.*

class PcmRecordingTest {
    @Test fun littleEndianSamplesAreReadableByIndependentWavDecoder() {
        val encoded = PcmRecording.encode(shortArrayOf(Short.MIN_VALUE, -1, 0, 1, Short.MAX_VALUE))
        AudioSystem.getAudioInputStream(ByteArrayInputStream(encoded)).use { audio ->
            assertEquals(16000f, audio.format.sampleRate); assertEquals(1, audio.format.channels)
            assertEquals(16, audio.format.sampleSizeInBits); assertFalse(audio.format.isBigEndian)
            assertEquals(5, audio.frameLength)
            assertContentEquals(byteArrayOf(0, -128, -1, -1, 0, 0, 1, 0, -1, 127), audio.readAllBytes())
        }
        System.getenv("LIMEIOT_RECORDING_PCM_OUTPUT")?.let { File(it).writeBytes(encoded) }
    }
    @Test fun actualSixtySecondCapacityAndInvalidLengths() {
        val encoded = PcmRecording.encode(ShortArray(PcmRecording.MAX_FRAMES) { 1234 })
        assertEquals(PcmRecording.MAX_BYTES, encoded.size)
        AudioSystem.getAudioInputStream(ByteArrayInputStream(encoded)).use { assertEquals(960000, it.frameLength) }
        assertFailsWith<IllegalArgumentException> { PcmRecording.encode(shortArrayOf()) }
        assertFailsWith<IllegalArgumentException> { PcmRecording.encode(ShortArray(PcmRecording.MAX_FRAMES + 1)) }
    }
}
