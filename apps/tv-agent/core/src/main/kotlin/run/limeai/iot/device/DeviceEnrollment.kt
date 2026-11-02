package run.limeai.iot.device

import kotlinx.serialization.json.*
import java.io.ByteArrayInputStream
import java.net.URI
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/** 本机明确确认的设备材料，不包含空间所有者会话，也不自动认领或关联已有ADB设备。 */
class DeviceEnrollment private constructor(
    val identity: DeviceIdentity,
    val broker: String,
    val caFingerprint: String,
    val certificateFingerprint: String,
    val certificateExpiresAt: Long,
    private val document: JsonObject,
) {
    val binding: String get() = "${identity.space}/${identity.device}/$caFingerprint"
    fun encoded(): ByteArray = DeviceDocument.canonical(document).toByteArray(Charsets.UTF_8)
    fun tls(): DeviceTls = DeviceTls.create(identity, pem("ca_pem"), pem("certificate_pem"), pem("private_key_pem"))
    private fun pem(field: String): ByteArray = document.text(field).toByteArray(Charsets.US_ASCII)

    companion object {
        fun parse(bytes: ByteArray): DeviceEnrollment {
            try {
                val value = DeviceDocument.parse(bytes, 32768)
                val version = value.integer("schema_version")
                checkDevice(version in 1L..2L, "invalid_enrollment")
                if (version == 1L) value.fields("schema_version", "space_id", "device_id", "broker", "ca_pem", "certificate_pem", "private_key_pem")
                else value.fields("schema_version", "space_id", "device_id", "broker", "ca_pem", "certificate_pem", "private_key_pem", "model_profile")
                val profile = if (version == 1L) DeviceModelProfile.APPLICATIONS else DeviceModelProfile.parse(value.text("model_profile"))
                val identity = DeviceIdentity(value.text("space_id"), value.text("device_id"), profile)
                val broker = value.text("broker"); DeviceBroker.parse(broker)
                fun certificate(name: String) = CertificateFactory.getInstance("X.509")
                    .generateCertificate(ByteArrayInputStream(value.text(name).toByteArray(Charsets.US_ASCII))) as X509Certificate
                fun fingerprint(cert: X509Certificate) = "sha256:" + MessageDigest.getInstance("SHA-256")
                    .digest(cert.encoded).joinToString("") { "%02x".format(it.toInt() and 255) }
                val ca = certificate("ca_pem"); val leaf = certificate("certificate_pem")
                val result = DeviceEnrollment(identity, broker, fingerprint(ca), fingerprint(leaf), leaf.notAfter.time, value)
                result.tls() // 保存或展示前先验证用途、有效期、签发与密钥匹配。
                return result
            } catch (_: Exception) { throw DeviceFault("invalid_enrollment") }
        }
    }
}

object DeviceBroker {
    fun parse(value: String): URI {
        val uri = try { URI(value) } catch (_: Exception) { throw DeviceFault("invalid_broker") }
        checkDevice(value.length <= 512 && uri.scheme == "ssl" && uri.host != null && uri.port in 1..65535 && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && uri.rawPath.isNullOrEmpty(), "invalid_broker")
        return uri
    }
}
