package run.limeai.iot.device

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.net.Socket
import java.net.URI
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.*

/** 真实 TLS/Broker/Rust 联调由根目录 test:tv-agent 配置；文件硬件只作为夹具。 */
class MqttJourneyTest {
    @Test fun actual_mtls_protocol_device_journal_and_process_restart() {
        val env = System.getenv()
        assumeTrue(env["LIMEIOT_TV_AGENT_JOURNEY"] == "1", "requires the isolated MQTT/TLS journey")
        val directory = Path.of(env.getValue("LIMEIOT_TV_AGENT_DIRECTORY"))
        fun bytes(name: String) = Files.readAllBytes(directory.resolve("credentials").resolve(name))
        val enrolled = DeviceEnrollment.parse(bytes("enrollment.json"))
        val identity = enrolled.identity
        assertEquals(DeviceIdentity("space-demo", "device-lamp", DeviceModelProfile.parse(env["LIMEIOT_TV_AGENT_PROFILE"] ?: "android-tv-agent")), identity)
        assertEquals(env.getValue("LIMEIOT_TV_AGENT_BROKER"), enrolled.broker)
        assertEquals(enrolled.binding, DeviceEnrollment.parse(enrolled.encoded()).binding)
        assertTrue(enrolled.caFingerprint.startsWith("sha256:") && enrolled.caFingerprint.length == 71)
        val tls = enrolled.tls()
        assertFailsWith<DeviceFault> { DeviceTls.create(DeviceIdentity("space-demo", "other"), bytes("ca.crt"), bytes("device.crt"), bytes("private.key")) }
        assertFailsWith<DeviceFault> { DeviceTls.create(identity, bytes("ca.crt"), bytes("device.crt"), Files.readAllBytes(directory.resolve("device-authority/ca.key"))) }
        assertFailsWith<DeviceFault> { DeviceMqtt(identity, "tcp://127.0.0.1:1883", tls, object : DeviceStorage { override fun read(): ByteArray? = null; override fun commit(bytes: ByteArray) {} }, object : ApplicationPort { override fun permitted(application: String) = false; override fun submit(application: String) {} }, object : DeviceClock { override fun elapsedMillis() = 0L }) }
        val journal = directory.resolve("journal.json")
        val storage = object : DeviceStorage {
            override fun read(): ByteArray? = if (Files.exists(journal)) Files.readAllBytes(journal) else null
            override fun commit(bytes: ByteArray) {
                val next = directory.resolve("journal.next")
                FileChannel.open(next, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE).use { channel ->
                    val buffer = ByteBuffer.wrap(bytes)
                    while (buffer.hasRemaining()) channel.write(buffer)
                    channel.force(true)
                }
                Files.move(next, journal, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
                FileChannel.open(directory, StandardOpenOption.READ).use { it.force(true) }
                // 冻结首份结果已耐久但尚未收到确认的设备快照。
                val entries = DeviceDocument.parse(bytes, 1048576, 32768).getValue("entries").obj()
                if (entries.values.any { it.obj()["result"]?.takeUnless { result -> result == JsonNull }?.obj()?.text("status") == "confirmed" }
                    && !Files.exists(directory.resolve("unacknowledged.json"))) {
                    Files.write(directory.resolve("unacknowledged.json"), bytes, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
                }
            }
        }
        // 快照版本由本轮实际网关在任何副作用前确定；不能把历史v9写死在设备夹具。
        val gatewayVersion = env["LIMEIOT_TV_AGENT_GATEWAY_DATABASE"]?.let { database ->
            val query = "import sys,sqlite3\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\nprint(c.execute('SELECT version FROM snapshot').fetchone()[0])"
            val check = ProcessBuilder("python3", "-c", query, database).redirectErrorStream(true).start()
            val version = check.inputStream.readBytes().toString(Charsets.UTF_8).trim()
            assertEquals(0, check.waitFor()); version.toInt().also { assertTrue(it > 0) }
        }
        fun beforeEffect(path: String, input: JsonObject) {
            val entries = DeviceDocument.parse(Files.readAllBytes(journal), 1048576, 32768).getValue("entries").obj()
            val attempted = entries.values.filter { it.obj()["result"] == JsonNull }.maxBy { commandSequence(it.obj().getValue("command").obj().getValue("body").obj().text("command_id")) ?: 0L }.obj()
            val command = attempted.getValue("command").obj()
            val operation = command.getValue("body").obj().getValue("operation").obj()
            assertEquals(path, operation.text("path")); assertEquals(input, operation.getValue("value"))
            env["LIMEIOT_TV_AGENT_GATEWAY_DATABASE"]?.let { database ->
                val query = "import sys,json,sqlite3\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\nv,b=c.execute('SELECT version,body FROM snapshot').fetchone()\ns=json.loads(b);x=s['commands'][sys.argv[2]];p=s['execution_registry']['bindings'][x['request']['device_id']]\nassert v==int(sys.argv[4]) and x['status']=='dispatched' and x.get('execution_route') is None and p['native_paths']==json.loads(sys.argv[3])\nprint(json.dumps({'command_id':sys.argv[2],'gateway_dispatched_before_effect':True,'snapshot_version':v}))"
                val paths = JsonArray(identity.profile.nativePaths.sorted().map(::text)).toString()
                val check = ProcessBuilder("python3", "-c", query, database, command.getValue("body").obj().text("command_id"), paths, gatewayVersion.toString()).redirectErrorStream(true).start()
                val proof = check.inputStream.readBytes(); assertEquals(0, check.waitFor(), "gateway durable attempt must precede native effect: ${proof.toString(Charsets.UTF_8)}")
                Files.write(directory.resolve("gateway-durable.jsonl"), proof, StandardOpenOption.CREATE, StandardOpenOption.APPEND)
            }
            val effect = JsonObject(input + obj("path" to text(path), "command_id" to command.getValue("body").obj().getValue("command_id"), "attempt_durable" to JsonPrimitive(true)))
            Files.write(directory.resolve("effects.jsonl"), (effect.toString()+"\n").toByteArray(), StandardOpenOption.CREATE, StandardOpenOption.APPEND)
        }
        val applications = object : ApplicationPort {
            override fun permitted(application: String) = application == "com.example.player"
            override fun submit(application: String) {
                beforeEffect("apps.launch", obj("application_id" to text(application)))
                if (env["LIMEIOT_TV_AGENT_EFFECT_UNKNOWN"] == "1") throw IllegalStateException("fixture: effect started but outcome lost")
            }
        }
        val audio = if (identity.profile.hasAudio) FileAudioFixture(directory, ::beforeEffect) else null
        val clock = object : DeviceClock { override fun elapsedMillis() = System.nanoTime() / 1000000 }
        if (env["LIMEIOT_TV_AGENT_PROBE_HOSTNAME"] == "1") {
            // 先证明同一监听端口可达，再验证生产传输拒绝证书SAN之外的主机。
            val port = URI(env.getValue("LIMEIOT_TV_AGENT_BROKER")).port
            Socket("localhost", port).use { assertTrue(it.isConnected) }
            val probeStatus = AtomicReference("")
            val probe = DeviceMqtt(identity, "ssl://localhost:$port", tls, storage, applications, clock) { probeStatus.set(it) }
            val probeThread = Thread { probe.run() }; probeThread.start()
            try {
                val deadline = System.nanoTime() + 10000000000L
                while (probeStatus.get() !in setOf("ready", "connection_unavailable") && System.nanoTime() < deadline && probeThread.isAlive) Thread.sleep(20)
                assertEquals("connection_unavailable", probeStatus.get(), "wrong hostname must fail before hello")
            } finally { probe.close(); probeThread.join(10000) }
            assertFalse(probeThread.isAlive)
        }
        val lastStatus = AtomicReference("")
        val client = DeviceMqtt(identity, env.getValue("LIMEIOT_TV_AGENT_BROKER"), tls, storage, applications, clock, audio) { lastStatus.set(it) }
        val thread = Thread({ client.run() }, "tv-agent-journey")
        thread.start()
        try {
            val end = System.nanoTime() + 60000000000L
            while (!Files.exists(directory.resolve("stop")) && System.nanoTime() < end && thread.isAlive) Thread.sleep(50)
            assertTrue(Files.exists(directory.resolve("stop")), "journey did not complete: ${lastStatus.get()}")
        } finally { client.close(); thread.join(10000) }
        assertFalse(thread.isAlive, "MQTT worker must stop")
        assertEquals("stopped", lastStatus.get())
    }
}
