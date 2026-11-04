package run.limeai.iot.core

import kotlinx.serialization.json.*
import java.io.File
import kotlin.test.*

private fun compositionFixture() = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "tests/fixtures/compositions/contract.json") }.first { it.isFile }.let { IntegerJSON.parse(it.readText()) }
class CompositionTest {
    @Test fun compileMatchesJavaScriptIncludingFractionsAndUnicode() {
        val fixture = compositionFixture()
        for (item in fixture.getValue("cases").jsonArray) {
            val v = item.jsonObject; val manifest = CompositionPackage.parse(MediaJSON.text(v, "package_text"))
            val bindings = v.getValue("bindings").jsonObject.mapValues { MediaJSON.str(it.value) }
            assertEquals(MediaJSON.text(v, "compiled_json"), manifest.compile(bindings, MediaJSON.text(v, "instance_id")).json, MediaJSON.text(v, "name"))
            assertFailsWith<CompositionException> { manifest.compile(mapOf("touch" to "same", "light" to "same"), "id") }
            assertFailsWith<CompositionException> { manifest.compile(mapOf("touch" to "x/y", "light" to "device-lamp"), "id") }
        }
    }
    @Test fun originalRecordMatchesJavaScriptAndRejectsContextAndCorruption() {
        val fixture = compositionFixture(); val origin = MediaJSON.text(fixture, "origin"); val space = MediaJSON.text(fixture, "space_id")
        for (value in fixture.getValue("records").jsonArray) {
            val text = MediaJSON.str(value); assertEquals(text, CompositionRecord.parse(text, origin, space).json)
            assertFailsWith<CompositionException> { CompositionRecord.parse(text, "https://other.local", space) }
            assertFailsWith<CompositionException> { CompositionRecord.parse(text, origin, "another") }
        }
        fixture.getValue("invalid_records").jsonArray.forEach { assertFailsWith<CompositionException> { CompositionRecord.parse(MediaJSON.str(it), origin, space) } }
    }
    @Test fun boundedPackagesAndExistingIntegerContractsStayStrict() {
        val fixture = compositionFixture()
        fixture.getValue("invalid_packages").jsonArray.forEach { assertFailsWith<CompositionException> { CompositionPackage.parse(MediaJSON.str(it)) } }
        assertFailsWith<GatewayException> { IntegerJSON.parse("""{"value":0.1}""") }
        assertFailsWith<CompositionException> { CompositionPackage.parse(" ".repeat(32769)) }
    }
}
