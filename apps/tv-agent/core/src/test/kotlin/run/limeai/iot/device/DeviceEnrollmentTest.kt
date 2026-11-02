package run.limeai.iot.device

import kotlin.test.*

class DeviceEnrollmentTest {
    @Test fun reject_ambiguous_untrusted_or_non_tls_material_before_install() {
        for (bytes in listOf(
            "{}", "{\"schema_version\":1,\"schema_version\":1}", "{\"owner_token\":\"must-not-enter-device\"}",
            "{\"schema_version\":1,\"space_id\":\"space\",\"device_id\":\"device\",\"broker\":\"tcp://localhost:1883\",\"ca_pem\":\"x\",\"certificate_pem\":\"x\",\"private_key_pem\":\"x\"}",
        )) assertEquals("invalid_enrollment", assertFailsWith<DeviceFault> { DeviceEnrollment.parse(bytes.toByteArray()) }.code)
        assertFailsWith<DeviceFault> { DeviceEnrollment.parse(ByteArray(32769) { 32 }) }
    }
    @Test fun broker_endpoint_rejects_implicit_credentials_paths_and_ports() {
        for (uri in listOf("tcp://host:1883", "ssl://host", "ssl://user:secret@host:8883", "ssl://host:8883/", "ssl://host:8883?x=1", "ssl://host:8883#fragment", "ssl://host:65536", "ssl://host:0")) {
            assertEquals("invalid_broker", assertFailsWith<DeviceFault> { DeviceBroker.parse(uri) }.code)
        }
        assertEquals("host", DeviceBroker.parse("ssl://host:8883").host)
    }
}
