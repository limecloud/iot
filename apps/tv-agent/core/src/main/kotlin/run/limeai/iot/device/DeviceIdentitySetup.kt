package run.limeai.iot.device

import kotlinx.serialization.json.*
import okio.ByteString.Companion.decodeBase64
import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/** 调用方只读取已有密钥；恢复或TLS连接不能隐式创建另一身份。 */
fun interface DeviceKeyResolver { fun load(reference: String): DeviceSigningKey }

object DeviceKeyReference {
    fun valid(value: String): Boolean = Regex("limeiot-tv-identity-[0-9a-f]{32}").matches(value)
}

/** 所有者明确核对的公开配置；既不含设备私钥，也不授权改变已有设备绑定。 */
class DeviceIdentitySetup private constructor(
    val identity: DeviceIdentity,
    val requestId: String,
    val broker: String,
    val caPem: String,
    val caFingerprint: String,
    private val document: JsonObject,
) {
    val binding: String get() = "${identity.space}/${identity.device}/$caFingerprint"
    fun encoded(): ByteArray = DeviceDocument.canonical(document).toByteArray(Charsets.UTF_8)

    /** 公开证书只匹配已冻结的本机请求；不从证书或回执取得Broker、模型或信任。 */
    internal fun validateCertificate(bytes: ByteArray, maintenance: Boolean = false) {
        val ca = certificate(caPem.toByteArray(Charsets.US_ASCII)); val leaf = certificate(bytes)
        ca.checkValidity()
        if (maintenance) checkDevice(leaf.notBefore.time <= System.currentTimeMillis() && leaf.notAfter.after(leaf.notBefore), "invalid_credentials")
        else leaf.checkValidity()
        checkDevice(leaf.basicConstraints == -1 && leaf.getExtensionValue("2.5.29.19") != null, "invalid_credentials")
        checkDevice(leaf.keyUsage?.let { it[0] && it.drop(1).none { bit -> bit } } == true, "invalid_credentials")
        checkDevice(leaf.extendedKeyUsage == listOf("1.3.6.1.5.5.7.3.2") && !leaf.hasUnsupportedCriticalExtension(), "invalid_credentials")
        checkDevice(leaf.sigAlgOID == "1.2.840.10045.4.3.2" && leaf.issuerX500Principal == ca.subjectX500Principal, "invalid_credentials")
        leaf.verify(ca.publicKey)
    }

    companion object {
        fun parse(bytes: ByteArray): DeviceIdentitySetup {
            try {
                val value = DeviceDocument.parse(bytes, 16384)
                value.fields("schema_version", "request_id", "space_id", "device_id", "broker", "model_profile", "ca_pem")
                checkDevice(value.integer("schema_version") == 1L && identifier.matches(value.text("request_id")), "invalid_identity_setup")
                val identity = DeviceIdentity(value.text("space_id"), value.text("device_id"), DeviceModelProfile.parse(value.text("model_profile")))
                val broker = value.text("broker"); DeviceBroker.parse(broker)
                val ca = certificate(value.text("ca_pem").toByteArray(Charsets.US_ASCII))
                ca.checkValidity()
                checkDevice(ca.basicConstraints >= 0 && ca.keyUsage?.get(5) == true && !ca.hasUnsupportedCriticalExtension(), "invalid_identity_setup")
                return DeviceIdentitySetup(identity, value.text("request_id"), broker, value.text("ca_pem"), DeviceSigningKey.fingerprint(ca.encoded), value)
            } catch (_: Exception) { throw DeviceFault("invalid_identity_setup") }
        }

        internal fun certificate(bytes: ByteArray): X509Certificate {
            checkDevice(bytes.size in 1..4096 && bytes.all { it.toInt() in 0..127 }, "invalid_credentials")
            val match = Regex("\\s*-----BEGIN CERTIFICATE-----\\s+([A-Za-z0-9+/=\\s]+)-----END CERTIFICATE-----\\s*")
                .matchEntire(bytes.toString(Charsets.US_ASCII)) ?: throw DeviceFault("invalid_credentials")
            val der = match.groupValues[1].replace(Regex("\\s"), "").decodeBase64()?.toByteArray() ?: throw DeviceFault("invalid_credentials")
            val certificate = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate
            checkDevice(MessageDigest.isEqual(der, certificate.encoded), "invalid_credentials")
            return certificate
        }
    }
}
