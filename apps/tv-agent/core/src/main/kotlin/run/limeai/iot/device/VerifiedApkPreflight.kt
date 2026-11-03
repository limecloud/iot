package run.limeai.iot.device

import kotlinx.serialization.json.*
import okio.ByteString.Companion.decodeBase64
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.jar.JarFile
import java.util.jar.Manifest

/** 同一APK签名身份认证的预检事实；不提供设备控制或安装授权。 */
class VerifiedApkPreflight private constructor(
    private val document: JsonObject,
    val baseline: Facts,
    val candidate: Facts,
    val candidateBytes: Long,
    private val api: Int,
    private val abis: List<String>,
) {
    data class Facts(val version: Long, val sha256: String, val signer: String, val minimumApi: Long,
        val maximumApi: Long?, val debug: Boolean, val permissions: List<String>, val nativeAbis: List<String>)
    val digest: String get() = DeviceDocument.digest(document)
    val addedPermissions: List<String> get() = candidate.permissions - baseline.permissions.toSet()

    fun plan(requestId: String, binding: String, continuityDigest: String) = ApkInstallPlan(requestId, binding,
        baseline.sha256, candidate.sha256, candidate.signer, baseline.version, candidate.version, candidateBytes, continuityDigest, digest)

    fun verifyTarget(actualApi: Int, actualAbis: List<String>, allowDebug: Boolean) {
        checkDevice(actualApi == api && abis.all { it in actualAbis } && actualAbis.isNotEmpty(), "apk_preflight_target_mismatch")
        for (facts in listOf(baseline, candidate)) {
            checkDevice(facts.minimumApi <= actualApi && (facts.maximumApi == null || actualApi <= facts.maximumApi) &&
                (facts.nativeAbis.isEmpty() || facts.nativeAbis.any { it in actualAbis }), "apk_preflight_target_mismatch")
        }
        checkDevice(!candidate.debug || allowDebug, "apk_preflight_debug_requires_approval")
    }

    fun verifyPlan(plan: ApkInstallPlan) {
        checkDevice(plan.preflightDigest == digest && plan.baselineVersion == baseline.version && plan.baselineSha256 == baseline.sha256 &&
            plan.candidateVersion == candidate.version && plan.candidateSha256 == candidate.sha256 && plan.candidateBytes == candidateBytes &&
            plan.signerSha256 == candidate.signer, "apk_preflight_plan_mismatch")
    }

    /** 安装效果边界完整流式核对；逐块安装另由原提供方重验同一摘要。 */
    fun verifyCandidate(file: File) {
        try {
            checkDevice(file.isFile && file.length() == candidateBytes, "apk_preflight_candidate_changed")
            val hash = MessageDigest.getInstance("SHA-256")
            var count = 0L
            FileInputStream(file).use { input ->
                val block = ByteArray(65536)
                while (true) {
                    val length = input.read(block)
                    if (length < 0) break
                    count += length
                    checkDevice(length > 0 && count <= candidateBytes, "apk_preflight_candidate_changed")
                    hash.update(block, 0, length)
                }
                checkDevice(count == candidateBytes && input.channel.size() == candidateBytes, "apk_preflight_candidate_changed")
            }
            checkDevice(fingerprint(hash.digest()) == candidate.sha256, "apk_preflight_candidate_changed")
        } catch (error: DeviceFault) { throw error }
        catch (_: Exception) { throw DeviceFault("apk_preflight_candidate_unavailable") }
    }

    companion object {
        private val supportedAbis = setOf("armeabi", "armeabi-v7a", "arm64-v8a", "x86", "x86_64", "riscv64")
        private fun fingerprint(bytes: ByteArray) = "sha256:" + bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
        private fun readBounded(input: InputStream, limit: Int): ByteArray = input.use {
            val output = ByteArrayOutputStream(); val block = ByteArray(8192)
            while (true) {
                val length = input.read(block)
                if (length < 0) break
                checkDevice(length > 0 && output.size() + length <= limit, "apk_preflight_rejected")
                output.write(block, 0, length)
            }
            output.toByteArray()
        }

        /** expectedSigner只能来自当前已装包的系统签名事实，不能取自导入报告。 */
        fun read(file: File, expectedSigner: String): VerifiedApkPreflight {
            try {
                checkDevice(Regex("sha256:[0-9a-f]{64}").matches(expectedSigner) && file.isFile && file.length() in 1..1048576)
                val payload = JarFile(file, true).use { jar ->
                    val entries = mutableListOf<java.util.jar.JarEntry>()
                    val enumerator = jar.entries()
                    while (enumerator.hasMoreElements()) { checkDevice(entries.size < 5); entries += enumerator.nextElement() }
                    val names = entries.map { it.name }
                    val block = names.singleOrNull { it == "META-INF/LIMEIOT.RSA" || it == "META-INF/LIMEIOT.EC" } ?: throw DeviceFault("apk_preflight_rejected")
                    val required = setOf("META-INF/MANIFEST.MF", "META-INF/LIMEIOT.SF", "preflight.json", block)
                    checkDevice(names.size in 4..5 && names.distinct().size == names.size && names.toSet() - setOf("META-INF/") == required)
                    checkDevice(entries.all { if (it.name == "META-INF/") it.isDirectory else !it.isDirectory && it.size in 1..262144 })
                    val manifestBytes = readBounded(jar.getInputStream(jar.getJarEntry("META-INF/MANIFEST.MF")), 262144)
                    val sf = Manifest(ByteArrayInputStream(readBounded(jar.getInputStream(jar.getJarEntry("META-INF/LIMEIOT.SF")), 262144)))
                    val sha = sf.mainAttributes.getValue("SHA-256-Digest-Manifest") ?: throw DeviceFault("apk_preflight_rejected")
                    val decoded = sha.decodeBase64() ?: throw DeviceFault("apk_preflight_rejected")
                    checkDevice(decoded.base64() == sha && MessageDigest.isEqual(decoded.toByteArray(), MessageDigest.getInstance("SHA-256").digest(manifestBytes)))
                    val manifest = Manifest(ByteArrayInputStream(manifestBytes))
                    checkDevice(manifest.entries.keys == setOf("preflight.json") && manifest.getAttributes("preflight.json").keys.map { it.toString() }.toSet() == setOf("SHA-256-Digest"))
                    val entry = jar.getJarEntry("preflight.json")
                    val bytes = readBounded(jar.getInputStream(entry), 65536) // 必须完整读完，JarVerifier才交付签名证书。
                    val codeSigner = entry.codeSigners?.singleOrNull() ?: throw DeviceFault("apk_preflight_rejected")
                    val chain = codeSigner.signerCertPath.certificates
                    checkDevice(chain.size in 1..8)
                    val certificate = chain.first()
                    checkDevice(certificate.encoded.size in 1..65536 && DeviceSigningKey.fingerprint(certificate.encoded) == expectedSigner)
                    checkDevice(block.endsWith(if (certificate.publicKey.algorithm == "RSA") ".RSA" else if (certificate.publicKey.algorithm == "EC") ".EC" else throw DeviceFault("apk_preflight_rejected")))
                    bytes
                }
                return parse(payload, expectedSigner)
            } catch (_: Exception) { throw DeviceFault("apk_preflight_rejected") }
        }

        private fun parse(bytes: ByteArray, signer: String): VerifiedApkPreflight {
            val doc = DeviceDocument.parse(bytes, 65536, 8192)
            doc.fields("schema", "version", "candidate_bytes", "preflight")
            checkDevice(doc.text("schema") == "limeiot.tv-apk-preflight" && doc.integer("version") == 1L)
            val size = doc.integer("candidate_bytes"); checkDevice(size in 1..268435456L)
            val report = doc.getValue("preflight").obj()
            report.fields("schema_version", "status", "installation_authorized", "device_state_verified", "storage_compatibility_verified", "target", "baseline", "candidate", "added_permissions", "debug_candidate_explicitly_allowed")
            checkDevice(report.integer("schema_version") == 1L && report.text("status") == "offline_checks_passed" &&
                listOf("installation_authorized", "device_state_verified", "storage_compatibility_verified").all { report[it] == JsonPrimitive(false) })
            val target = report.getValue("target").obj(); target.fields("api_level", "abis")
            val api = target.integer("api_level"); checkDevice(api in 23L..36L)
            val abis = strings(target.getValue("abis"), 6, 32); checkDevice(abis.isNotEmpty() && abis.all { it in supportedAbis })
            val baseline = facts(report.getValue("baseline").obj(), signer)
            val candidate = facts(report.getValue("candidate").obj(), signer)
            checkDevice(candidate.version > baseline.version && candidate.sha256 != baseline.sha256)
            checkDevice(report["debug_candidate_explicitly_allowed"] == JsonPrimitive(candidate.debug))
            checkDevice(strings(report.getValue("added_permissions"), 256, 255) == (candidate.permissions - baseline.permissions.toSet()))
            return VerifiedApkPreflight(doc, baseline, candidate, size, api.toInt(), abis).also { it.verifyTarget(api.toInt(), abis, true) }
        }

        private fun strings(value: JsonElement, limit: Int, length: Int): List<String> {
            val array = value as? JsonArray ?: throw DeviceFault("apk_preflight_rejected")
            checkDevice(array.size <= limit)
            return array.map { item -> (item as? JsonPrimitive)?.takeIf { it.isString && it.content.length in 1..length }?.content ?: throw DeviceFault("apk_preflight_rejected") }
                .also { checkDevice(it.distinct().size == it.size) }
        }

        private fun facts(value: JsonObject, signer: String): Facts {
            value.fields("package_name", "version_code", "min_sdk", "target_sdk", "max_sdk", "debuggable", "permissions", "sha256", "signer_sha256", "native_abis", "signature_warning_count")
            checkDevice(value.text("package_name") == ApkInstallJournal.PACKAGE)
            for (name in listOf("sha256", "signer_sha256")) checkDevice(Regex("[0-9a-f]{64}").matches(value.text(name)))
            checkDevice("sha256:" + value.text("signer_sha256") == signer)
            val version = value.integer("version_code"); val minimum = value.integer("min_sdk"); val target = value.integer("target_sdk")
            val maximum = if (value["max_sdk"] == JsonNull) null else value.integer("max_sdk")
            checkDevice(version in 1..2147483647L && minimum in 1..2147483647L && target in minimum..2147483647L && (maximum == null || maximum >= minimum))
            val debug = value["debuggable"]; checkDevice(debug == JsonPrimitive(true) || debug == JsonPrimitive(false))
            checkDevice(value.integer("signature_warning_count") in 0..20000L)
            val permissions = strings(value.getValue("permissions"), 256, 255); checkDevice(permissions == permissions.sorted())
            val native = strings(value.getValue("native_abis"), 6, 32); checkDevice(native.all { it in supportedAbis } && native == native.sorted())
            return Facts(version, "sha256:" + value.text("sha256"), signer, minimum, maximum, debug == JsonPrimitive(true), permissions, native)
        }
    }
}
