package run.limeai.iot.device

/** 系统实际采样；百分比只是原始音量刻度的投影，静音不从音量推断。 */
data class AudioState(val minimum: Int, val maximum: Int, val index: Int, val muted: Boolean) {
    init { checkDevice(minimum >= 0 && maximum > minimum && index in minimum..maximum, "invalid_audio_state") }
    private val span: Long get() = maximum.toLong() - minimum
    val percent: Int get() = (((index.toLong() - minimum) * 100 + span / 2) / span).toInt()

    /** 取最近系统刻度，中点向上；写入结果仍须从系统另行读取。 */
    fun indexFor(percent: Int): Int {
        checkDevice(percent in 0..100, "invalid_audio_volume")
        return (minimum + (span * percent + 50) / 100).toInt()
    }
}

/** 单设备音频能力；执行端须在每次实际调用前重新核对当前授权与运行许可。 */
interface AudioPort {
    fun permitted(): Boolean
    fun read(): AudioState
    /** 返回仅表示调节调用已提交；不能据此生成已生效的百分比状态。 */
    fun setVolume(percent: Int)
    fun setMuted(muted: Boolean)
}
