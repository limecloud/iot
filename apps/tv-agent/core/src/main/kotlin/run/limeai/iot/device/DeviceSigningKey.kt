package run.limeai.iot.device

import okio.ByteString.Companion.toByteString
import okio.ByteString.Companion.decodeBase64
import org.bouncycastle.asn1.ASN1Encoding
import org.bouncycastle.asn1.sec.SECObjectIdentifiers
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo
import org.bouncycastle.asn1.x9.X9ObjectIdentifiers
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
import org.bouncycastle.pkcs.jcajce.JcaPKCS10CertificationRequestBuilder
import org.bouncycastle.pkcs.PKCS10CertificationRequest
import org.bouncycastle.operator.jcajce.JcaContentVerifierProviderBuilder
import java.net.Socket
import java.security.MessageDigest
import java.security.Principal
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.X509Certificate
import javax.net.ssl.X509KeyManager
import javax.security.auth.x500.X500Principal

/** 私钥可以是不可导出的系统句柄；业务层不读取编码，也不复制到另一密钥库。 */
class DeviceSigningKey private constructor(private val key: PrivateKey, val publicKey: PublicKey) {
    val publicKeyFingerprint: String get() = fingerprint(publicKey.encoded)

    /** CSR只公开公钥；调用者须保存原CSR再交付，恢复时不能重新调用生成另一份请求。 */
    fun certificateRequest(identity: DeviceIdentity): DeviceCertificateRequest {
        try {
            val info = SubjectPublicKeyInfo.getInstance(publicKey.encoded)
            checkDevice(info.algorithm.algorithm == X9ObjectIdentifiers.id_ecPublicKey &&
                info.algorithm.parameters == SECObjectIdentifiers.secp256r1, "invalid_identity_key")
            val signer = JcaContentSignerBuilder("SHA256withECDSA").build(key)
            val request = JcaPKCS10CertificationRequestBuilder(X500Principal("CN=${identity.device}"), publicKey).build(signer)
            val der = request.encoded
            val base64 = der.toByteString().base64().chunked(64).joinToString("\n")
            return DeviceCertificateRequest("-----BEGIN CERTIFICATE REQUEST-----\n$base64\n-----END CERTIFICATE REQUEST-----\n",
                fingerprint(der), publicKeyFingerprint)
        } catch (_: Exception) { throw DeviceFault("invalid_identity_key") }
    }

    /** 只验证并返回耐久保存的原CSR，不生成新签名，也不读取私钥编码。 */
    fun restoreCertificateRequest(identity: DeviceIdentity, pem: String): DeviceCertificateRequest {
        try {
            checkDevice(pem.length in 1..4096 && pem.all { it.code in 0..127 }, "invalid_identity_request")
            val match = Regex("\\s*-----BEGIN CERTIFICATE REQUEST-----\\s+([A-Za-z0-9+/=\\s]+)-----END CERTIFICATE REQUEST-----\\s*")
                .matchEntire(pem) ?: throw DeviceFault("invalid_identity_request")
            val der = match.groupValues[1].replace(Regex("\\s"), "").decodeBase64()?.toByteArray() ?: throw DeviceFault("invalid_identity_request")
            val request = PKCS10CertificationRequest(der)
            checkDevice(MessageDigest.isEqual(der, request.toASN1Structure().getEncoded(ASN1Encoding.DER)), "invalid_identity_request")
            checkDevice(request.subject == org.bouncycastle.asn1.x500.X500Name.getInstance(X500Principal("CN=${identity.device}").encoded) &&
                request.attributes.isEmpty(), "invalid_identity_request")
            val info = request.subjectPublicKeyInfo
            checkDevice(info.algorithm.algorithm == X9ObjectIdentifiers.id_ecPublicKey && info.algorithm.parameters == SECObjectIdentifiers.secp256r1 &&
                MessageDigest.isEqual(info.encoded, publicKey.encoded), "invalid_identity_request")
            checkDevice(request.signatureAlgorithm.algorithm == X9ObjectIdentifiers.ecdsa_with_SHA256 && request.signatureAlgorithm.parameters == null &&
                request.isSignatureValid(JcaContentVerifierProviderBuilder().build(publicKey)), "invalid_identity_request")
            return DeviceCertificateRequest(pem, fingerprint(der), publicKeyFingerprint)
        } catch (_: Exception) { throw DeviceFault("invalid_identity_request") }
    }

    /** 只签署轮换合同限定的激活消息，不提供任意消息签名入口。 */
    fun rotationActivationProof(identity: DeviceIdentity, requestId: String, certificateFingerprint: String, challenge: String): String {
        val message = activationMessage(identity, requestId, certificateFingerprint, challenge)
        return Signature.getInstance("SHA256withECDSA").run { initSign(key); update(message); sign() }
            .joinToString("") { "%02x".format(it.toInt() and 255) }
    }

    fun verifyRotationActivationProof(identity: DeviceIdentity, requestId: String, certificateFingerprint: String, challenge: String, proof: String): Boolean {
        if (!Regex("(?:[0-9a-f]{2}){8,72}").matches(proof)) return false
        return try {
            val bytes = proof.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
            Signature.getInstance("SHA256withECDSA").run { initVerify(publicKey); update(activationMessage(identity, requestId, certificateFingerprint, challenge)); verify(bytes) }
        } catch (_: Exception) { false }
    }

    private fun activationMessage(identity: DeviceIdentity, requestId: String, certificateFingerprint: String, challenge: String): ByteArray {
        checkDevice(identifier.matches(requestId) && Regex("sha256:[0-9a-f]{64}").matches(certificateFingerprint) && Regex("[0-9a-f]{64}").matches(challenge), "invalid_rotation_receipt")
        return listOf("limeiot.device-rotation-activate/v1", identity.space, identity.device, requestId, certificateFingerprint, challenge).joinToString("\n").toByteArray(Charsets.US_ASCII)
    }

    // MQTT只使用SSLSocket；X509KeyManager兼容API23，不依赖API24的扩展KeyManager。
    internal fun clientKeyManager(leaf: X509Certificate, ca: X509Certificate): X509KeyManager = object : X509KeyManager {
        private fun eligible(type: String?, issuers: Array<out Principal>?): Boolean = type == "EC" &&
            (issuers.isNullOrEmpty() || issuers.any { it == ca.subjectX500Principal || it == leaf.issuerX500Principal })
        override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? =
            if (eligible(keyType, issuers)) arrayOf("device") else null
        override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?): String? =
            if (keyType?.any { eligible(it, issuers) } == true) "device" else null
        override fun getPrivateKey(alias: String?): PrivateKey? = if (alias == "device") key else null
        override fun getCertificateChain(alias: String?): Array<X509Certificate>? = if (alias == "device") arrayOf(leaf, ca) else null
        override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? = null
        override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?): String? = null
    }

    companion object {
        /** 使用随机挑战校验句柄与公开键匹配；不假设密钥可序列化或具备硬件保护。 */
        fun from(privateKey: PrivateKey, publicKey: PublicKey): DeviceSigningKey {
            try {
                checkDevice(privateKey.algorithm == "EC" && publicKey.algorithm == "EC", "invalid_identity_key")
                val nonce = ByteArray(32).also { SecureRandom().nextBytes(it) }
                val proof = Signature.getInstance("SHA256withECDSA").run { initSign(privateKey); update(nonce); sign() }
                checkDevice(Signature.getInstance("SHA256withECDSA").run { initVerify(publicKey); update(nonce); verify(proof) }, "invalid_identity_key")
                return DeviceSigningKey(privateKey, publicKey)
            } catch (_: Exception) { throw DeviceFault("invalid_identity_key") }
        }
        internal fun fingerprint(bytes: ByteArray): String = "sha256:" + MessageDigest.getInstance("SHA-256")
            .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}

class DeviceCertificateRequest internal constructor(val pem: String, val csrSha256: String, val publicKeyFingerprint: String)
