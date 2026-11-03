package run.limeai.iot.device

import kotlinx.serialization.json.*

/** 管理端原签发结果只作为待核对的公开数据；不从回执取得信任、模型或执行权。 */
class DeviceRotationReceipt private constructor(private val value: JsonObject) {
    val requestId: String get() = value.text("request_id")
    val challenge: String get() = value.text("activation_challenge")
    val requestDigest: String get() = value.text("request_sha256")
    val certificateFingerprint: String get() = value.text("certificate_sha256")
    val managementCompleted: Boolean get() = value["rotation_completed"] == JsonPrimitive(true)
    val expiredRecovery: Boolean get() = value.integer("schema_version") == 3L
    fun awaitingActivation(expiredMaintenance: Boolean = false): Boolean = value.text("previous_decision") in (if (expiredRecovery || expiredMaintenance) setOf("issued", "expired") else setOf("issued")) && value["activation_confirmed"] == JsonPrimitive(false) && value["crl_updated"] == JsonPrimitive(false) && !managementCompleted
    fun encoded(): ByteArray = DeviceDocument.canonical(value).toByteArray(Charsets.UTF_8)

    fun verify(setup: DeviceIdentitySetup, request: DeviceCertificateRequest, previousSerial: String, previousFingerprint: String, enrollment: DeviceIdentityMetadata, recovery: Boolean = false, preservesRotation: Boolean = false) {
        checkDevice((expiredRecovery == recovery || recovery && preservesRotation && !expiredRecovery) && requestId == setup.requestId && value.text("space_id") == setup.identity.space && value.text("device_id") == setup.identity.device &&
            value.text("ca_fingerprint") == setup.caFingerprint && value.text("csr_sha256") == request.csrSha256 &&
            value.text("public_key_fingerprint") == request.publicKeyFingerprint && value.text("replaces_serial").toBigInteger(16) == previousSerial.toBigInteger(16) &&
            value.text("replaces_certificate_sha256") == previousFingerprint && value.text("serial").toBigInteger(16) == enrollment.certificateSerial.toBigInteger(16) &&
            certificateFingerprint == enrollment.certificateFingerprint && value.text("decision") == "issued" &&
            DeviceTime.parse(value.text("not_before")) == enrollment.certificateNotBefore && DeviceTime.parse(value.text("not_after")) == enrollment.certificateExpiresAt,
            "rotation_receipt_mismatch")
    }

    companion object {
        fun parse(bytes: ByteArray): DeviceRotationReceipt {
            try {
                val value = DeviceDocument.parse(bytes, 16384)
                val version = value.integer("schema_version")
                checkDevice(version in 2L..3L, "invalid_rotation_receipt")
                val requestFields = setOf("schema_version", "request_id", "space_id", "device_id", "serial", "csr_sha256", "public_key_fingerprint", "ca_fingerprint", "replaces_serial", "replaces_certificate_sha256", "activation_challenge") + if (version == 3L) setOf("recovery_reason") else emptySet()
                val required = requestFields + setOf("request_sha256", "decision", "hardware", "physical_claim", "previous_decision", "activation_confirmed", "crl_updated", "rotation_completed", "certificate_sha256", "not_before", "not_after")
                val optional = setOf("broker_restart_required", "status", "action", "output")
                checkDevice(value.keys.containsAll(required) && (value.keys - required - optional).isEmpty(), "invalid_rotation_receipt")
                if (version == 3L) checkDevice(value.text("recovery_reason") == "certificate_expired", "invalid_rotation_receipt")
                for (name in setOf("request_id", "space_id", "device_id")) checkDevice(identifier.matches(value.text(name)))
                for (name in setOf("serial", "replaces_serial")) checkDevice(Regex("[0-9A-F]{1,40}").matches(value.text(name)) && value.text(name).toBigInteger(16).signum() > 0)
                checkDevice(value.text("serial").toBigInteger(16) != value.text("replaces_serial").toBigInteger(16))
                for (name in setOf("csr_sha256", "public_key_fingerprint", "ca_fingerprint", "replaces_certificate_sha256", "certificate_sha256", "request_sha256")) checkDevice(Regex("sha256:[0-9a-f]{64}").matches(value.text(name)))
                checkDevice(Regex("[0-9a-f]{64}").matches(value.text("activation_challenge")) && value.text("decision") == "issued" &&
                    value["hardware"] == JsonPrimitive(false) && value["physical_claim"] == JsonPrimitive(false))
                for (name in setOf("activation_confirmed", "crl_updated", "rotation_completed")) checkDevice(value[name] == JsonPrimitive(true) || value[name] == JsonPrimitive(false))
                checkDevice(value.text("previous_decision") in setOf("issued", "revoked", "expired"))
                if (value["rotation_completed"] == JsonPrimitive(true)) checkDevice(value.text("previous_decision") == "revoked" && value["activation_confirmed"] == JsonPrimitive(true) && value["crl_updated"] == JsonPrimitive(true))
                value["broker_restart_required"]?.let { checkDevice(it == JsonPrimitive(true)) }
                checkDevice(("status" in value) == ("action" in value))
                if ("status" in value) checkDevice(value.text("status") == "ok" && value.text("action") in setOf(if (version == 3L) "recover-csr" else "rotate-csr", "resolve-csr", "complete-rotation"))
                if ("output" in value) checkDevice("status" in value && value.text("output").isNotEmpty())
                checkDevice(DeviceDocument.digest(JsonObject(value.filterKeys { it in requestFields })) == value.text("request_sha256"))
                DeviceTime.parse(value.text("not_before")); DeviceTime.parse(value.text("not_after"))
                return DeviceRotationReceipt(value)
            } catch (_: Exception) { throw DeviceFault("invalid_rotation_receipt") }
        }
    }
}
