package run.limeai.iot.television

import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.content.pm.SigningInfo
import android.os.Build
import android.os.Process
import kotlinx.serialization.json.*
import org.robolectric.Shadows.shadowOf
import run.limeai.iot.device.*
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** 真正JDK JAR签名；APK内容/PackageManager明确为宿主夹具，不冒称SDK预检或Android运行证据。 */
internal object ApkPreflightFixture {
    private data class Signer(val store: File, val certificate: ByteArray)
    data class Materials(val bundle: File, val baseline: File, val candidate: File, val certificate: ByteArray, val signer: String)
    private val signers = mutableMapOf<String, Signer>()
    private const val password = "isolated-preflight-fixture-only"
    fun hash(bytes: ByteArray) = "sha256:" + MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun jdk(tool: String, vararg args: String): ByteArray {
        // 小型夹具不需要默认的大堆/并行GC；仅限制本次子进程，不修改宿主JVM或系统配置。
        val builder = ProcessBuilder(listOf(File(System.getProperty("java.home"), "bin/$tool").absolutePath,
            "-J-Xms16m", "-J-Xmx64m", "-J-XX:+UseSerialGC", "-J-XX:ActiveProcessorCount=1") + args)
        builder.environment()["LIMEIOT_APK_FIXTURE_PASSWORD"] = password
        val diagnostics = Files.createTempFile("limeiot-preflight-tool-", ".log").toFile()
        val process = builder.redirectError(diagnostics).start()
        if (!process.waitFor(10, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            check(process.waitFor(1, TimeUnit.SECONDS)) { "fixture JDK tool did not exit after timeout" }
            error("fixture JDK tool timed out")
        }
        val bytes = process.inputStream.readBytes()
        check(process.exitValue() == 0) { "fixture JDK tool failed" }
        return bytes
    }
    @Synchronized private fun signer(algorithm: String): Signer = signers.getOrPut(algorithm) {
        val directory = Files.createTempDirectory("limeiot-preflight-key-").toFile()
        val store = File(directory, "fixture.p12")
        val parameters = if (algorithm == "EC") arrayOf("-groupname", "secp256r1") else arrayOf("-keysize", "2048")
        jdk("keytool", "-genkeypair", "-alias", "release", "-keyalg", algorithm, *parameters, "-storetype", "PKCS12", "-keystore", store.absolutePath,
            "-storepass:env", "LIMEIOT_APK_FIXTURE_PASSWORD", "-keypass:env", "LIMEIOT_APK_FIXTURE_PASSWORD", "-dname", "CN=Isolated Preflight Fixture", "-validity", "2")
        Signer(store, jdk("keytool", "-exportcert", "-alias", "release", "-keystore", store.absolutePath, "-storepass:env", "LIMEIOT_APK_FIXTURE_PASSWORD"))
    }

    fun create(api: Int = Build.VERSION.SDK_INT, algorithm: String = "RSA", debug: Boolean = false, change: (MutableMap<String, JsonElement>) -> Unit = {}): Materials {
        val signer = signer(algorithm)
        val directory = Files.createTempDirectory("limeiot-preflight-materials-").toFile()
        val baseline = File(directory, "baseline.apk").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        val candidate = File(directory, "candidate.apk").apply { writeBytes(byteArrayOf(4, 5, 6, 7)) }
        val pin = hash(signer.certificate)
        fun facts(file: File, version: Int, permissions: List<String>, debuggable: Boolean) = buildJsonObject {
            put("package_name", ApkInstallJournal.PACKAGE); put("version_code", version); put("min_sdk", 23); put("target_sdk", 36); put("max_sdk", JsonNull)
            put("debuggable", debuggable); put("permissions", JsonArray(permissions.map(::JsonPrimitive))); put("sha256", hash(file.readBytes()).removePrefix("sha256:"))
            put("signer_sha256", pin.removePrefix("sha256:")); put("native_abis", JsonArray(emptyList())); put("signature_warning_count", 0)
        }
        val report = buildJsonObject {
            put("schema_version", 1); put("status", "offline_checks_passed"); put("installation_authorized", false)
            put("device_state_verified", false); put("storage_compatibility_verified", false)
            put("target", buildJsonObject { put("api_level", api); put("abis", JsonArray(listOf(JsonPrimitive("x86_64")))) })
            put("baseline", facts(baseline, 3, listOf("android.permission.INTERNET"), false))
            put("candidate", facts(candidate, 4, listOf("android.permission.INTERNET", "android.permission.REQUEST_INSTALL_PACKAGES"), debug))
            put("added_permissions", JsonArray(listOf(JsonPrimitive("android.permission.REQUEST_INSTALL_PACKAGES"))))
            put("debug_candidate_explicitly_allowed", debug)
        }.toMutableMap().also(change)
        val document = buildJsonObject {
            put("schema", "limeiot.tv-apk-preflight"); put("version", 1); put("candidate_bytes", candidate.length()); put("preflight", JsonObject(report))
        }
        val bundle = File(directory, "preflight.jar")
        ZipOutputStream(bundle.outputStream()).use { zip ->
            zip.putNextEntry(ZipEntry("preflight.json")); zip.write(document.toString().toByteArray()); zip.closeEntry()
        }
        jdk("jarsigner", "-keystore", signer.store.absolutePath, "-storepass:env", "LIMEIOT_APK_FIXTURE_PASSWORD", "-keypass:env", "LIMEIOT_APK_FIXTURE_PASSWORD",
            "-digestalg", "SHA-256", "-sigalg", if (algorithm == "EC") "SHA256withECDSA" else "SHA256withRSA", "-sigfile", "LIMEIOT", bundle.absolutePath, "release")
        return Materials(bundle, baseline, candidate, signer.certificate, pin)
    }

    @Suppress("DEPRECATION")
    fun installFacts(context: Context, material: Materials) {
        val info = context.packageManager.getPackageInfo(ApkInstallJournal.PACKAGE, PackageManager.GET_PERMISSIONS)
        info.versionCode = 3
        info.applicationInfo!!.apply { uid = Process.myUid(); sourceDir = material.baseline.absolutePath }
        info.signatures = arrayOf(Signature(material.certificate))
        if (Build.VERSION.SDK_INT >= 28) info.signingInfo = SigningInfo().also { shadowOf(it).setSignatures(info.signatures) }
        shadowOf(context.packageManager).installPackage(info)
    }
}
