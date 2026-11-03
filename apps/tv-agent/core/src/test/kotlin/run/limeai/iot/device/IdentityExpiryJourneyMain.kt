package run.limeai.iot.device

import kotlinx.serialization.json.*
import java.nio.file.Files
import java.nio.file.Paths
import java.nio.file.StandardOpenOption
import kotlin.test.*

/** 独立JVM使用真实短期证书；延迟耐久提交返回，核对连接中到期后的副作用门禁。 */
object IdentityExpiryJourneyMain {
    @JvmStatic fun main(args: Array<String>) {
        val directory = Paths.get(System.getenv("LIMEIOT_TV_AGENT_DIRECTORY"))
        val enrollment = DeviceEnrollment.parse(Files.readAllBytes(directory.resolve("credentials/enrollment.json")))
        val tls = enrollment.tls(); val savedFactory = tls.socketFactory
        var held = false; var effects = 0
        val journal = directory.resolve("expiry-journal.json")
        val storage = object : DeviceStorage {
            override fun read(): ByteArray? = if (Files.exists(journal)) Files.readAllBytes(journal) else null
            override fun commit(bytes: ByteArray) {
                Files.write(journal, bytes)
                val value = DeviceDocument.parse(bytes, 1048576, 32768)
                if (!held && value["high_watermark"] == JsonPrimitive(2) && value.getValue("entries").jsonObject.values.any { it.jsonObject["result"] == JsonNull }) {
                    held = true; Files.write(directory.resolve("expiry-pending"), byteArrayOf(1))
                    while (tls.current) Thread.sleep(10)
                }
            }
        }
        val applications = object : ApplicationPort {
            override fun permitted(application: String) = application == "com.example.player"
            override fun submit(application: String) {
                effects++
                Files.write(directory.resolve("expiry-effects.jsonl"), ("{\"effect\":" + effects + "}\n").toByteArray(), StandardOpenOption.CREATE, StandardOpenOption.APPEND)
            }
        }
        val client = DeviceMqtt(enrollment.identity, enrollment.broker, tls, storage, applications,
            object : DeviceClock { override fun elapsedMillis() = System.nanoTime() / 1000000 }) { state ->
            Files.write(directory.resolve("expiry-status.jsonl"), (JsonPrimitive(state).toString() + "\n").toByteArray(), StandardOpenOption.CREATE, StandardOpenOption.APPEND)
        }
        client.run()
        assertTrue(held); assertFalse(tls.current); assertEquals(1, effects)
        assertFailsWith<DeviceFault> { savedFactory.createSocket() }
        val entries = DeviceDocument.parse(Files.readAllBytes(journal), 1048576, 32768).getValue("entries").jsonObject
        val declined = entries.values.single { it.jsonObject["result"]?.jsonObject?.get("error") == JsonPrimitive("authorization_changed") }
        assertEquals(JsonPrimitive("failed"), declined.jsonObject.getValue("result").jsonObject["status"])
        Files.write(directory.resolve("expiry-result.json"), buildJsonObject {
            put("passed", true); put("real_mqtt_mtls", true); put("real_wall_clock_expiry", true)
            put("connected_session_stopped", true); put("captured_tls_factory_refused", true)
            put("effects_before_expiry", effects); put("effects_after_expiry", 0); put("pending_attempt_preserved", true)
            put("application_port_fixture", true); put("native_app_runtime", false); put("hardware", false)
        }.toString().toByteArray())
    }
}
