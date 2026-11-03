package run.limeai.iot.television

import run.limeai.iot.device.DeviceIdentity
import run.limeai.iot.device.DeviceModelProfile

/** 私有审阅仅存于本进程；摘要绑定原库全部记录与实际持钥状态。 */
internal data class ModelAssignmentPreview(
    val identity: DeviceIdentity,
    val target: DeviceModelProfile,
    val certificate: String,
    internal val continuity: ApkContinuitySnapshot,
)

internal class ModelAssignmentReview(val preview: ModelAssignmentPreview, internal val foreground: RunPermit)
