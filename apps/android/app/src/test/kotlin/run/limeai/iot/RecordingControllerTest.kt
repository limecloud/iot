package run.limeai.iot

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import run.limeai.iot.core.PcmRecording
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.test.*

private class CaptureInput : RecordingInput {
    var starts = 0; var closes = 0
    lateinit var samples: (ShortArray, Int) -> Unit
    lateinit var interrupted: () -> Unit
    override fun start(samples: (ShortArray, Int) -> Unit, interrupted: () -> Unit) { starts++; this.samples = samples; this.interrupted = interrupted }
    override fun close() { closes++ }
    fun push(size: Int, value: Short = 321) { samples(ShortArray(size) { value }, size) }
}
@OptIn(ExperimentalCoroutinesApi::class)
class RecordingControllerTest {
    private fun TestScope.recorder(input: CaptureInput, completed: (ByteArray) -> Boolean = { true }, clear: () -> Unit = {}): RecordingController {
        val dispatcher = StandardTestDispatcher(testScheduler)
        return RecordingController(this, { input }, completed, clear, dispatcher, dispatcher).also { it.setAvailable(true) }
    }
    @Test fun permissionIsExplicitAndCancelledOrDeniedGrantsNeverOpenInput() = runTest {
        val input = CaptureInput(); var opened = 0; var completed = 0
        val dispatcher = StandardTestDispatcher(testScheduler)
        val recorder = RecordingController(this, { opened++; input }, { completed++; true }, {}, dispatcher, dispatcher)
        assertNull(recorder.request()); recorder.setAvailable(true)
        val old = recorder.request()!!; runCurrent(); assertEquals(0, opened)
        recorder.cancel(); recorder.authorize(old, true); runCurrent(); assertEquals(0, opened)
        val denied = recorder.request()!!; recorder.authorize(denied, false); runCurrent()
        assertEquals(RecordingPhase.IDLE, recorder.state.value.phase); assertTrue(recorder.state.value.message.contains("权限"))
        assertEquals(0, opened); assertEquals(0, completed); recorder.close()
    }
    @Test fun completeStopsInputAndPublishesExactlyOneBoundedWav() = runTest {
        val input = CaptureInput(); val outputs = mutableListOf<ByteArray>()
        val recorder = recorder(input, { outputs.add(it.copyOf()); true })
        val key = recorder.request()!!; recorder.authorize(key, true); runCurrent(); assertEquals(1, input.starts)
        repeat(10) { input.push(1600) }; assertEquals(1, recorder.state.value.seconds); assertTrue(outputs.isEmpty())
        recorder.finish(); input.push(1024); input.interrupted(); runCurrent()
        assertEquals(1, input.closes); assertEquals(1, outputs.size); assertEquals(RecordingPhase.IDLE, recorder.state.value.phase)
        val wav = ByteBuffer.wrap(outputs.single()).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(16000, wav.getInt(24)); assertEquals(32000, wav.getInt(40)); assertEquals(32044, outputs.single().size)
        recorder.close(); assertEquals(1, input.closes)
    }
    @Test fun cancellationDuringOpeningClosesLateInputWithoutStartingIt() = runTest {
        val input = CaptureInput(); val dispatcher = StandardTestDispatcher(testScheduler)
        lateinit var recorder: RecordingController
        recorder = RecordingController(this, { recorder.cancel(); input }, { error("late output") }, {}, dispatcher, dispatcher)
        recorder.setAvailable(true); val key = recorder.request()!!; recorder.authorize(key, true); runCurrent()
        assertEquals(0, input.starts); assertEquals(1, input.closes); assertEquals(RecordingPhase.IDLE, recorder.state.value.phase); recorder.close()
    }
    @Test fun offlineCancelAndLateCallbacksCannotReviveRecording() = runTest {
        val input = CaptureInput(); var outputs = 0; var clears = 0
        val recorder = recorder(input, { outputs++; true }, { clears++ })
        val key = recorder.request()!!; recorder.authorize(key, true); runCurrent(); input.push(1600)
        recorder.setAvailable(false); input.push(1600); input.interrupted(); recorder.authorize(key, true); runCurrent()
        assertEquals(1, input.closes); assertEquals(0, outputs); assertNull(recorder.request()); assertTrue(clears >= 2)
        recorder.setAvailable(true); runCurrent(); assertEquals(1, input.starts); recorder.close(); assertNull(recorder.request())
    }
    @Test fun realFrameLimitStopsAtExactlySixtySecondsAndDoesNotPad() = runTest {
        val input = CaptureInput(); val outputs = mutableListOf<ByteArray>(); val recorder = recorder(input, { outputs.add(it.copyOf()); true })
        val key = recorder.request()!!; recorder.authorize(key, true); runCurrent()
        var remaining = PcmRecording.MAX_FRAMES
        while (remaining > 0) { val count = minOf(4096, remaining); input.push(count); remaining -= count }
        input.push(4096); runCurrent()
        assertEquals(1, input.closes); assertEquals(PcmRecording.MAX_BYTES, outputs.single().size)
        assertEquals(960000 * 2, ByteBuffer.wrap(outputs.single()).order(ByteOrder.LITTLE_ENDIAN).getInt(40))
        recorder.close()
    }
    @Test fun permissionAndRecordingDeadlinesKeepOriginalLimits() = runTest {
        val input = CaptureInput(); val outputs = mutableListOf<ByteArray>(); val recorder = recorder(input, { outputs.add(it.copyOf()); true })
        val expired = recorder.request()!!; advanceTimeBy(30001); runCurrent(); recorder.authorize(expired, true); runCurrent()
        assertEquals(0, input.starts); assertTrue(recorder.state.value.message.contains("超时"))
        val next = recorder.request()!!; recorder.authorize(next, true); runCurrent(); input.push(1600)
        advanceTimeBy(60001); runCurrent(); assertEquals(1, input.closes); assertEquals(3244, outputs.single().size); recorder.close()
    }
    @Test fun interruptedAndInvalidSamplesAndRejectedSelectionNeverPublish() = runTest {
        val input = CaptureInput(); var completed = 0; val recorder = recorder(input, { completed++; false })
        var key = recorder.request()!!; recorder.authorize(key, true); runCurrent(); input.interrupted(); runCurrent()
        assertEquals(1, input.closes); assertEquals(0, completed); assertTrue(recorder.state.value.message.contains("中断"))
        key = recorder.request()!!; recorder.authorize(key, true); runCurrent(); input.samples(shortArrayOf(1), 2); runCurrent()
        assertEquals(2, input.closes); assertEquals(0, completed)
        key = recorder.request()!!; recorder.authorize(key, true); runCurrent(); input.push(1600); recorder.finish(); runCurrent()
        assertEquals(3, input.closes); assertEquals(1, completed); assertTrue(recorder.state.value.message.contains("无法保留")); recorder.close()
    }
}
