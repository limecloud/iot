package run.limeai.iot.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import kotlin.test.*

class EnvironmentPropertyTest {
    @Test fun scaledReadonlyAndLegacyProperties() {
        val json = Json { ignoreUnknownKeys = true }
        val temperature = json.decodeFromString<Property>("""{"id":"temperature","semantic_id":"urn:limeiot:property:temperature:1","unit":"celsius_x100","schema":{"type":"integer"},"access":["read","notify"]}""")
        for ((value, expected) in listOf(2500 to "25.00 ℃", -123 to "-1.23 ℃", 0 to "0.00 ℃")) assertEquals(expected, temperature.displayValue(JsonPrimitive(value)))
        assertEquals("温度", temperature.displayName); assertEquals("暂无状态", temperature.displayValue(null)); assertFalse("write" in temperature.access)
        val legacy = json.decodeFromString<Property>("""{"id":"brightness","schema":{"type":"integer"},"access":["read","write"]}""")
        assertNull(legacy.unit); assertEquals("50", legacy.displayValue(JsonPrimitive(50)))
    }
    @Test fun actualGatewayEnvironment() = runBlocking {
        if (System.getenv("LIMEIOT_ENVIRONMENT_CHECK") != "1") return@runBlocking
        val client = GatewayClient(System.getenv("LIMEIOT_ENDPOINT"), allowLoopbackHTTP = true)
        client.login(System.getenv("LIMEIOT_TOKEN"))
        val snapshot = client.snapshot()
        val device = snapshot.devices.single { it.deviceId == "device-environment" }
        val service = snapshot.models.getValue(device.modelRevision).services.single { it.id == "environment" }
        val expected = mapOf("temperature" to "25.00 ℃", "humidity" to "50.00 %RH")
        assertEquals(2, service.properties.size)
        for (property in service.properties) {
            assertFalse("write" in property.access)
            assertEquals(expected[property.id], property.displayValue(device.reported["environment." + property.id]?.value))
        }
    }
}
