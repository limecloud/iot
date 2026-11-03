package run.limeai.iot.device

/** 身份核对所需的资料；不包含TLS工厂、私钥导出或设备控制能力。 */
interface DeviceIdentityMetadata {
    val identity: DeviceIdentity
    val broker: String
    val caFingerprint: String
    val certificateFingerprint: String
    val certificateExpiresAt: Long
    val certificateNotBefore: Long
    val certificateSerial: String
    val publicKeyFingerprint: String
    val keyReference: String?
    val identityRequestId: String?
    val binding: String
    fun setupForRequest(requestId: String): DeviceIdentitySetup
    fun publicCertificate(): ByteArray
}

/** 只由已保存材料核对得出。过期叶证书可维护，但不能取得连接凭据。 */
class DeviceMaintenanceIdentity internal constructor(private val enrollment: DeviceEnrollment) : DeviceIdentityMetadata by enrollment {
    val expired: Boolean get() = System.currentTimeMillis() >= certificateExpiresAt
}
