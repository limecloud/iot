package run.limeai.iot.television

import kotlinx.serialization.json.*
import run.limeai.iot.device.*

data class KeyRetirementView(val requestId: String, val previousCertificate: String, val previousPublicKey: String, val phase: String, val crlFingerprint: String? = null)
data class KeyRetirementPreview(val requestId: String, val proof: DeviceRevocationProof)

/** 提交原清理意图后才能删除；保留原CRL与批准时刻供中断恢复，不因CRL后来到期重做决定。 */
internal data class KeyRetirementRecord(val phase: String, val proof: DeviceRevocationProof, val approvedAt: Long) {
    fun document(): JsonObject = buildJsonObject {
        put("phase", phase); put("approved_at", approvedAt)
        put("crl_pem", JsonArray(proof.encoded().toString(Charsets.US_ASCII).chunked(2048).map(::JsonPrimitive)))
    }
    companion object {
        fun parse(value: JsonElement): KeyRetirementRecord {
            val document = value as? JsonObject ?: throw AgentStoreFault("storage_corrupt")
            if (document.keys != setOf("phase", "approved_at", "crl_pem")) throw AgentStoreFault("storage_corrupt")
            val phase = (document["phase"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val approvedAt = (document["approved_at"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
            val chunks = document["crl_pem"] as? JsonArray ?: throw AgentStoreFault("storage_corrupt")
            if (phase !in setOf("deleting", "retired") || approvedAt == null || approvedAt !in 1..9007199254740991L || chunks.size !in 1..8) throw AgentStoreFault("storage_corrupt")
            val pem = chunks.joinToString("") { item ->
                (item as? JsonPrimitive)?.takeIf { it.isString && it.content.length in 1..2048 }?.content ?: throw AgentStoreFault("storage_corrupt")
            }
            return KeyRetirementRecord(phase!!, DeviceRevocationProof.parse(pem.toByteArray(Charsets.US_ASCII)), approvedAt)
        }
    }
}
