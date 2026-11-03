package run.limeai.iot.device

import kotlinx.serialization.json.*
import org.eclipse.paho.mqttv5.client.*
import org.eclipse.paho.mqttv5.client.persist.MemoryPersistence
import org.eclipse.paho.mqttv5.common.MqttException
import org.eclipse.paho.mqttv5.common.MqttMessage
import org.eclipse.paho.mqttv5.common.packet.MqttProperties
import okio.ByteString.Companion.decodeBase64
import org.bouncycastle.asn1.pkcs.PrivateKeyInfo
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x500.style.BCStyle
import org.bouncycastle.asn1.x509.*
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
import org.bouncycastle.openssl.PEMKeyPair
import org.bouncycastle.openssl.PEMParser
import org.bouncycastle.openssl.jcajce.JcaPEMKeyConverter
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
import org.bouncycastle.operator.jcajce.JcaContentVerifierProviderBuilder
import org.bouncycastle.pkcs.PKCS10CertificationRequest
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.StringReader
import java.math.BigInteger
import java.net.InetAddress
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import java.security.*
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.Date
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.*
import kotlin.test.*

/** 仅用于测试：签名由JCA测试Provider委派，证明业务路径不要求私钥编码；不是安全元件。 */
class OpaqueEcPrivateKey(val delegate: PrivateKey) : PrivateKey {
    var encodingReads = 0
    override fun getAlgorithm() = "EC"
    override fun getFormat(): String? = null
    override fun getEncoded(): ByteArray? { encodingReads++; throw AssertionError("identity private key was exported") }
}

class OpaqueEcSignature : SignatureSpi() {
    private lateinit var signature: Signature
    override fun engineInitSign(privateKey: PrivateKey) {
        if (privateKey !is OpaqueEcPrivateKey) throw InvalidKeyException("requires the test key handle")
        signature = Signature.getInstance("SHA256withECDSA", "SunEC").apply { initSign(privateKey.delegate) }
    }
    override fun engineInitVerify(publicKey: PublicKey) { signature = Signature.getInstance("SHA256withECDSA", "SunEC").apply { initVerify(publicKey) } }
    override fun engineUpdate(b: Byte) { signature.update(b) }
    override fun engineUpdate(b: ByteArray, off: Int, len: Int) { signature.update(b, off, len) }
    override fun engineSign(): ByteArray = signature.sign()
    override fun engineVerify(sigBytes: ByteArray): Boolean = signature.verify(sigBytes)
    @Deprecated("SignatureSpi legacy API") override fun engineSetParameter(param: String?, value: Any?) { throw InvalidParameterException() }
    @Deprecated("SignatureSpi legacy API") override fun engineGetParameter(param: String?): Any? = throw InvalidParameterException()
}

class DeviceSigningKeyTest {
    private val identity = DeviceIdentity("space-demo", "device-lamp")
    private fun pair(curve: String = "secp256r1") = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec(curve)) }.generateKeyPair()
    private fun opaque(test: (DeviceSigningKey, OpaqueEcPrivateKey) -> Unit) {
        val provider = object : Provider("LimeIoTTestOpaqueEC", "1.0", "isolated test key handle") {
            init {
                put("Signature.SHA256withECDSA", OpaqueEcSignature::class.java.name)
                put("Signature.SHA256withECDSA SupportedKeyClasses", OpaqueEcPrivateKey::class.java.name)
            }
        }
        assertEquals(1, Security.insertProviderAt(provider, 1))
        try {
            val pair = pair(); val handle = OpaqueEcPrivateKey(pair.private)
            test(DeviceSigningKey.from(handle, pair.public), handle)
            assertEquals(0, handle.encodingReads)
        } finally { Security.removeProvider(provider.name) }
    }

    @Test fun csr_has_only_the_device_cn_and_a_valid_p256_signature_without_key_encoding() = opaque { key, _ ->
        val request = key.certificateRequest(identity)
        val der = request.pem.lineSequence().filter { !it.startsWith("-----") }.joinToString("").decodeBase64()!!.toByteArray()
        val csr = PKCS10CertificationRequest(der)
        assertEquals(1, csr.subject.rdNs.size)
        assertEquals(identity.device, csr.subject.getRDNs(BCStyle.CN).single().first.value.toString())
        assertEquals(0, csr.attributes.size)
        assertContentEquals(key.publicKey.encoded, csr.subjectPublicKeyInfo.encoded)
        assertTrue(csr.isSignatureValid(JcaContentVerifierProviderBuilder().build(key.publicKey)))
        assertEquals(DeviceSigningKey.fingerprint(der), request.csrSha256)
        assertEquals(key.publicKeyFingerprint, request.publicKeyFingerprint)
        assertFalse(request.pem.contains("PRIVATE KEY"))
    }

    @Test fun mismatched_keys_and_non_p256_requests_are_rejected() {
        val pair = pair()
        assertEquals("invalid_identity_key", assertFailsWith<DeviceFault> { DeviceSigningKey.from(pair.private, pair().public) }.code)
        val rsa = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        assertFailsWith<DeviceFault> { DeviceSigningKey.from(rsa.private, rsa.public) }
        val otherCurve = pair("secp384r1")
        assertFailsWith<DeviceFault> { DeviceSigningKey.from(otherCurve.private, otherCurve.public).certificateRequest(identity) }
    }

    @Test fun durable_csr_restores_original_bytes_and_rejects_different_identity_key_or_signature() = opaque { key, _ ->
        val original = key.certificateRequest(identity)
        val restored = key.restoreCertificateRequest(identity, original.pem)
        assertEquals(original.pem, restored.pem); assertEquals(original.csrSha256, restored.csrSha256)
        assertEquals(original.publicKeyFingerprint, restored.publicKeyFingerprint)
        assertFailsWith<DeviceFault> { key.restoreCertificateRequest(DeviceIdentity(identity.space, "other-device"), original.pem) }
        val another = pair().let { DeviceSigningKey.from(it.private, it.public) }
        assertFailsWith<DeviceFault> { another.restoreCertificateRequest(identity, original.pem) }
        assertFailsWith<DeviceFault> { key.restoreCertificateRequest(identity, original.pem + original.pem) }
        val encoded = original.pem.lineSequence().filter { !it.startsWith("-----") }.joinToString("").decodeBase64()!!.toByteArray()
        encoded[encoded.lastIndex] = (encoded.last().toInt() xor 1).toByte()
        val changed = "-----BEGIN CERTIFICATE REQUEST-----\n" + java.util.Base64.getMimeEncoder(64, byteArrayOf(10)).encodeToString(encoded) + "\n-----END CERTIFICATE REQUEST-----\n"
        assertFailsWith<DeviceFault> { key.restoreCertificateRequest(identity, changed) }
    }

    private class Certificates {
        val caKey = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val ca = certificate(caKey.public, "LimeIoT isolated CA", ca = true)
        val serverKey = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val server = certificate(serverKey.public, "server", purpose = KeyPurposeId.id_kp_serverAuth)
        fun certificate(publicKey: PublicKey, cn: String, ca: Boolean = false, purpose: KeyPurposeId = KeyPurposeId.id_kp_clientAuth,
                        from: Long = System.currentTimeMillis() - 60000, until: Long = System.currentTimeMillis() + 3600000): X509Certificate {
            val builder = JcaX509v3CertificateBuilder(X500Name("CN=LimeIoT isolated CA"), BigInteger(120, SecureRandom()),
                Date(from), Date(until), X500Name("CN=$cn"), publicKey)
                .addExtension(Extension.basicConstraints, true, BasicConstraints(ca))
                .addExtension(Extension.keyUsage, true, KeyUsage(if (ca) KeyUsage.keyCertSign or KeyUsage.cRLSign else KeyUsage.digitalSignature))
            if (!ca) builder.addExtension(Extension.extendedKeyUsage, false, ExtendedKeyUsage(purpose))
            if (purpose == KeyPurposeId.id_kp_serverAuth) builder.addExtension(Extension.subjectAlternativeName, false,
                GeneralNames(GeneralName(GeneralName.iPAddress, "127.0.0.1")))
            return JcaX509CertificateConverter().getCertificate(builder.build(JcaContentSignerBuilder("SHA256withECDSA").build(caKey.private)))
        }
    }
    private fun pem(certificate: X509Certificate) = ("-----BEGIN CERTIFICATE-----\n" +
        java.util.Base64.getMimeEncoder(64, byteArrayOf(10)).encodeToString(certificate.encoded) + "\n-----END CERTIFICATE-----\n").toByteArray()

    private fun server(ca: X509Certificate, leaf: X509Certificate, key: PrivateKey): SSLContext {
        val keys = KeyStore.getInstance("PKCS12").apply { load(null, null); setKeyEntry("server", key, charArrayOf(), arrayOf(leaf, ca)) }
        val managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(keys, charArrayOf()) }
        val trust = KeyStore.getInstance("PKCS12").apply { load(null, null); setCertificateEntry("client-ca", ca) }
        val trusted = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(trust) }
        return SSLContext.getInstance("TLSv1.2").apply { init(managers.keyManagers, trusted.trustManagers, SecureRandom()) }
    }

    /** 双向握手并交换应用字节，服务端独立核对设备证书；有界等待，不以建Socket当握手成功。 */
    private fun exchange(tls: DeviceTls, server: SSLContext, host: String = "127.0.0.1") {
        val listener = server.serverSocketFactory.createServerSocket(0, 1, InetAddress.getByName("127.0.0.1")) as SSLServerSocket
        listener.needClientAuth = true; listener.enabledProtocols = arrayOf("TLSv1.2"); listener.soTimeout = 5000
        val executor = Executors.newSingleThreadExecutor()
        val accepted = executor.submit {
            (listener.accept() as SSLSocket).use {
                it.soTimeout = 5000; it.startHandshake()
                assertEquals("CN=${identity.device}", (it.session.peerCertificates.first() as X509Certificate).subjectX500Principal.name)
                assertEquals(42, it.inputStream.read()); it.outputStream.write(43); it.outputStream.flush()
            }
        }
        try {
            (tls.socketFactory.createSocket(host, listener.localPort) as SSLSocket).use {
                it.soTimeout = 5000; it.enabledProtocols = arrayOf("TLSv1.2")
                it.sslParameters = it.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
                it.startHandshake(); it.outputStream.write(42); it.outputStream.flush(); assertEquals(43, it.inputStream.read())
            }
            accepted.get(10, TimeUnit.SECONDS)
        } finally { listener.close(); executor.shutdownNow(); assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS)) }
    }

    @Test fun opaque_handle_completes_mtls_and_does_not_disable_server_hostname_or_ca_validation() = opaque { key, _ ->
        val certificates = Certificates()
        val client = certificates.certificate(key.publicKey, identity.device)
        val tls = DeviceTls.create(identity, pem(certificates.ca), pem(client), key)
        val server = server(certificates.ca, certificates.server, certificates.serverKey.private)
        exchange(tls, server)
        assertFailsWith<SSLException> { exchange(tls, server, "localhost") }
        val foreign = Certificates()
        assertFailsWith<SSLException> { exchange(tls, server(foreign.ca, foreign.server, foreign.serverKey.private)) }
    }

    @Test fun native_key_path_rejects_wrong_device_ca_key_usage_and_certificate_time() = opaque { key, _ ->
        val certificates = Certificates()
        val client = certificates.certificate(key.publicKey, identity.device)
        assertFailsWith<DeviceFault> { DeviceTls.create(DeviceIdentity(identity.space, "other"), pem(certificates.ca), pem(client), key) }
        assertFailsWith<DeviceFault> { DeviceTls.create(identity, pem(Certificates().ca), pem(client), key) }
        assertFailsWith<DeviceFault> { DeviceTls.create(identity, pem(certificates.ca), pem(certificates.certificate(pair().public, identity.device)), key) }
        for (bad in listOf(
            certificates.certificate(key.publicKey, identity.device, ca = true),
            certificates.certificate(key.publicKey, identity.device, purpose = KeyPurposeId.id_kp_serverAuth),
            certificates.certificate(key.publicKey, identity.device, from = 0, until = 100000),
            certificates.certificate(key.publicKey, identity.device, from = System.currentTimeMillis() + 3600000, until = System.currentTimeMillis() + 7200000),
        )) assertEquals("invalid_credentials", assertFailsWith<DeviceFault> { DeviceTls.create(identity, pem(certificates.ca), pem(bad), key) }.code)
    }

    @Test fun actual_expiry_blocks_cached_tls_and_an_effect_after_its_durable_attempt() = opaque { key, _ ->
        val certificates = Certificates()
        val leaf = certificates.certificate(key.publicKey, identity.device, until = System.currentTimeMillis() + 3000)
        val tls = DeviceTls.create(identity, pem(certificates.ca), pem(leaf), key)
        val cachedFactory = tls.socketFactory
        var bytes: ByteArray? = null
        var writes = 0
        var effects = 0
        val storage = object : DeviceStorage {
            override fun read() = bytes?.copyOf()
            override fun commit(value: ByteArray) {
                bytes = value.copyOf(); writes++
                if (writes == 3) {
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(4)
                    while (System.currentTimeMillis() < leaf.notAfter.time && System.nanoTime() < deadline) Thread.sleep(10)
                    assertFalse(tls.current, "certificate must actually expire before the second effect gate")
                }
            }
        }
        val applications = object : ApplicationPort {
            override fun permitted(application: String) = true
            override fun submit(application: String) { effects++ }
        }
        val clock = object : DeviceClock { override fun elapsedMillis() = System.nanoTime() / 1000000 }
        val agent = DeviceAgent(identity, storage, applications, clock) { tls.current }
        fun envelope(kind: String, body: JsonObject, id: String = "validity-message") = obj(
            "v" to JsonPrimitive(1), "kind" to text(kind), "message_id" to text(id), "device_id" to text(identity.device),
            "model_revision" to text(identity.profile.revision), "session_id" to text("validity-session"), "body" to body)
        val challenge = DeviceDocument.parse(agent.connected().payload).getValue("body").obj().text("challenge")
        val issued = java.time.Instant.ofEpochMilli(System.currentTimeMillis())
        agent.receive("limeiot/v1/${identity.space}/${identity.device}/down/welcome", envelope("welcome", obj(
            "challenge" to text(challenge), "time" to text(issued.toString()), "max_packet_bytes" to JsonPrimitive(16384),
            "receipt_ledger" to JsonPrimitive(1), "command_sequence" to JsonPrimitive(0))).toString().toByteArray())
        fun command(sequence: Int): JsonObject {
            val id = "c1-$sequence-00000000-0000-4000-8000-000000000001"
            return envelope("command", obj("command_id" to text(id), "issued_at" to text(issued.toString()),
                "expires_at" to text(issued.plusSeconds(20).toString()), "operation" to obj("type" to text("action.invoke"),
                    "path" to text("apps.launch"), "value" to obj("application_id" to text("com.example.player")))), id)
        }
        fun execute(sequence: Int) = DeviceDocument.parse(agent.receive("limeiot/v1/${identity.space}/${identity.device}/down/command", command(sequence).toString().toByteArray()).single().payload).getValue("body").obj()
        assertEquals("confirmed", execute(1).text("status")); assertEquals(1, effects)
        assertEquals("authorization_changed", execute(2).text("error")); assertEquals(1, effects)
        assertEquals(4, writes); assertEquals(2, DeviceDocument.parse(bytes!!, 1048576, 32768).getValue("entries").obj().size)
        assertEquals("invalid_credentials", assertFailsWith<DeviceFault> { tls.requireCurrent() }.code)
        assertFailsWith<DeviceFault> { cachedFactory.createSocket() }
        assertFailsWith<DeviceFault> { cachedFactory.createSocket("127.0.0.1", 1) }
        assertFailsWith<DeviceFault> { cachedFactory.createSocket(InetAddress.getLoopbackAddress(), 1) }
        val statuses = mutableListOf<String>()
        DeviceMqtt(identity, "ssl://127.0.0.1:1", tls, storage, applications, clock, statuses::add).use { it.run() }
        assertEquals(listOf("invalid_credentials"), statuses); assertEquals(1, effects)
    }

    @Test fun connected_mqtt_stops_at_actual_certificate_expiry_without_another_application_effect() {
        val rootValue = System.getenv("LIMEIOT_TV_AGENT_IDENTITY_ROOT")
        assumeTrue(rootValue != null, "requires the isolated Broker executable")
        val root = Path.of(rootValue!!)
        val work = Files.createTempDirectory(root.resolve(".dev"), "tv-mqtt-expiry-", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")))
        val certificates = Certificates(); val pair = pair(); val key = DeviceSigningKey.from(pair.private, pair.public)
        Files.write(work.resolve("ca.crt"), pem(certificates.ca)); Files.write(work.resolve("server.crt"), pem(certificates.server))
        Files.writeString(work.resolve("server.key"), "-----BEGIN PRIVATE KEY-----\n" + java.util.Base64.getMimeEncoder(64, byteArrayOf(10)).encodeToString(certificates.serverKey.private.encoded) + "\n-----END PRIVATE KEY-----\n")
        val port = java.net.ServerSocket(0).use { it.localPort }
        val config = work.resolve("mosquitto.conf")
        Files.writeString(config, "listener $port 127.0.0.1\ncafile ${work.resolve("ca.crt")}\ncertfile ${work.resolve("server.crt")}\nkeyfile ${work.resolve("server.key")}\nrequire_certificate true\nallow_anonymous true\npersistence false\n")
        val brokerLog = work.resolve("broker.log")
        val broker = ProcessBuilder(root.resolve(".dev/tools/mosquitto-build/src/mosquitto").toString(), "-c", config.toString()).redirectErrorStream(true).redirectOutput(brokerLog.toFile()).start()
        val controller = MqttClient("ssl://127.0.0.1:$port", "expiry-observer", MemoryPersistence())
        val publications = LinkedBlockingQueue<ByteArray>()
        controller.setTimeToWait(5000)
        controller.setCallback(object : MqttCallback {
            override fun disconnected(response: MqttDisconnectResponse) {}
            override fun mqttErrorOccurred(exception: MqttException) {}
            override fun messageArrived(topic: String, message: MqttMessage) { publications.offer(message.payload.copyOf()) }
            override fun deliveryComplete(token: IMqttToken) {}
            override fun connectComplete(reconnect: Boolean, serverURI: String) {}
            override fun authPacketArrived(reasonCode: Int, properties: MqttProperties) {}
        })
        val executor = Executors.newSingleThreadExecutor()
        val effects = AtomicInteger(); val writes = AtomicInteger(); val journal = AtomicReference<ByteArray?>()
        val statuses = LinkedBlockingQueue<String>()
        var transport: DeviceMqtt? = null
        try {
            val startupDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (broker.isAlive && System.nanoTime() < startupDeadline && !Files.readString(brokerLog).contains(" running")) Thread.sleep(20)
            assertTrue(broker.isAlive && Files.readString(brokerLog).contains(" running"))
            val controllerTls = DeviceTls.create(identity, pem(certificates.ca), pem(certificates.certificate(key.publicKey, identity.device)), key)
            controller.connect(MqttConnectionOptions().apply { socketFactory = controllerTls.socketFactory; connectionTimeout = 5; isAutomaticReconnect = false })
            val base = "limeiot/v1/${identity.space}/${identity.device}"
            controller.subscribe("$base/up/+", 1)
            val leaf = certificates.certificate(key.publicKey, identity.device, until = System.currentTimeMillis() + 5000)
            val tls = DeviceTls.create(identity, pem(certificates.ca), pem(leaf), key)
            val storage = object : DeviceStorage {
                override fun read() = journal.get()?.copyOf()
                override fun commit(bytes: ByteArray) {
                    journal.set(bytes.copyOf())
                    if (writes.incrementAndGet() == 3) {
                        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                        while (tls.current && System.nanoTime() < deadline) Thread.sleep(10)
                        assertFalse(tls.current)
                    }
                }
            }
            val applications = object : ApplicationPort {
                override fun permitted(application: String) = true
                override fun submit(application: String) { effects.incrementAndGet() }
            }
            transport = DeviceMqtt(identity, "ssl://127.0.0.1:$port", tls, storage, applications, object : DeviceClock { override fun elapsedMillis() = System.nanoTime() / 1000000 }, { statuses.offer(it) })
            val active = transport
            val worker = executor.submit { active.run() }
            fun receive(kind: String): JsonObject {
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                while (System.nanoTime() < deadline) {
                    val bytes = publications.poll(100, TimeUnit.MILLISECONDS) ?: continue
                    val value = DeviceDocument.parse(bytes)
                    if (value.text("kind") == kind) return value
                }
                fail("missing MQTT $kind; see isolated Broker log")
            }
            val hello = receive("hello"); val issued = java.time.Instant.ofEpochMilli(System.currentTimeMillis())
            fun send(kind: String, body: JsonObject, id: String = "expiry-message") {
                val value = obj("v" to JsonPrimitive(1), "kind" to text(kind), "message_id" to text(id), "device_id" to text(identity.device),
                    "model_revision" to text(identity.profile.revision), "session_id" to text("expiry-session"), "body" to body)
                controller.publish("$base/down/$kind", value.toString().toByteArray(), 1, false)
            }
            send("welcome", obj("challenge" to hello.getValue("body").obj().getValue("challenge"), "time" to text(issued.toString()),
                "max_packet_bytes" to JsonPrimitive(16384), "receipt_ledger" to JsonPrimitive(1), "command_sequence" to JsonPrimitive(0)))
            receive("state")
            fun command(sequence: Int) {
                val id = "c1-$sequence-00000000-0000-4000-8000-000000000001"
                send("command", obj("command_id" to text(id), "issued_at" to text(issued.toString()), "expires_at" to text(issued.plusSeconds(20).toString()),
                    "operation" to obj("type" to text("action.invoke"), "path" to text("apps.launch"), "value" to obj("application_id" to text("com.example.player")))), id)
            }
            command(1); assertEquals("confirmed", receive("result").getValue("body").obj().text("status")); assertEquals(1, effects.get())
            command(2); worker.get(8, TimeUnit.SECONDS)
            assertFalse(tls.current); assertEquals(1, effects.get()); assertEquals(4, writes.get()); assertTrue("invalid_credentials" in statuses)
            val result = DeviceDocument.parse(journal.get()!!, 1048576, 32768).getValue("entries").obj().values.last().obj().getValue("result").obj()
            assertEquals("authorization_changed", result.text("error"))
            command(3); assertEquals(1, effects.get()); assertEquals(4, writes.get())
            Files.writeString(work.resolve("result.json"), obj("passed" to JsonPrimitive(true), "actual_mtls_broker" to JsonPrimitive(true), "expired_connected_transport_stopped" to JsonPrimitive(true),
                "effects" to JsonPrimitive(effects.get()), "durable_writes" to JsonPrimitive(writes.get()), "hardware" to JsonPrimitive(false)).toString() + "\n")
        } finally {
            transport?.close(); executor.shutdownNow(); assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS))
            try { controller.disconnectForcibly(0, 1000, false) } catch (_: Exception) {}
            try { controller.close(true) } catch (_: Exception) {}
            broker.destroy(); if (!broker.waitFor(5, TimeUnit.SECONDS)) { broker.destroyForcibly(); assertTrue(broker.waitFor(5, TimeUnit.SECONDS)) }
        }
    }

    @Test fun public_csr_roundtrips_the_actual_nas_issuer_and_then_uses_the_same_opaque_key_for_mtls() {
        val rootEnv = System.getenv("LIMEIOT_TV_AGENT_IDENTITY_ROOT")
        assumeTrue(rootEnv != null, "requires explicit isolated NAS CSR environment")
        val root = Path.of(rootEnv!!)
        val python = System.getenv("LIMEIOT_TV_AGENT_IDENTITY_PYTHON") ?: root.resolve(".dev/firmware-tools/venv/bin/python").toString()
        val directory = Files.createTempDirectory(root.resolve(".dev"), "tv-key-csr-", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")))
        val nas = directory.resolve("nas")
        fun run(vararg args: String): JsonObject {
            val process = ProcessBuilder(python, *args).directory(root.toFile()).redirectError(directory.resolve("last-stderr.log").toFile()).start()
            if (!process.waitFor(20, TimeUnit.SECONDS)) { process.destroyForcibly(); fail("management command timed out") }
            val bytes = process.inputStream.readBytes()
            assertEquals(0, process.exitValue(), "management command failed; see isolated fixture logs")
            return DeviceDocument.parse(bytes, 65536)
        }
        run("deploy/nas/manage.py", "init", "--directory", nas.toString(), "--origin", "https://127.0.0.1:18443")
        opaque { key, _ ->
            val request = key.certificateRequest(identity)
            val csr = directory.resolve("request.csr"); Files.write(csr, request.pem.toByteArray())
            fun management(action: String, vararg flags: String) = run("deploy/nas/device_identity.py", action, "--directory", nas.toString(), *flags)
            val inspected = management("inspect-csr", "--device-id", identity.device, "--csr", csr.toString())
            assertEquals(request.csrSha256, inspected.text("csr_sha256")); assertEquals(key.publicKeyFingerprint, inspected.text("public_key_fingerprint"))
            val output = directory.resolve("public-identity")
            val issued = management("sign-csr", "--device-id", identity.device, "--csr", csr.toString(), "--public-key-fingerprint", key.publicKeyFingerprint,
                "--request-id", "tv-key-contract", "--output", output.toString())
            assertEquals("issued", issued.text("decision")); assertEquals(request.csrSha256, issued.text("csr_sha256"))
            assertEquals(issued.text("certificate_sha256"), management("resolve-csr", "--request-id", "tv-key-contract").text("certificate_sha256"))
            assertEquals(setOf("request.csr", "device.crt", "ca.crt", "enrollment.json"), Files.list(output).use { it.map { path -> path.fileName.toString() }.toList().toSet() })
            fun cert(path: Path) = Files.newInputStream(path).use { CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate }
            val serverKey = PEMParser(StringReader(Files.readString(nas.resolve("broker-tls/server.key")))).use {
                val parsed = it.readObject()
                JcaPEMKeyConverter().getPrivateKey(if (parsed is PEMKeyPair) parsed.privateKeyInfo else parsed as PrivateKeyInfo)
            }
            val tls = DeviceTls.create(identity, Files.readAllBytes(output.resolve("ca.crt")), Files.readAllBytes(output.resolve("device.crt")), key)
            exchange(tls, server(cert(output.resolve("ca.crt")), cert(nas.resolve("broker-tls/server.crt")), serverKey))
            Files.writeString(directory.resolve("result.json"), obj("passed" to JsonPrimitive(true), "csr_sha256" to text(request.csrSha256),
                "certificate_sha256" to issued.getValue("certificate_sha256"), "real_nas_csr_signing" to JsonPrimitive(true), "actual_mtls" to JsonPrimitive(true),
                "private_key_encoding_reads" to JsonPrimitive(0), "host_key_handle_fixture" to JsonPrimitive(true), "android_keystore" to JsonPrimitive(false), "hardware" to JsonPrimitive(false)).toString()+"\n")
        }
    }
}
