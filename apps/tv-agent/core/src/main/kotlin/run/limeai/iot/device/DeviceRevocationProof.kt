package run.limeai.iot.device

import okio.ByteString.Companion.decodeBase64
import org.bouncycastle.asn1.ASN1Enumerated
import org.bouncycastle.asn1.ASN1OctetString
import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509CRL
import java.util.Date
import javax.security.auth.x500.X500Principal

/** 单份公开CRL；清理旧键依赖CA签名和原证书，不把管理JSON视为撤销证明。 */
class DeviceRevocationProof private constructor(private val pem: String, private val crl: X509CRL) {
    val fingerprint: String get() = DeviceSigningKey.fingerprint(crl.encoded)
    val thisUpdate: Long get() = crl.thisUpdate.time
    val nextUpdate: Long get() = crl.nextUpdate?.time ?: throw DeviceFault("invalid_revocation_proof")
    fun encoded(): ByteArray = pem.toByteArray(Charsets.US_ASCII)

    fun verify(setup: DeviceIdentitySetup, previousCertificate: String, previousSerial: String, previousFingerprint: String, previousPublicKey: String, current: DeviceEnrollment, atMillis: Long) {
        try {
            val ca = DeviceIdentitySetup.certificate(setup.caPem.toByteArray(Charsets.US_ASCII))
            ca.checkValidity(Date(atMillis))
            checkDevice(ca.keyUsage?.getOrNull(6) == true)
            val old = DeviceIdentitySetup.certificate(previousCertificate.toByteArray(Charsets.US_ASCII))
            old.verify(ca.publicKey)
            checkDevice(old.issuerX500Principal == ca.subjectX500Principal && old.subjectX500Principal == X500Principal("CN=${setup.identity.device}") &&
                old.serialNumber == previousSerial.toBigInteger(16) && DeviceSigningKey.fingerprint(old.encoded) == previousFingerprint &&
                DeviceSigningKey.fingerprint(old.publicKey.encoded) == previousPublicKey && current.binding == setup.binding && current.publicKeyFingerprint != previousPublicKey)
            checkDevice(crl.issuerX500Principal == ca.subjectX500Principal && crl.sigAlgOID == "1.2.840.10045.4.3.2" &&
                !crl.hasUnsupportedCriticalExtension() && crl.getExtensionValue("2.5.29.27") == null && crl.getExtensionValue("2.5.29.28") == null)
            crl.verify(ca.publicKey)
            checkDevice(thisUpdate <= atMillis && atMillis < nextUpdate && thisUpdate < nextUpdate)
            val entry = crl.getRevokedCertificate(old.serialNumber) ?: throw DeviceFault("invalid_revocation_proof")
            checkDevice(entry.revocationDate.time <= atMillis && !entry.hasUnsupportedCriticalExtension() && entry.getExtensionValue("2.5.29.29") == null &&
                crl.getRevokedCertificate(current.certificateSerial.toBigInteger(16)) == null)
            entry.getExtensionValue("2.5.29.21")?.let {
                val reason = ASN1Enumerated.getInstance(ASN1OctetString.getInstance(it).octets).value.toInt()
                checkDevice(reason in setOf(0, 1, 2, 3, 4, 5, 6, 9, 10))
            }
        } catch (_: Exception) { throw DeviceFault("invalid_revocation_proof") }
    }

    companion object {
        fun parse(bytes: ByteArray): DeviceRevocationProof {
            try {
                checkDevice(bytes.size in 1..16384 && bytes.all { it.toInt() in 0..127 })
                val pem = bytes.toString(Charsets.US_ASCII)
                val match = Regex("\\s*-----BEGIN X509 CRL-----\\s+([A-Za-z0-9+/=\\s]+)-----END X509 CRL-----\\s*").matchEntire(pem) ?: throw DeviceFault("invalid_revocation_proof")
                val der = match.groupValues[1].replace(Regex("\\s"), "").decodeBase64()?.toByteArray() ?: throw DeviceFault("invalid_revocation_proof")
                val crl = CertificateFactory.getInstance("X.509").generateCRL(ByteArrayInputStream(der)) as X509CRL
                checkDevice(MessageDigest.isEqual(der, crl.encoded))
                return DeviceRevocationProof(pem, crl)
            } catch (_: Exception) { throw DeviceFault("invalid_revocation_proof") }
        }
    }
}
