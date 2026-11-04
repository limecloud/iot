package run.limeai.iot

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import run.limeai.iot.core.PcmRecording

internal interface RecordingInput : AutoCloseable {
    fun start(samples: (ShortArray, Int) -> Unit, interrupted: () -> Unit)
    override fun close()
}
internal enum class RecordingPhase { IDLE, REQUESTING, STARTING, RECORDING, FINISHING }
internal data class RecordingState(val phase: RecordingPhase = RecordingPhase.IDLE, val seconds: Int = 0, val message: String = "") {
    val busy get() = phase != RecordingPhase.IDLE
}

// 状态层只拥有本机采音资源，不持有网关、存储或模型执行接口。
internal class RecordingController(
    private val scope: CoroutineScope,
    private val factory: () -> RecordingInput,
    private val completed: (ByteArray) -> Boolean,
    private val cleared: () -> Unit,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val compute: CoroutineDispatcher = Dispatchers.Default,
) {
    private val gate = Any()
    private val mutable = MutableStateFlow(RecordingState())
    val state = mutable.asStateFlow()
    private var generation = 0L
    private var available = false
    private var active = true
    private var input: RecordingInput? = null
    private var samples: ShortArray? = null
    private var frames = 0
    private var work: Job? = null
    private var deadline: Job? = null
    private fun current(epoch: Long) = active && available && epoch == generation

    fun setAvailable(value: Boolean) { synchronized(gate) { available = value }; if (!value) cancel() }
    fun request(): Long? {
        val epoch = synchronized(gate) {
            if (!active || !available || mutable.value.busy) return null
            generation++; mutable.value = RecordingState(RecordingPhase.REQUESTING); generation
        }
        cleared()
        deadline = scope.launch { delay(30000); fail(epoch, "等待麦克风授权超时，请重新开始") }
        return epoch
    }
    fun authorize(epoch: Long, granted: Boolean) {
        synchronized(gate) {
            if (!current(epoch) || mutable.value.phase != RecordingPhase.REQUESTING) return
            if (granted) mutable.value = RecordingState(RecordingPhase.STARTING)
        }
        if (!granted) { fail(epoch, "未获得麦克风权限，可在系统设置中允许"); return }
        work = scope.launch {
            try {
                withContext(io) {
                    val source = factory()
                    val accepted = synchronized(gate) {
                        if (!current(epoch) || mutable.value.phase != RecordingPhase.STARTING) false
                        else {
                            input = source; samples = ShortArray(PcmRecording.MAX_FRAMES); frames = 0
                            mutable.value = RecordingState(RecordingPhase.RECORDING)
                            source.start({ chunk, count -> receive(epoch, chunk, count) }, { scope.launch { if (synchronized(gate) { current(epoch) && mutable.value.phase == RecordingPhase.RECORDING }) fail(epoch, "录音已中断，请重新开始") } })
                            true
                        }
                    }
                    if (!accepted) source.close()
                }
                synchronized(gate) {
                    if (current(epoch) && mutable.value.phase == RecordingPhase.RECORDING) {
                        deadline?.cancel(); deadline = scope.launch { delay(PcmRecording.MAX_SECONDS * 1000L); finish(epoch) }
                    }
                }
            } catch (error: Exception) {
                if (error !is CancellationException) fail(epoch, if (error is SecurityException) "未获得麦克风权限，可在系统设置中允许" else "麦克风不可用，请检查设备")
            }
        }
    }
    private fun receive(epoch: Long, chunk: ShortArray, count: Int) {
        var invalid = false
        val full = synchronized(gate) {
            if (!current(epoch) || mutable.value.phase != RecordingPhase.RECORDING) return
            if (count !in 1..chunk.size || count > 4096) { invalid = true; mutable.value = mutable.value.copy(phase = RecordingPhase.FINISHING); false }
            else {
                val size = minOf(count, PcmRecording.MAX_FRAMES - frames)
                chunk.copyInto(samples!!, frames, 0, size); frames += size
                mutable.value = mutable.value.copy(seconds = frames / PcmRecording.SAMPLE_RATE)
                frames == PcmRecording.MAX_FRAMES
            }
        }
        if (invalid) scope.launch { fail(epoch, "录音已中断，请重新开始") }
        else if (full) finish(epoch)
    }
    fun finish() = finish(synchronized(gate) { generation })
    private fun finish(epoch: Long) {
        val (source, recorded) = synchronized(gate) {
            if (!current(epoch) || mutable.value.phase != RecordingPhase.RECORDING) return
            mutable.value = mutable.value.copy(phase = RecordingPhase.FINISHING)
            deadline?.cancel(); deadline = null
            val result = input to samples!!.copyOf(frames)
            input = null; samples!!.fill(0); samples = null; frames = 0; result
        }
        runCatching { source?.close() }
        work = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            var bytes: ByteArray? = null
            try {
                bytes = withContext(compute) { PcmRecording.encode(recorded) }
                val valid = synchronized(gate) { current(epoch) && mutable.value.phase == RecordingPhase.FINISHING }
                if (valid) {
                    if (!completed(bytes)) fail(epoch, "无法保留录音，请重新开始")
                    else synchronized(gate) { if (current(epoch)) { generation++; mutable.value = RecordingState() } }
                }
            } catch (error: Exception) { if (error !is CancellationException) fail(epoch, "未能保存录音，请重新开始") }
            finally { recorded.fill(0); bytes?.fill(0) }
        }
    }
    private fun fail(epoch: Long, message: String) {
        if (!synchronized(gate) { current(epoch) }) return
        cancel()
        synchronized(gate) { if (active && available) mutable.value = RecordingState(message = message) }
    }
    fun cancel() {
        val source = synchronized(gate) {
            generation++; deadline?.cancel(); deadline = null; work?.cancel(); work = null
            val previous = input; input = null; samples?.fill(0); samples = null; frames = 0
            mutable.value = RecordingState(); previous
        }
        runCatching { source?.close() }; cleared()
    }
    fun close() { synchronized(gate) { active = false; available = false }; cancel() }
}
