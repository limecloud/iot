package run.limeai.iot.device

import okio.ByteString.Companion.decodeBase64
import java.io.ByteArrayInputStream
import java.security.KeyFactory
import java.security.KeyStore
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.security.auth.x500.X500Principal

/** 只接受设备独立 CA 与匹配的设备密钥；不使用系统全部 CA，也不提供忽略校验选项。 */
class DeviceTls private constructor(val socketFactory: SSLSocketFactory) {
    companion object {
        fun create(identity: DeviceIdentity, caPem: ByteArray, certificatePem: ByteArray, privateKeyPem: ByteArray): DeviceTls {
            try {
                checkDevice(listOf(caPem, certificatePem, privateKeyPem).all { it.size in 1..16384 }, "invalid_credentials")
                val factory = CertificateFactory.getInstance("X.509")
                fun certificate(bytes: ByteArray): X509Certificate {
                    val certificates = factory.generateCertificates(ByteArrayInputStream(bytes))
                    checkDevice(certificates.size == 1, "invalid_credentials")
                    return certificates.single() as X509Certificate
                }
                val ca = certificate(caPem); val leaf = certificate(certificatePem)
                ca.checkValidity(); leaf.checkValidity()
                checkDevice(ca.basicConstraints >= 0 && (ca.keyUsage == null || ca.keyUsage[5]), "invalid_credentials")
                checkDevice(leaf.basicConstraints == -1 && leaf.extendedKeyUsage?.contains("1.3.6.1.5.5.7.3.2") == true, "invalid_credentials")
                checkDevice(leaf.subjectX500Principal.getName(X500Principal.RFC2253) == "CN=${identity.device}", "invalid_credentials")
                checkDevice(leaf.publicKey.algorithm == "EC" && leaf.keyUsage?.get(0) != false, "invalid_credentials")
                leaf.verify(ca.publicKey)
                val pem = privateKeyPem.toString(Charsets.US_ASCII)
                val match = Regex("\\s*-----BEGIN PRIVATE KEY-----\\s+([A-Za-z0-9+/=\\s]+)-----END PRIVATE KEY-----\\s*").matchEntire(pem)
                    ?: throw DeviceFault("invalid_credentials")
                val der = match.groupValues[1].replace(Regex("\\s"), "").decodeBase64()?.toByteArray()
                    ?: throw DeviceFault("invalid_credentials")
                val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(der))
                val nonce = ByteArray(32).also { SecureRandom().nextBytes(it) }
                val signer = Signature.getInstance("SHA256withECDSA").apply { initSign(key); update(nonce) }
                val proof = signer.sign()
                checkDevice(Signature.getInstance("SHA256withECDSA").run { initVerify(leaf.publicKey); update(nonce); verify(proof) }, "invalid_credentials")
                val keys = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null) }
                val password = CharArray(32) { ('a'.code + SecureRandom().nextInt(26)).toChar() }
                keys.setKeyEntry("device", key, password, arrayOf(leaf, ca))
                val keyManager = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(keys, password) }
                password.fill('\u0000'); der.fill(0)
                val trust = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null); setCertificateEntry("device-ca", ca) }
                val trustManager = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(trust) }
                return DeviceTls(SSLContext.getInstance("TLSv1.2").apply { init(keyManager.keyManagers, trustManager.trustManagers, SecureRandom()) }.socketFactory)
            } catch (_: Exception) { throw DeviceFault("invalid_credentials") }
        }
    }
}
