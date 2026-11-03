package run.limeai.iot.device

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File

/** 宿主跨语言验签入口；只读实际签名包与候选字节，不安装或连接设备。 */
object ApkPreflightCheckMain {
    @JvmStatic fun main(arguments: Array<String>) {
        require(arguments.size == 3)
        val preflight = VerifiedApkPreflight.read(File(arguments[0]), arguments[2])
        preflight.verifyCandidate(File(arguments[1]))
        println(DeviceDocument.canonical(buildJsonObject {
            put("status", "signed_preflight_verified"); put("digest", preflight.digest)
            put("baseline_version", preflight.baseline.version); put("candidate_version", preflight.candidate.version)
            put("candidate_bytes", preflight.candidateBytes); put("candidate_sha256", preflight.candidate.sha256)
            put("signer_sha256", preflight.candidate.signer); put("installation_authorized", false); put("hardware", false)
        }))
    }
}
