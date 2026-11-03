package run.limeai.iot.core

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import kotlin.test.*
import kotlinx.coroutines.runBlocking

class RuleTriggerTest {
    private val json = Json { ignoreUnknownKeys = true }
    @Test fun scheduleRoundTripHasNoFictitiousDevice() {
        val source = """{"schedule":{"time":"22:00","time_zone":"Asia/Shanghai","weekdays":[1,3,7]}}"""
        val trigger = json.decodeFromString<Trigger>(source)
        assertEquals("", trigger.device); assertNull(trigger.event); assertNull(trigger.property)
        assertEquals("Asia/Shanghai", trigger.schedule!!.timeZone)
        assertEquals(json.parseToJsonElement(source), json.parseToJsonElement(json.encodeToString(trigger)))
    }
    @Test fun scheduleRejectsMixedAndInvalidShapes() {
        for (source in listOf("""{"schedule":null}""", """{"schedule":{"time":"24:00","time_zone":"UTC","weekdays":[1]}}""",
            """{"schedule":{"time":"22:00","time_zone":"UTC","weekdays":[]}}""", """{"schedule":{"time":"22:00","time_zone":"UTC","weekdays":[1,1]}}""",
            """{"schedule":{"time":"22:00","time_zone":"UTC","weekdays":[0]}}""", """{"device":"","schedule":{"time":"22:00","time_zone":"UTC","weekdays":[1]}}""",
            """{"event":null,"schedule":{"time":"22:00","time_zone":"UTC","weekdays":[1]}}""", """{"schedule":{"time":"22:00","time_zone":"UTC","weekdays":[1],"extra":true}}""")) {
            assertFails(source) { json.decodeFromString<Trigger>(source) }
        }
    }
    @Test fun scheduleFormAndActualGateway() = runBlocking {
        assertEquals(listOf(7,1), ScheduleTrigger.fromForm("22:00", "Asia/Shanghai", listOf(7,1))!!.weekdays)
        assertNull(ScheduleTrigger.fromForm("22:00", "Unknown/Zone", listOf(1)))
        assertNull(ScheduleTrigger.fromForm("22:00", "UTC", emptyList()))
        if (System.getenv("LIMEIOT_SCHEDULE_CHECK") != "1") return@runBlocking
        val client = GatewayClient(System.getenv("LIMEIOT_ENDPOINT"), allowLoopbackHTTP = true)
        client.login(System.getenv("LIMEIOT_TOKEN"))
        val space = client.snapshot().space
        fun rule(time: String) = Rule(id = "native-schedule", trigger = Trigger(schedule = ScheduleTrigger(time, "Asia/Shanghai", listOf(1,3,7))), conditions = emptyList(), actions = listOf(Action("device-lamp", SetValue("light.power", JsonPrimitive(true)))), cooldownMs = 1001)
        val original = rule("22:00"); val preview = client.simulate(space, original, JsonNull)
        assertTrue(preview.matched); assertFalse(preview.executed); assertTrue(client.snapshot().commands.items.isEmpty())
        client.deploy(space, original); assertEquals(original, client.snapshot().deployments.single().rule)
        val edited = rule("23:00"); client.simulate(space, edited, JsonNull)
        val deployment = client.deploy(space, edited); assertEquals(edited, client.snapshot().deployments.single().rule)
        client.stop(space, deployment); assertTrue(client.snapshot().deployments.isEmpty()); assertTrue(client.snapshot().commands.items.isEmpty())
    }
    @Test fun propertyRoundTripAndSummary() {
        val text = """{"device":"sensor","property":{"path":"environment.temperature","unit":"celsius_x100","edge":"rising","threshold":2800,"hysteresis":100}}"""
        val trigger = json.decodeFromString<Trigger>(text)
        assertNull(trigger.event)
        assertEquals("温度上升越过 28.00 ℃，滞回 1.00 ℃", trigger.summary)
        assertEquals(json.parseToJsonElement(text), json.parseToJsonElement(json.encodeToString(trigger)))
        assertEquals(json.parseToJsonElement("""{"device":"button","event":"button.pressed"}"""), json.parseToJsonElement(json.encodeToString(Trigger("button", "button.pressed"))))
    }
    @Test fun triggerAlternativesAreStrictDespiteLooseModelReading() {
        for (text in listOf("""{"device":"sensor"}""", """{"device":"sensor","property":null}""",
            """{"device":"sensor","event":null}""", """{"device":"sensor","event":"button.pressed","property":null}""")) {
            assertFails { json.decodeFromString<Trigger>(text) }
        }
    }
    @Test fun actualGatewayThresholdReadAndSimulation() = runBlocking {
        if (System.getenv("LIMEIOT_THRESHOLD_CHECK") != "1") return@runBlocking
        val client = GatewayClient(System.getenv("LIMEIOT_ENDPOINT"), allowLoopbackHTTP = true)
        client.login(System.getenv("LIMEIOT_TOKEN"))
        val snapshot = client.snapshot()
        val rule = snapshot.deployments.single { it.rule.trigger.property != null }.rule
        assertEquals("温度上升越过 28.00 ℃，滞回 1.00 ℃", rule.trigger.summary)
        val device = snapshot.devices.single { it.deviceId == rule.trigger.device }
        val schema = snapshot.models.getValue(device.modelRevision).services.flatMap { service -> service.properties.filter { "${service.id}.${it.id}" == rule.trigger.property!!.path } }.single().schema
        val result = client.simulate(snapshot.space, rule, assertNotNull(ThresholdEditor.samples(rule.trigger.property!!, schema)))
        assertTrue(result.matched); assertFalse(result.executed)
    }
    @Test fun formPreservesDecimalUnitsAndRejectsUnreachableOrInvalidSamples() {
        val schema = ValueSchema("integer", minimum = -4500.0, maximum = 13000.0)
        val property = assertNotNull(ThresholdEditor.property("environment.temperature", "celsius_x100", schema, ThresholdEdge.Rising, "28.03", "1"))
        assertEquals(JsonPrimitive(2803), property.threshold); assertEquals(JsonPrimitive(100), property.hysteresis)
        assertEquals(JsonPrimitive(2804), ThresholdEditor.samples(property, schema)!!["current"]!!.jsonObject["value"])
        assertEquals(JsonPrimitive(29), ThresholdEditor.number("0.29", schema, property.unit))
        for (text in listOf("", "NaN", "Infinity", "28.001", "1e2", "131")) assertNull(ThresholdEditor.property(property.path, property.unit, schema, ThresholdEdge.Rising, text, "1"))
        assertNull(ThresholdEditor.property(property.path, property.unit, schema, ThresholdEdge.Rising, "-45", "1"))
        val ceiling = assertNotNull(ThresholdEditor.property(property.path, property.unit, schema, ThresholdEdge.Rising, "130", "1"))
        assertNull(ThresholdEditor.samples(ceiling, schema))
    }
}
