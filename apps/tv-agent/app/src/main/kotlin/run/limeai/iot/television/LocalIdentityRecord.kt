package run.limeai.iot.television

import kotlinx.serialization.json.*
import run.limeai.iot.device.*

/** 展示和交付只包含公开请求；KeyStore引用不作为外部导入或授权入口。 */
data class IdentityRequestView(val setup: DeviceIdentitySetup, val phase: String, val request: DeviceCertificateRequest?)

/** 此记录与凭据同属私有SQLite；公钥/CSR必须在每次恢复时重新核对实际持钥。 */
internal data class LocalIdentityRecord(
    val setup: DeviceIdentitySetup,
    val reference: String,
    val phase: String,
    val csr: String? = null,
    val csrSha256: String? = null,
    val publicKeyFingerprint: String? = null,
    val certificateFingerprint: String? = null,
) {
    fun encoded(): ByteArray = DeviceDocument.canonical(buildJsonObject {
        put("schema_version", 1); put("setup", DeviceDocument.parse(setup.encoded()))
        put("key_reference", reference); put("phase", phase)
        put("csr_pem", csr?.let(::JsonPrimitive) ?: JsonNull)
        put("csr_sha256", csrSha256?.let(::JsonPrimitive) ?: JsonNull)
        put("public_key_fingerprint", publicKeyFingerprint?.let(::JsonPrimitive) ?: JsonNull)
        put("certificate_fingerprint", certificateFingerprint?.let(::JsonPrimitive) ?: JsonNull)
    }).toByteArray(Charsets.UTF_8)

    fun view(keys: IdentityKeys): IdentityRequestView {
        val request = if (phase in setOf("pending", "active")) {
            keys.load(reference).restoreCertificateRequest(setup.identity, csr!!).also {
                if (it.csrSha256 != csrSha256 || it.publicKeyFingerprint != publicKeyFingerprint) throw AgentStoreFault("identity_mismatch")
            }
        } else null
        return IdentityRequestView(setup, phase, request)
    }

    fun enrollment(certificate: ByteArray, keys: IdentityKeys): DeviceEnrollment {
        if (view(keys).request == null) throw AgentStoreFault("identity_request_not_ready")
        return DeviceEnrollment.deviceLocal(setup, certificate, reference, publicKeyFingerprint!!, keys).also {
            if (phase == "active" && it.certificateFingerprint != certificateFingerprint) throw AgentStoreFault("identity_rotation_required")
        }
    }

    fun verify(enrollment: DeviceIdentityMetadata, keys: IdentityKeys) {
        if (phase != "active" || enrollment.keyReference != reference || enrollment.identityRequestId != setup.requestId ||
            enrollment.binding != setup.binding || enrollment.broker != setup.broker || enrollment.identity.profile != setup.identity.profile ||
            enrollment.certificateFingerprint != certificateFingerprint) throw AgentStoreFault("identity_mismatch")
        view(keys)
    }

    companion object {
        fun parse(bytes: ByteArray): LocalIdentityRecord {
            try {
                val value = DeviceDocument.parse(bytes, 16384)
                if (value.keys != setOf("schema_version", "setup", "key_reference", "phase", "csr_pem", "csr_sha256", "public_key_fingerprint", "certificate_fingerprint") ||
                    value["schema_version"] != JsonPrimitive(1)) throw AgentStoreFault("storage_corrupt")
                fun string(name: String): String = (value[name] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw AgentStoreFault("storage_corrupt")
                fun optional(name: String): String? = if (value[name] === JsonNull) null else string(name)
                val setup = DeviceIdentitySetup.parse(DeviceDocument.canonical(value["setup"] as? JsonObject ?: throw AgentStoreFault("storage_corrupt")).toByteArray(Charsets.UTF_8))
                val result = LocalIdentityRecord(setup, string("key_reference"), string("phase"), optional("csr_pem"), optional("csr_sha256"), optional("public_key_fingerprint"), optional("certificate_fingerprint"))
                if (!DeviceKeyReference.valid(result.reference) || result.phase !in setOf("prepared", "creating", "pending", "active")) throw AgentStoreFault("storage_corrupt")
                val ready = result.phase in setOf("pending", "active")
                if (ready != (result.csr != null) || ready != (result.csrSha256 != null) || ready != (result.publicKeyFingerprint != null) ||
                    (result.phase == "active") != (result.certificateFingerprint != null)) throw AgentStoreFault("storage_corrupt")
                for (fingerprint in listOfNotNull(result.csrSha256, result.publicKeyFingerprint, result.certificateFingerprint))
                    if (!Regex("sha256:[0-9a-f]{64}").matches(fingerprint)) throw AgentStoreFault("storage_corrupt")
                return result
            } catch (error: AgentStoreFault) { throw error }
            catch (_: Exception) { throw AgentStoreFault("storage_corrupt") }
        }
    }
}
