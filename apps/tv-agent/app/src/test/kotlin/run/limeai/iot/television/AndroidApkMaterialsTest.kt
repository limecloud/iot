package run.limeai.iot.television

import android.app.Application
import android.os.Build
import kotlinx.serialization.json.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import run.limeai.iot.device.*
import java.io.File
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import kotlin.test.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [23, 28], application = Application::class)
class AndroidApkMaterialsTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private fun configure(material: ApkPreflightFixture.Materials) {
        ReflectionHelpers.setStaticField(Build::class.java, "SUPPORTED_ABIS", arrayOf("x86_64"))
        ApkPreflightFixture.installFacts(context, material)
    }
    private fun continuity() = ApkContinuitySnapshot(Fixtures.enrollment.binding, "sha256:" + "a".repeat(64), null)
    private fun read(material: ApkPreflightFixture.Materials, allowDebug: Boolean = false) = AndroidApkMaterials.read(context, material.bundle, material.candidate, allowDebug)
    private fun fault(code: String, action: () -> Unit) = assertEquals(code, assertFailsWith<DeviceFault>(block = action).code)

    @Test fun authentic_rsa_and_ec_materials_bind_actual_baseline_candidate_target_and_plan() {
        for (algorithm in listOf("RSA", "EC")) {
            val material = ApkPreflightFixture.create(algorithm = algorithm); configure(material)
            val original = listOf(material.bundle, material.baseline, material.candidate).map { it.readBytes() }
            val materials = read(material); val plan = materials.plan("update-one", continuity())
            assertEquals(3L, plan.baselineVersion); assertEquals(4L, plan.candidateVersion); assertEquals(4L, plan.candidateBytes)
            assertEquals(material.signer, plan.signerSha256)
            materials.verifyCurrent(plan); materials.verifyBoundary(plan)
            assertContentEquals(original[2], materials.openCandidate(plan).use { it.readBytes() })
            listOf(material.bundle, material.baseline, material.candidate).forEachIndexed { index, file -> assertContentEquals(original[index], file.readBytes()) }
            fault("apk_preflight_plan_mismatch") { materials.verifyBoundary(plan.copy(preflightDigest = "sha256:" + "b".repeat(64))) }
        }
    }

    @Test fun unsigned_tampered_and_differently_signed_reports_do_not_supply_trust() {
        val original = ApkPreflightFixture.create(); configure(original)
        val foreign = ApkPreflightFixture.create(algorithm = "EC")
        fault("apk_preflight_rejected") { AndroidApkMaterials.read(context, foreign.bundle, foreign.candidate, false) }
        val unsigned = File(original.bundle.parentFile, "unsigned.json").apply { writeText("{\"status\":\"offline_checks_passed\"}") }
        fault("apk_preflight_rejected") { AndroidApkMaterials.read(context, unsigned, original.candidate, false) }
        val tampered = File(original.bundle.parentFile, "tampered.jar")
        ZipFile(original.bundle).use { input -> ZipOutputStream(tampered.outputStream()).use { output ->
            input.entries().asSequence().forEach { entry ->
                output.putNextEntry(java.util.zip.ZipEntry(entry.name))
                val bytes = input.getInputStream(entry).use { it.readBytes() }
                output.write(if (entry.name == "preflight.json") bytes.toString(Charsets.UTF_8).replace("\"candidate_bytes\":4", "\"candidate_bytes\":5").toByteArray() else bytes)
                output.closeEntry()
            }
        } }
        fault("apk_preflight_rejected") { AndroidApkMaterials.read(context, tampered, original.candidate, false) }
    }

    @Test fun complete_byte_verification_at_boundaries_detects_changes_hidden_from_light_file_metadata() {
        val material = ApkPreflightFixture.create(); configure(material)
        val materials = read(material); val plan = materials.plan("update-one", continuity())
        val modified = material.candidate.lastModified(); val original = material.candidate.readBytes()
        material.candidate.writeBytes(byteArrayOf(9, 8, 7, 6)); assertTrue(material.candidate.setLastModified(modified))
        materials.verifyCurrent(plan)
        fault("apk_preflight_candidate_changed") { materials.verifyBoundary(plan) }
        material.candidate.writeBytes(original); assertTrue(material.candidate.setLastModified(modified))
        materials.verifyBoundary(plan)
    }

    @Test fun signed_debug_report_still_requires_local_explicit_approval() {
        val material = ApkPreflightFixture.create(debug = true); configure(material)
        fault("apk_preflight_debug_requires_approval") { read(material) }
        val approved = read(material, true); approved.verifyBoundary(approved.plan("update-one", continuity()))
    }

    @Test fun even_authenticated_reports_cannot_claim_installation_authority_or_inconsistent_permissions() {
        for (change in listOf<(MutableMap<String, JsonElement>) -> Unit>(
            { it["installation_authorized"] = JsonPrimitive(true) },
            { it["added_permissions"] = JsonArray(emptyList()) },
            { it["extra"] = JsonPrimitive("unsupported") },
        )) {
            val material = ApkPreflightFixture.create(change = change); configure(material)
            fault("apk_preflight_rejected") { read(material) }
        }
        val wrongTarget = ApkPreflightFixture.create(api = if (Build.VERSION.SDK_INT == 23) 28 else 23); configure(wrongTarget)
        fault("apk_preflight_target_mismatch") { read(wrongTarget) }
    }
}
