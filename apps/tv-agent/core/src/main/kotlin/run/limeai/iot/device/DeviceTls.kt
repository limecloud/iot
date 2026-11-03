package run.limeai.iot.device

import okio.ByteString.Companion.decodeBase64
import java.io.ByteArrayInputStream
import java.net.InetAddress
import java.net.Socket
import java.security.KeyFactory
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.security.auth.x500.X500Principal

/** 只接受设备独立 CA 与匹配的设备密钥；不使用系统全部 CA，也不提供忽略校验选项。 */
class DeviceTls private constructor(factory: SSLSocketFactory, ca: X509Certificate, leaf: X509Certificate) {
    private val validFrom = maxOf(ca.notBefore.time, leaf.notBefore.time)
    private val validUntil = minOf(ca.notAfter.time, leaf.notAfter.time)
    val current: Boolean get() {
        val now = System.currentTimeMillis()
        return now >= validFrom && now < validUntil
    }
    fun requireCurrent() = checkDevice(current, "invalid_credentials")

    // 已创建的TLS对象也不能在证书到期后重新建立连接。
    val socketFactory: SSLSocketFactory = object : SSLSocketFactory() {
        override fun getDefaultCipherSuites(): Array<String> = factory.defaultCipherSuites
        override fun getSupportedCipherSuites(): Array<String> = factory.supportedCipherSuites
        override fun createSocket(): Socket = checked { factory.createSocket() }
        override fun createSocket(host: String, port: Int): Socket = checked { factory.createSocket(host, port) }
        override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int): Socket = checked { factory.createSocket(host, port, local, localPort) }
        override fun createSocket(host: InetAddress, port: Int): Socket = checked { factory.createSocket(host, port) }
        override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int): Socket = checked { factory.createSocket(host, port, local, localPort) }
        override fun createSocket(socket: Socket, host: String, port: Int, close: Boolean): Socket = checked { factory.createSocket(socket, host, port, close) }
        private fun checked(create: () -> Socket): Socket {
            requireCurrent()
            val socket = create()
            try { requireCurrent(); return socket }
            catch (failure: Exception) { try { socket.close() } catch (_: Exception) {}; throw failure }
        }
    }
    companion object {
        fun create(identity: DeviceIdentity, caPem: ByteArray, certificatePem: ByteArray, privateKeyPem: ByteArray): DeviceTls {
            try {
                checkDevice(privateKeyPem.size in 1..16384, "invalid_credentials")
                return create(identity, caPem, certificatePem, signingKey(privateKeyPem, certificate(certificatePem)))
            } catch (_: Exception) { throw DeviceFault("invalid_credentials") }
        }

        internal fun signingKey(privateKeyPem: ByteArray, leaf: X509Certificate): DeviceSigningKey {
            checkDevice(privateKeyPem.size in 1..16384, "invalid_credentials")
            val pem = privateKeyPem.toString(Charsets.US_ASCII)
            val match = Regex("\\s*-----BEGIN PRIVATE KEY-----\\s+([A-Za-z0-9+/=\\s]+)-----END PRIVATE KEY-----\\s*").matchEntire(pem)
                ?: throw DeviceFault("invalid_credentials")
            val der = match.groupValues[1].replace(Regex("\\s"), "").decodeBase64()?.toByteArray()
                ?: throw DeviceFault("invalid_credentials")
            try {
                val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(der))
                return DeviceSigningKey.from(key, leaf.publicKey)
            } finally { der.fill(0) }
        }

        /** 直接使用系统持钥句柄；不调用privateKey.encoded，不导入临时KeyStore。 */
        fun create(identity: DeviceIdentity, caPem: ByteArray, certificatePem: ByteArray, key: DeviceSigningKey): DeviceTls {
            try {
                val (ca, leaf) = validate(identity, caPem, certificatePem, key)
                val trust = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null); setCertificateEntry("device-ca", ca) }
                val trustManager = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(trust) }
                return DeviceTls(SSLContext.getInstance("TLSv1.2").apply { init(arrayOf(key.clientKeyManager(leaf, ca)), trustManager.trustManagers, SecureRandom()) }.socketFactory, ca, leaf)
            } catch (_: Exception) { throw DeviceFault("invalid_credentials") }
        }

        /** 维护核对不创建连接工厂；仅允许叶证书已过期，CA和其余检查仍须通过。 */
        internal fun validate(identity: DeviceIdentity, caPem: ByteArray, certificatePem: ByteArray, key: DeviceSigningKey, maintenance: Boolean = false): Pair<X509Certificate, X509Certificate> {
            val ca = certificate(caPem); val leaf = certificate(certificatePem)
            ca.checkValidity()
            if (maintenance) checkDevice(leaf.notBefore.time <= System.currentTimeMillis() && leaf.notAfter.after(leaf.notBefore), "invalid_credentials")
            else leaf.checkValidity()
            checkDevice(ca.basicConstraints >= 0 && (ca.keyUsage == null || ca.keyUsage[5]), "invalid_credentials")
            checkDevice(leaf.basicConstraints == -1 && leaf.extendedKeyUsage?.contains("1.3.6.1.5.5.7.3.2") == true, "invalid_credentials")
            checkDevice(leaf.subjectX500Principal.getName(X500Principal.RFC2253) == "CN=${identity.device}", "invalid_credentials")
            checkDevice(leaf.publicKey.algorithm == "EC" && leaf.keyUsage?.get(0) != false, "invalid_credentials")
            checkDevice(leaf.issuerX500Principal == ca.subjectX500Principal, "invalid_credentials")
            leaf.verify(ca.publicKey)
            checkDevice(MessageDigest.isEqual(leaf.publicKey.encoded, key.publicKey.encoded), "invalid_credentials")
            return ca to leaf
        }

        private fun certificate(bytes: ByteArray): X509Certificate {
            checkDevice(bytes.size in 1..16384, "invalid_credentials")
            val certificates = CertificateFactory.getInstance("X.509").generateCertificates(ByteArrayInputStream(bytes))
            checkDevice(certificates.size == 1, "invalid_credentials")
            return certificates.single() as X509Certificate
        }
    }
}
