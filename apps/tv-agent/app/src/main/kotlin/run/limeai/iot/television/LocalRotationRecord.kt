package run.limeai.iot.television

import kotlinx.serialization.json.*
import run.limeai.iot.device.*

data class RotationRequestView(val candidate: IdentityRequestView, val previousSerial: String, val previousCertificate: String, val managementCompleted: Boolean, val expiredRecovery: Boolean = false, val recoveryOrigin: String? = null)
data class RotationCandidate(val enrollment: DeviceEnrollment, val receipt: DeviceRotationReceipt)

/** 每个原请求独立保留；下一轮暂存不会覆盖上一轮的激活证明。 */
internal data class LocalRotationRecord(
    val candidate: LocalIdentityRecord,
    val previousSerial: String,
    val previousCertificate: String,
    val previousPublicKey: String,
    val receipt: DeviceRotationReceipt? = null,
    val proof: String? = null,
    val version: Int = 2,
    val previousReference: String? = null,
    val previousCertificatePem: String? = null,
    val retirement: KeyRetirementRecord? = null,
    val recoveryOrigin: String? = null,
) {
    val expiredRecovery: Boolean get() = version == 3
    val preservesRotation: Boolean get() = recoveryOrigin == "pending_rotation"
    fun encoded(): ByteArray = DeviceDocument.canonical(buildJsonObject {
        put("schema_version", version); put("candidate", DeviceDocument.parse(candidate.encoded()))
        put("previous_serial", previousSerial); put("previous_certificate", previousCertificate); put("previous_public_key", previousPublicKey)
        put("receipt", receipt?.let { DeviceDocument.parse(it.encoded()) } ?: JsonNull); put("proof", proof?.let(::JsonPrimitive) ?: JsonNull)
        if (version >= 2) {
            put("previous_key_reference", previousReference?.let(::JsonPrimitive) ?: JsonNull)
            put("previous_certificate_pem", previousCertificatePem?.let(::JsonPrimitive) ?: JsonNull)
            put("retirement", retirement?.document() ?: JsonNull)
        }
        if (expiredRecovery) { put("recovery_reason", "certificate_expired"); put("recovery_origin", recoveryOrigin!!) }
    }).toByteArray(Charsets.UTF_8)

    fun verify(current: DeviceIdentityMetadata, keys: IdentityKeys) {
        if (current.binding != candidate.setup.binding || current.broker != candidate.setup.broker || current.identity.profile != candidate.setup.identity.profile)
            throw AgentStoreFault("identity_mismatch")
        if (candidate.publicKeyFingerprint == previousPublicKey) throw AgentStoreFault("rotation_new_key_required")
        if (candidate.phase == "active") {
            candidate.verify(current, keys)
            receipt!!.verify(candidate.setup, candidate.view(keys).request!!, previousSerial, previousCertificate, current, expiredRecovery, preservesRotation)
            if (proof != null && !keys.load(candidate.reference).verifyRotationActivationProof(candidate.setup.identity, candidate.setup.requestId, candidate.certificateFingerprint!!, receipt.challenge, proof)) throw AgentStoreFault("identity_mismatch")
        } else {
            if (current.certificateSerial.toBigInteger(16) != previousSerial.toBigInteger(16) || current.certificateFingerprint != previousCertificate || current.publicKeyFingerprint != previousPublicKey)
                throw AgentStoreFault("rotation_predecessor_changed")
            val request = candidate.view(keys).request
            if (request != null && request.publicKeyFingerprint == previousPublicKey) throw AgentStoreFault("rotation_new_key_required")
        }
    }

    fun view(keys: IdentityKeys) = RotationRequestView(candidate.view(keys), previousSerial, previousCertificate, receipt?.managementCompleted == true, expiredRecovery, recoveryOrigin)
    fun retirementView() = KeyRetirementView(candidate.setup.requestId, previousCertificate, previousPublicKey,
        if (version == 1) "untracked" else if (previousReference == null) "not_applicable" else if (candidate.phase != "active" || receipt?.managementCompleted != true || proof == null) "waiting" else retirement?.phase ?: "retained",
        retirement?.proof?.fingerprint)

    companion object {
        fun parse(bytes: ByteArray): LocalRotationRecord {
            try {
                val value = DeviceDocument.parse(bytes, 32768)
                val version = when (value["schema_version"]) { JsonPrimitive(1) -> 1; JsonPrimitive(2) -> 2; JsonPrimitive(3) -> 3; else -> throw AgentStoreFault("storage_corrupt") }
                val fields = setOf("schema_version", "candidate", "previous_serial", "previous_certificate", "previous_public_key", "receipt", "proof") +
                    (if (version >= 2) setOf("previous_key_reference", "previous_certificate_pem", "retirement") else emptySet()) + (if (version == 3) setOf("recovery_reason", "recovery_origin") else emptySet())
                if (value.keys != fields) throw AgentStoreFault("storage_corrupt")
                if (version == 3 && value["recovery_reason"] != JsonPrimitive("certificate_expired")) throw AgentStoreFault("storage_corrupt")
                fun string(name: String) = (value[name] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw AgentStoreFault("storage_corrupt")
                fun optional(name: String): String? = if (value[name] == null || value[name] === JsonNull) null else string(name)
                val candidate = LocalIdentityRecord.parse(DeviceDocument.canonical(value["candidate"]!!).toByteArray(Charsets.UTF_8))
                val receipt = if (value["receipt"] === JsonNull) null else DeviceRotationReceipt.parse(DeviceDocument.canonical(value["receipt"]!!).toByteArray(Charsets.UTF_8))
                val proof = if (value["proof"] === JsonNull) null else string("proof")
                val retirement = if (version == 1 || value["retirement"] === JsonNull) null else KeyRetirementRecord.parse(value["retirement"]!!)
                val result = LocalRotationRecord(candidate, string("previous_serial"), string("previous_certificate"), string("previous_public_key"), receipt, proof,
                    version, optional("previous_key_reference"), optional("previous_certificate_pem"), retirement, optional("recovery_origin"))
                if (version == 3 && result.recoveryOrigin !in setOf("expired_identity", "pending_rotation")) throw AgentStoreFault("storage_corrupt")
                if (!Regex("[0-9A-F]{1,40}").matches(result.previousSerial) || result.previousSerial.toBigInteger(16).signum() <= 0 ||
                    !Regex("sha256:[0-9a-f]{64}").matches(result.previousCertificate) || !Regex("sha256:[0-9a-f]{64}").matches(result.previousPublicKey) ||
                    (candidate.phase == "active") != (receipt != null) || proof != null && !Regex("[0-9a-f]{16,144}").matches(proof) ||
                    candidate.phase != "active" && proof != null) throw AgentStoreFault("storage_corrupt")
                if (receipt != null && receipt.expiredRecovery != result.expiredRecovery && !(result.expiredRecovery && result.preservesRotation && !receipt.expiredRecovery)) throw AgentStoreFault("storage_corrupt")
                if (version >= 2 && (result.previousCertificatePem == null || result.previousCertificatePem.length !in 1..4096 ||
                    result.previousReference?.let { !DeviceKeyReference.valid(it) || it == candidate.reference } == true ||
                    retirement != null && (result.previousReference == null || candidate.phase != "active" || receipt?.managementCompleted != true || proof == null))) throw AgentStoreFault("storage_corrupt")
                return result
            } catch (error: AgentStoreFault) { throw error }
            catch (_: Exception) { throw AgentStoreFault("storage_corrupt") }
        }
    }
}
