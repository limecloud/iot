package run.limeai.iot.device

import kotlinx.serialization.json.*
import java.io.ByteArrayInputStream
import java.net.URI
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/** 本机明确确认的设备材料，不包含空间所有者会话，也不自动认领或关联已有ADB设备。 */
class DeviceEnrollment private constructor(
    override val identity: DeviceIdentity,
    override val broker: String,
    override val caFingerprint: String,
    override val certificateFingerprint: String,
    override val certificateExpiresAt: Long,
    private val document: JsonObject,
    private val keys: DeviceKeyResolver?,
) : DeviceIdentityMetadata {
    override val binding: String get() = "${identity.space}/${identity.device}/$caFingerprint"
    override val keyReference: String? get() = document["key_reference"]?.jsonPrimitive?.content
    override val identityRequestId: String? get() = document["request_id"]?.jsonPrimitive?.content
    override val certificateSerial: String get() = certificate().serialNumber.toString(16).uppercase(java.util.Locale.ROOT).let { if (it.length % 2 == 0) it else "0$it" }
    override val publicKeyFingerprint: String get() = DeviceSigningKey.fingerprint(certificate().publicKey.encoded)
    override val certificateNotBefore: Long get() = certificate().notBefore.time
    private fun certificate() = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(pem("certificate_pem"))) as X509Certificate
    override fun setupForRequest(requestId: String): DeviceIdentitySetup = DeviceIdentitySetup.parse(DeviceDocument.canonical(obj(
        "schema_version" to JsonPrimitive(1), "request_id" to text(requestId), "space_id" to text(identity.space), "device_id" to text(identity.device),
        "broker" to text(broker), "model_profile" to text(identity.profile.id), "ca_pem" to document.getValue("ca_pem"),
    )).toByteArray(Charsets.UTF_8))
    fun encoded(): ByteArray = DeviceDocument.canonical(document).toByteArray(Charsets.UTF_8)
    override fun publicCertificate(): ByteArray = pem("certificate_pem")
    fun tls(): DeviceTls {
        val reference = keyReference
        if (reference == null) return DeviceTls.create(identity, pem("ca_pem"), pem("certificate_pem"), pem("private_key_pem"))
        val key = keys?.load(reference) ?: throw DeviceFault("identity_key_unavailable")
        checkDevice(key.publicKeyFingerprint == document.text("public_key_fingerprint"), "invalid_enrollment")
        return DeviceTls.create(identity, pem("ca_pem"), pem("certificate_pem"), key)
    }
    private fun pem(field: String): ByteArray = document.text(field).toByteArray(Charsets.US_ASCII)

    companion object {
        fun parse(bytes: ByteArray, keys: DeviceKeyResolver? = null): DeviceEnrollment {
            return parseDocument(bytes, keys, false)
        }

        fun maintenance(bytes: ByteArray, keys: DeviceKeyResolver? = null): DeviceMaintenanceIdentity = DeviceMaintenanceIdentity(parseDocument(bytes, keys, true))

        private fun parseDocument(bytes: ByteArray, keys: DeviceKeyResolver?, maintenance: Boolean): DeviceEnrollment {
            try {
                val value = DeviceDocument.parse(bytes, 32768)
                val version = value.integer("schema_version")
                checkDevice(version in 1L..3L, "invalid_enrollment")
                if (version == 1L) value.fields("schema_version", "space_id", "device_id", "broker", "ca_pem", "certificate_pem", "private_key_pem")
                else if (version == 2L) value.fields("schema_version", "space_id", "device_id", "broker", "ca_pem", "certificate_pem", "private_key_pem", "model_profile")
                else {
                    value.fields("schema_version", "space_id", "device_id", "broker", "ca_pem", "certificate_pem", "model_profile", "key_reference", "public_key_fingerprint", "request_id")
                    checkDevice(keys != null && DeviceKeyReference.valid(value.text("key_reference")) && identifier.matches(value.text("request_id")) &&
                        Regex("sha256:[0-9a-f]{64}").matches(value.text("public_key_fingerprint")), "invalid_enrollment")
                }
                val profile = if (version == 1L) DeviceModelProfile.APPLICATIONS else DeviceModelProfile.parse(value.text("model_profile"))
                val identity = DeviceIdentity(value.text("space_id"), value.text("device_id"), profile)
                val broker = value.text("broker"); DeviceBroker.parse(broker)
                if (version == 3L) {
                    val setup = DeviceIdentitySetup.parse(DeviceDocument.canonical(obj(
                        "schema_version" to JsonPrimitive(1), "request_id" to value.getValue("request_id"),
                        "space_id" to value.getValue("space_id"), "device_id" to value.getValue("device_id"),
                        "broker" to value.getValue("broker"), "model_profile" to value.getValue("model_profile"), "ca_pem" to value.getValue("ca_pem"),
                    )).toByteArray(Charsets.UTF_8))
                    setup.validateCertificate(value.text("certificate_pem").toByteArray(Charsets.US_ASCII), maintenance)
                }
                fun certificate(name: String) = CertificateFactory.getInstance("X.509")
                    .generateCertificate(ByteArrayInputStream(value.text(name).toByteArray(Charsets.US_ASCII))) as X509Certificate
                fun fingerprint(cert: X509Certificate) = "sha256:" + MessageDigest.getInstance("SHA-256")
                    .digest(cert.encoded).joinToString("") { "%02x".format(it.toInt() and 255) }
                val ca = certificate("ca_pem"); val leaf = certificate("certificate_pem")
                val result = DeviceEnrollment(identity, broker, fingerprint(ca), fingerprint(leaf), leaf.notAfter.time, value, keys)
                if (maintenance) {
                    val key = result.keyReference?.let { keys!!.load(it) } ?: DeviceTls.signingKey(result.pem("private_key_pem"), leaf)
                    if (result.keyReference != null) checkDevice(key.publicKeyFingerprint == value.text("public_key_fingerprint"), "invalid_enrollment")
                    DeviceTls.validate(identity, result.pem("ca_pem"), result.publicCertificate(), key, true)
                } else result.tls() // 普通读取与连接始终要求证书当前有效。
                return result
            } catch (_: Exception) { throw DeviceFault("invalid_enrollment") }
        }

        /** 仅由已核对的本机请求构造v3材料；文件选择器不提供密钥解析器。 */
        fun deviceLocal(setup: DeviceIdentitySetup, certificate: ByteArray, reference: String, publicKeyFingerprint: String, keys: DeviceKeyResolver): DeviceEnrollment {
            try {
                setup.validateCertificate(certificate)
                val value = obj("schema_version" to JsonPrimitive(3), "space_id" to text(setup.identity.space), "device_id" to text(setup.identity.device),
                    "broker" to text(setup.broker), "model_profile" to text(setup.identity.profile.id), "ca_pem" to text(setup.caPem),
                    "certificate_pem" to text(certificate.toString(Charsets.US_ASCII)), "key_reference" to text(reference),
                    "public_key_fingerprint" to text(publicKeyFingerprint), "request_id" to text(setup.requestId))
                return parse(DeviceDocument.canonical(value).toByteArray(Charsets.UTF_8), keys)
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
