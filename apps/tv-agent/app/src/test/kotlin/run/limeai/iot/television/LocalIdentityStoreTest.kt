package run.limeai.iot.television

import android.app.Application
import android.database.sqlite.SQLiteDatabase
import kotlinx.serialization.json.*
import org.junit.Test
import org.junit.Assume.assumeTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import run.limeai.iot.device.*
import java.nio.file.Files
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.security.KeyFactory
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import java.net.InetAddress
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.*
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import kotlin.test.*

/** 真实宿主EC/SQLite及离线签发；不将替身视为AndroidKeyStore或电视系统证据。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class LocalIdentityStoreTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val vault = TestVault()
    private val keys = TestKeys()
    private fun store() = AndroidAgentStore(context, vault, keys)
    private fun database() = SQLiteDatabase.openDatabase(context.getDatabasePath("tv-agent.db").path, null, SQLiteDatabase.OPEN_READWRITE)
    private fun setup(request: String = "request-one", broker: String = "ssl://localhost:8883") = IdentityFixtures.setup(request, broker)
    private fun agentCount(): Long = database().use { db -> db.rawQuery("SELECT count(*) FROM agent", null).use { it.moveToFirst(); it.getLong(0) } }
    private fun document(): ByteArray = database().use { db -> db.rawQuery("SELECT document FROM identity WHERE slot=1", null).use { assertTrue(it.moveToFirst()); it.getBlob(0) } }
    private fun frozen(store: AndroidAgentStore) = assertEquals("storage_reopen_required", assertFailsWith<AgentStoreFault> { store.load() }.code)
    private fun activate(store: AndroidAgentStore): DeviceEnrollment {
        val request = store.requestIdentity(setup()).request!!
        val enrollment = store.previewCertificate(IdentityFixtures.sign(request.pem))
        store.activateIdentity(enrollment)
        return enrollment
    }

    @Test fun pending_request_reopens_with_identical_csr_and_rejects_conflicts_or_legacy_override() {
        val first = store().use { storage ->
            val view = storage.requestIdentity(setup())
            assertEquals("pending", view.phase); assertNull(storage.load()); assertEquals(1, keys.creates)
            assertEquals("identity_request_conflict", assertFailsWith<AgentStoreFault> { storage.requestIdentity(setup("another-request")) }.code)
            assertFails { storage.requestIdentity(setup(broker = "ssl://other-host:8883")) }
            assertEquals("identity_request_required", assertFailsWith<AgentStoreFault> { storage.install(IdentityFixtures.legacy()) }.code)
            assertEquals(view.request!!.pem, storage.requestIdentity(setup()).request!!.pem)
            view.request!!
        }
        store().use { storage ->
            val restored = storage.requestIdentity(setup()).request!!
            assertEquals(first.pem, restored.pem); assertEquals(first.csrSha256, restored.csrSha256)
            assertEquals(first.publicKeyFingerprint, restored.publicKeyFingerprint); assertEquals(1, keys.creates)
        }
    }

    @Test fun intent_failure_is_zero_key_creation_and_freezes_until_reopen() {
        vault.failSealPhase = "prepared"
        store().use { storage -> assertFails { storage.requestIdentity(setup()) }; frozen(storage); assertEquals(0, keys.creates) }
        vault.failSealPhase = null
        store().use { assertNull(it.identityRequest()); assertEquals("pending", it.requestIdentity(setup()).phase) }
        assertEquals(1, keys.creates)
    }

    @Test fun creation_intent_failure_preserves_prepared_and_never_creates_before_commit() {
        vault.failSealPhase = "creating"
        store().use { storage -> assertFails { storage.requestIdentity(setup()) }; frozen(storage); assertEquals(0, keys.creates) }
        vault.failSealPhase = null
        store().use { assertEquals("prepared", it.identityRequest()!!.phase); assertEquals("pending", it.requestIdentity(setup()).phase) }
        assertEquals(1, keys.creates)
    }

    @Test fun successful_key_creation_with_lost_response_restores_same_key() {
        keys.failAfterCreate = true
        store().use { storage -> assertFails { storage.requestIdentity(setup()) }; frozen(storage) }
        keys.failAfterCreate = false
        store().use { assertEquals("creating", it.identityRequest()!!.phase); assertEquals("pending", it.requestIdentity(setup()).phase) }
        assertEquals(1, keys.creates); assertEquals(1, keys.pairs.size)
    }

    @Test fun interrupted_creation_without_key_never_recreates_on_recovery() {
        keys.failBeforeCreate = true
        store().use { assertFails { it.requestIdentity(setup()) } }
        keys.failBeforeCreate = false
        val before = document()
        repeat(2) { store().use { storage ->
            assertEquals("creating", storage.identityRequest()!!.phase)
            assertEquals("identity_key_unavailable", assertFailsWith<AgentStoreFault> { storage.requestIdentity(setup()) }.code)
            frozen(storage)
        } }
        assertEquals(0, keys.creates); assertContentEquals(before, document())
    }

    @Test fun pending_write_failure_restores_existing_key_instead_of_creating_another() {
        vault.failSealPhase = "pending"
        store().use { storage -> assertFails { storage.requestIdentity(setup()) }; frozen(storage) }
        assertEquals(1, keys.creates)
        vault.failSealPhase = null
        store().use { assertEquals("creating", it.identityRequest()!!.phase); assertEquals("pending", it.requestIdentity(setup()).phase) }
        assertEquals(1, keys.creates)
    }

    @Test fun committed_pending_with_failed_readback_is_restored_byte_for_byte() {
        vault.failPendingReadback = true
        store().use { storage -> assertFails { storage.requestIdentity(setup()) }; frozen(storage) }
        val expected = vault.lastPendingCsr
        store().use { storage -> assertEquals(expected, storage.requestIdentity(setup()).request!!.pem) }
        assertEquals(1, keys.creates)
    }

    @Test fun certificate_rejections_are_zero_write_and_do_not_poison_valid_request() {
        store().use { storage ->
            val csr = storage.requestIdentity(setup()).request!!.pem
            val valid = IdentityFixtures.sign(csr)
            val wrongKey = IdentityFixtures.legacy().let { DeviceDocument.parse(it.encoded())["certificate_pem"]!!.jsonPrimitive.content.toByteArray() }
            val before = document()
            for (invalid in listOf(wrongKey, valid + valid, IdentityFixtures.sign(csr, usage = "serverAuth"),
                IdentityFixtures.sign(csr, subject = "other-device"), IdentityFixtures.sign(csr, expired = true), IdentityFixtures.sign(csr, foreignCa = true),
                "not-a-certificate".toByteArray(), ByteArray(4097))) {
                assertFails { storage.previewCertificate(invalid) }
                assertEquals(0, agentCount()); assertContentEquals(before, document())
            }
            storage.activateIdentity(storage.previewCertificate(valid))
            assertNotNull(storage.load()); assertEquals("active", storage.identityRequest()!!.phase)
        }
    }

    @Test fun credential_and_active_record_rollback_together_and_reopen_keeps_original_request() {
        val csr = store().use { it.requestIdentity(setup()).request!!.pem }
        val certificate = IdentityFixtures.sign(csr)
        val before = document()
        database().use { it.execSQL("CREATE TRIGGER fail_active BEFORE UPDATE ON identity BEGIN SELECT RAISE(ABORT,'injected'); END") }
        store().use { storage -> assertFails { storage.activateIdentity(storage.previewCertificate(certificate)) }; frozen(storage) }
        assertEquals(0, agentCount()); assertContentEquals(before, document())
        database().use { it.execSQL("DROP TRIGGER fail_active") }
        store().use { storage ->
            assertEquals(csr, storage.identityRequest()!!.request!!.pem)
            storage.activateIdentity(storage.previewCertificate(certificate)); assertNotNull(storage.load())
        }
        assertEquals(1, keys.creates)
    }

    @Test fun duplicate_activation_reopen_and_lost_key_preserve_authorization_and_complete_journal_blob() {
        lateinit var enrollment: DeviceEnrollment
        val journal = "original-confirmed-unknown-and-retirement-records".toByteArray()
        store().use { storage ->
            enrollment = activate(storage)
            assertFails { DeviceEnrollment.parse(enrollment.encoded()) }
            storage.authorize("com.example.player", true); storage.journal(enrollment.binding).commit(journal)
            val before = document()
            storage.activateIdentity(enrollment)
            assertContentEquals(before, document())
            assertEquals("identity_rotation_required", assertFailsWith<AgentStoreFault> {
                storage.previewCertificate(IdentityFixtures.sign(storage.identityRequest()!!.request!!.pem))
            }.code)
        }
        store().use { storage ->
            assertEquals(enrollment.certificateFingerprint, storage.load()!!.certificateFingerprint)
            assertEquals(setOf("com.example.player"), storage.allowed()); assertContentEquals(journal, storage.journal(enrollment.binding).read())
        }
        keys.pairs.clear()
        val before = document()
        store().use { storage ->
            assertFails { storage.load() }; assertFails { storage.identityRequest() }
            assertEquals(setOf("com.example.player"), storage.allowed()); assertContentEquals(journal, storage.journal(enrollment.binding).read())
        }
        assertContentEquals(before, document()); assertEquals(1, keys.creates)
    }

    @Test fun existing_pem_identity_requires_rotation_and_never_creates_initial_key() {
        val legacy = IdentityFixtures.legacy()
        store().use { storage ->
            storage.install(legacy); storage.authorize("com.example.player", true); storage.journal(legacy.binding).commit("history".toByteArray())
            assertEquals("identity_rotation_required", assertFailsWith<AgentStoreFault> { storage.requestIdentity(setup()) }.code)
            assertEquals(legacy.certificateFingerprint, storage.load()!!.certificateFingerprint)
            assertNull(storage.identityRequest()); assertEquals(0, keys.creates)
        }
    }

    @Test fun altered_active_request_cannot_be_used_with_an_existing_credential() {
        lateinit var enrolled: DeviceEnrollment
        store().use { enrolled = activate(it); it.journal(enrolled.binding).commit("preserved".toByteArray()) }
        database().use { db ->
            val original = vault.open(document(), "tv-identity-v1/${enrolled.binding}")
            val value = DeviceDocument.parse(original, 16384).toMutableMap()
            value["key_reference"] = JsonPrimitive("limeiot-tv-identity-" + "f".repeat(32))
            val changed = vault.seal(JsonObject(value).toString().toByteArray(), "tv-identity-v1/${enrolled.binding}")
            db.execSQL("UPDATE identity SET document=? WHERE slot=1", arrayOf(changed))
        }
        store().use { storage ->
            assertFails { storage.load() }; assertFails { storage.identityRequest() }
            assertContentEquals("preserved".toByteArray(), storage.journal(enrolled.binding).read())
        }
        assertEquals(1, keys.creates)
    }

    @Test fun actual_nas_signing_storage_reopen_and_same_key_mtls() {
        val rootValue = System.getenv("LIMEIOT_TV_AGENT_IDENTITY_ROOT")
        assumeTrue("requires explicit isolated NAS CSR environment", rootValue != null)
        val root = java.nio.file.Paths.get(rootValue!!)
        val python = System.getenv("LIMEIOT_TV_AGENT_IDENTITY_PYTHON") ?: root.resolve(".dev/firmware-tools/venv/bin/python").toString()
        val work = Files.createTempDirectory(root.resolve(".dev"), "tv-local-csr-", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")))
        val nas = work.resolve("nas")
        fun management(vararg arguments: String): JsonObject {
            val process = ProcessBuilder(python, *arguments).directory(root.toFile()).redirectError(work.resolve("last-stderr.log").toFile()).start()
            if (!process.waitFor(20, TimeUnit.SECONDS)) { process.destroyForcibly(); fail("management command timed out") }
            assertEquals(0, process.exitValue(), "management command failed; see private fixture log")
            return DeviceDocument.parse(process.inputStream.readBytes(), 65536)
        }
        management("deploy/nas/manage.py", "init", "--directory", nas.toString(), "--origin", "https://127.0.0.1:18443")
        val setup = DeviceIdentitySetup.parse(buildJsonObject {
            put("schema_version", 1); put("request_id", "tv-local-csr"); put("space_id", "space-demo"); put("device_id", "device-lamp")
            put("broker", "ssl://127.0.0.1:8883"); put("model_profile", "android-tv-agent")
            put("ca_pem", String(Files.readAllBytes(nas.resolve("broker-tls/ca.crt")), Charsets.US_ASCII))
        }.toString().toByteArray())
        val request = store().use { it.requestIdentity(setup).request!! }
        val csr = work.resolve("request.csr"); Files.write(csr, request.pem.toByteArray(Charsets.US_ASCII))
        val output = work.resolve("public-certificate")
        val inspected = management("deploy/nas/device_identity.py", "inspect-csr", "--directory", nas.toString(), "--device-id", "device-lamp", "--csr", csr.toString())
        assertEquals(request.publicKeyFingerprint, inspected["public_key_fingerprint"]!!.jsonPrimitive.content)
        val issued = management("deploy/nas/device_identity.py", "sign-csr", "--directory", nas.toString(), "--device-id", "device-lamp", "--csr", csr.toString(),
            "--request-id", setup.requestId, "--public-key-fingerprint", request.publicKeyFingerprint, "--output", output.toString())
        val resolved = management("deploy/nas/device_identity.py", "resolve-csr", "--directory", nas.toString(), "--request-id", setup.requestId)
        assertEquals(issued["certificate_sha256"], resolved["certificate_sha256"])
        store().use { storage ->
            assertEquals(request.pem, storage.identityRequest()!!.request!!.pem)
            storage.activateIdentity(storage.previewCertificate(Files.readAllBytes(output.resolve("device.crt"))))
        }
        fun certificate(path: Path) = Files.newInputStream(path).use { CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate }
        val ca = certificate(output.resolve("ca.crt")); val serverCertificate = certificate(nas.resolve("broker-tls/server.crt"))
        val convertedKey = work.resolve("server.pkcs8")
        val convert = ProcessBuilder("openssl", "pkcs8", "-topk8", "-nocrypt", "-in", nas.resolve("broker-tls/server.key").toString(), "-outform", "DER", "-out", convertedKey.toString())
            .redirectError(work.resolve("key-conversion-stderr.log").toFile()).start()
        assertTrue(convert.waitFor(10, TimeUnit.SECONDS)); assertEquals(0, convert.exitValue())
        val serverKey = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(Files.readAllBytes(convertedKey)))
        val serverKeys = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null); setKeyEntry("server", serverKey, charArrayOf(), arrayOf(serverCertificate, ca)) }
        val trust = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null); setCertificateEntry("ca", ca) }
        val managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(serverKeys, charArrayOf()) }
        val trusted = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(trust) }
        val server = SSLContext.getInstance("TLSv1.2").apply { init(managers.keyManagers, trusted.trustManagers, null) }
        val listener = server.serverSocketFactory.createServerSocket(0, 1, InetAddress.getByName("127.0.0.1")) as SSLServerSocket
        listener.needClientAuth = true; listener.soTimeout = 5000
        val executor = Executors.newSingleThreadExecutor()
        val accepted = executor.submit {
            (listener.accept() as SSLSocket).use { socket ->
                socket.soTimeout = 5000; socket.startHandshake()
                assertEquals("CN=device-lamp", (socket.session.peerCertificates.first() as X509Certificate).subjectX500Principal.name)
                assertContentEquals(certificate(output.resolve("device.crt")).encoded, socket.session.peerCertificates.first().encoded)
                assertEquals(42, socket.inputStream.read()); socket.outputStream.write(43); socket.outputStream.flush()
            }
        }
        try {
            store().use { storage ->
                val enrollment = storage.load()!!
                assertEquals(request.pem, storage.identityRequest()!!.request!!.pem)
                assertEquals(issued["certificate_sha256"]!!.jsonPrimitive.content, enrollment.certificateFingerprint)
                (enrollment.tls().socketFactory.createSocket("127.0.0.1", listener.localPort) as SSLSocket).use { socket ->
                    socket.soTimeout = 5000; socket.sslParameters = socket.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
                    socket.startHandshake(); socket.outputStream.write(42); socket.outputStream.flush(); assertEquals(43, socket.inputStream.read())
                }
            }
            accepted.get(10, TimeUnit.SECONDS)
        } finally { listener.close(); executor.shutdownNow(); assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS)) }
        assertEquals(1, keys.creates)
        val previous = store().use { it.load()!! }
        val rotation = store().use { storage ->
            storage.authorize("com.example.player", true); storage.journal(previous.binding).commit("complete-original-ledger".toByteArray())
            storage.requestRotation("tv-rotation-one")
        }
        store().use { storage ->
            assertEquals(previous.certificateFingerprint, storage.load()!!.certificateFingerprint)
            assertEquals(rotation.candidate.request!!.pem, storage.requestRotation("tv-rotation-one").candidate.request!!.pem)
        }
        val rotationCsr = work.resolve("rotation.csr"); Files.write(rotationCsr, rotation.candidate.request!!.pem.toByteArray(Charsets.US_ASCII))
        val rotationOutput = work.resolve("rotation-issued")
        val rotated = management("deploy/nas/device_identity.py", "rotate-csr", "--directory", nas.toString(), "--device-id", "device-lamp", "--csr", rotationCsr.toString(),
            "--request-id", "tv-rotation-one", "--public-key-fingerprint", rotation.candidate.request!!.publicKeyFingerprint,
            "--previous-serial", rotation.previousSerial, "--previous-certificate-fingerprint", rotation.previousCertificate, "--output", rotationOutput.toString())
        val rotationReceipt = DeviceRotationReceipt.parse(Files.readAllBytes(rotationOutput.resolve("enrollment.json")))
        store().use { storage -> storage.activateRotation(storage.previewRotation(Files.readAllBytes(rotationOutput.resolve("device.crt")), rotationReceipt)) }
        val proof = store().use { it.activationProof("tv-rotation-one") }
        store().use { storage ->
            assertEquals(proof, storage.activationProof("tv-rotation-one")); assertEquals(rotated["certificate_sha256"]!!.jsonPrimitive.content, storage.load()!!.certificateFingerprint)
            assertEquals(setOf("com.example.player"), storage.allowed()); assertContentEquals("complete-original-ledger".toByteArray(), storage.journal(previous.binding).read())
        }
        val port = java.net.ServerSocket(0).use { it.localPort }
        val config = work.resolve("mosquitto.conf")
        Files.write(config, ("listener $port 127.0.0.1\ncafile ${nas.resolve("broker-tls/ca.crt")}\ncertfile ${nas.resolve("broker-tls/server.crt")}\nkeyfile ${nas.resolve("broker-tls/server.key")}\ncrlfile ${nas.resolve("broker-tls/revoked.crl")}\nrequire_certificate true\nallow_anonymous true\npersistence false\n").toByteArray())
        fun broker(label: String): Process {
            val log = work.resolve("broker-$label.log")
            val child = ProcessBuilder(root.resolve(".dev/tools/mosquitto-build/src/mosquitto").toString(), "-c", config.toString()).redirectErrorStream(true).redirectOutput(log.toFile()).start()
            try {
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                while (System.nanoTime() < deadline && child.isAlive) {
                    if (String(Files.readAllBytes(log)).contains(" running")) return child
                    Thread.sleep(20)
                }
                fail("isolated Broker startup failed; see fixture log")
            } catch (error: Throwable) { child.destroyForcibly(); child.waitFor(5, TimeUnit.SECONDS); throw error }
        }
        fun stop(child: Process) { child.destroy(); if (!child.waitFor(5, TimeUnit.SECONDS)) { child.destroyForcibly(); assertTrue(child.waitFor(5, TimeUnit.SECONDS)) } }
        fun connect(enrollment: DeviceEnrollment) {
            (enrollment.tls().socketFactory.createSocket("127.0.0.1", port) as SSLSocket).use { socket ->
                socket.soTimeout = 5000; socket.enabledProtocols = arrayOf("TLSv1.2")
                socket.sslParameters = socket.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }; socket.startHandshake()
            }
        }
        val current = store().use { it.load()!! }
        val beforeBroker = broker("before-revoke")
        try { connect(previous); connect(current) } finally { stop(beforeBroker) }
        val completed = management("deploy/nas/device_identity.py", "complete-rotation", "--directory", nas.toString(), "--request-id", "tv-rotation-one", "--activation-proof", proof)
        assertEquals(JsonPrimitive(true), completed["rotation_completed"])
        val original = management("deploy/nas/device_identity.py", "resolve-csr", "--directory", nas.toString(), "--request-id", "tv-rotation-one")
        val completedReceipt = DeviceRotationReceipt.parse(DeviceDocument.canonical(original).toByteArray())
        store().use { it.confirmRotationManagement(completedReceipt); assertTrue(it.rotationRequest()!!.managementCompleted) }
        val afterBroker = broker("after-revoke")
        try {
            assertFails { connect(previous) }; connect(current)
            store().use { storage ->
                storage.retirePreviousKey(storage.previewKeyRetirement("tv-rotation-one", Files.readAllBytes(nas.resolve("broker-tls/revoked.crl"))))
                assertEquals("retired", storage.keyRetirements().single().phase)
            }
            assertFalse(keys.contains(previous.keyReference!!)); connect(current)
        } finally { stop(afterBroker) }
        assertEquals(2, keys.creates)
        Files.write(work.resolve("result.json"), buildJsonObject {
            put("passed", true); put("real_nas_csr_signing", true); put("sqlite_reopen", true); put("actual_same_key_mtls", true)
            put("key_creations", keys.creates); put("android_keystore", false); put("hardware", false)
            put("actual_nas_rotation_and_activation", true); put("broker_restarted", true); put("old_identity_rejected", true); put("new_identity_accepted", true)
            put("retired_old_key", true); put("retired_key_count", keys.retirements)
        }.toString().toByteArray())
    }

    @Test fun version_one_migration_preserves_credentials_authorization_and_journal() {
        val legacy = IdentityFixtures.legacy(); val path = context.getDatabasePath("tv-agent.db")
        path.parentFile!!.mkdirs()
        SQLiteDatabase.openOrCreateDatabase(path, null).use { db ->
            db.execSQL("CREATE TABLE agent (slot INTEGER PRIMARY KEY CHECK(slot=1), binding TEXT NOT NULL, credentials BLOB NOT NULL, journal BLOB)")
            db.execSQL("CREATE TABLE applications (package TEXT PRIMARY KEY, slot INTEGER NOT NULL DEFAULT 1 REFERENCES agent(slot))")
            db.execSQL("INSERT INTO agent VALUES(1,?,?,?)", arrayOf(legacy.binding, vault.seal(legacy.encoded(), legacy.binding), "full-original-journal".toByteArray()))
            db.execSQL("INSERT INTO applications VALUES('com.example.player',1)"); db.version = 1
        }
        store().use { storage ->
            assertEquals(legacy.certificateFingerprint, storage.load()!!.certificateFingerprint); assertNull(storage.identityRequest())
            assertEquals(setOf("com.example.player"), storage.allowed()); assertContentEquals("full-original-journal".toByteArray(), storage.journal(legacy.binding).read())
        }
        database().use { assertEquals(3, it.version) }
        assertEquals(0, keys.creates)
    }

    private fun rotationReceipt(view: RotationRequestView, certificate: ByteArray, completed: Boolean = false, change: (MutableMap<String, JsonElement>) -> Unit = {}): DeviceRotationReceipt {
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(certificate.inputStream()) as X509Certificate
        val request = view.candidate.request!!; val setup = view.candidate.setup
        fun digest(bytes: ByteArray) = "sha256:" + java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
        val original = buildJsonObject {
            put("schema_version", if (view.expiredRecovery) 3 else 2); put("request_id", setup.requestId); put("space_id", setup.identity.space); put("device_id", setup.identity.device)
            if (view.expiredRecovery) put("recovery_reason", "certificate_expired")
            put("serial", cert.serialNumber.toString(16).uppercase()); put("csr_sha256", request.csrSha256); put("public_key_fingerprint", request.publicKeyFingerprint)
            put("ca_fingerprint", setup.caFingerprint); put("replaces_serial", view.previousSerial); put("replaces_certificate_sha256", view.previousCertificate); put("activation_challenge", "ab".repeat(32))
        }.toMutableMap().also(change)
        return DeviceRotationReceipt.parse(DeviceDocument.canonical(JsonObject(original + buildJsonObject {
            put("request_sha256", DeviceDocument.digest(JsonObject(original))); put("decision", "issued"); put("hardware", false); put("physical_claim", false)
            put("previous_decision", if (completed) "revoked" else if (view.expiredRecovery) "expired" else "issued"); put("activation_confirmed", completed); put("crl_updated", completed); put("rotation_completed", completed)
            put("certificate_sha256", digest(cert.encoded)); put("not_before", cert.notBefore.toInstant().toString()); put("not_after", cert.notAfter.toInstant().toString())
        })).toByteArray())
    }

    @Test fun rotation_retains_old_identity_and_original_csr_until_atomic_switch() {
        val old = store().use { activate(it) }
        val view = store().use { storage ->
            storage.authorize("com.example.player", true); storage.journal(old.binding).commit("complete-confirmed-unknown-high-watermark".toByteArray())
            storage.requestRotation("rotate-one").also {
                assertEquals(old.certificateFingerprint, storage.load()!!.certificateFingerprint)
                assertFails { storage.requestRotation("rotate-two") }; assertEquals(2, keys.creates)
            }
        }
        val certificate = IdentityFixtures.sign(view.candidate.request!!.pem)
        val receipt = rotationReceipt(view, certificate)
        store().use { storage ->
            assertEquals(view.candidate.request!!.pem, storage.requestRotation("rotate-one").candidate.request!!.pem)
            assertFails { storage.previewRotation(IdentityFixtures.sign(view.candidate.request!!.pem, foreignCa = true), receipt) }
            assertFails { storage.previewRotation(certificate, rotationReceipt(view, certificate) { it["replaces_certificate_sha256"] = JsonPrimitive("sha256:" + "00".repeat(32)) }) }
            assertFails { storage.previewRotation(certificate, rotationReceipt(view, certificate) { it["activation_challenge"] = JsonPrimitive("zz".repeat(32)) }) }
            assertEquals(old.certificateFingerprint, storage.load()!!.certificateFingerprint)
            val candidate = storage.previewRotation(certificate, receipt); storage.activateRotation(candidate)
            assertEquals(candidate.enrollment.certificateFingerprint, storage.load()!!.certificateFingerprint)
            storage.activateRotation(candidate)
            assertEquals(setOf("com.example.player"), storage.allowed())
            assertContentEquals("complete-confirmed-unknown-high-watermark".toByteArray(), storage.journal(old.binding).read())
        }
        store().use { assertEquals(receipt.certificateFingerprint, it.load()!!.certificateFingerprint); assertEquals("active", it.rotationRequest()!!.candidate.phase) }
        assertEquals(2, keys.creates)
    }

    @Test fun legacy_identity_migrates_only_by_rotation_and_keeps_full_records() {
        val old = IdentityFixtures.legacy()
        store().use { storage ->
            storage.install(old); storage.authorize("com.example.player", true); storage.journal(old.binding).commit("original-journal".toByteArray())
            assertFails { storage.requestIdentity(setup()) }
            val view = storage.requestRotation("legacy-to-local")
            assertFails { storage.install(old) }
            val cert = IdentityFixtures.sign(view.candidate.request!!.pem)
            storage.activateRotation(storage.previewRotation(cert, rotationReceipt(view, cert)))
        }
        store().use { storage ->
            assertNotNull(storage.load()!!.keyReference); assertEquals(old.binding, storage.load()!!.binding)
            assertEquals(setOf("com.example.player"), storage.allowed()); assertContentEquals("original-journal".toByteArray(), storage.journal(old.binding).read())
        }
        assertEquals(1, keys.creates)
    }

    @Test fun rotation_intent_failure_does_not_create_key_or_replace_old_identity() {
        val old = store().use { activate(it) }; vault.failSealPhase = "prepared"
        store().use { storage -> assertFails { storage.requestRotation("rotate-one") }; frozen(storage); assertEquals(1, keys.creates) }
        vault.failSealPhase = null
        store().use { assertNull(it.rotationRequest()); assertEquals(old.certificateFingerprint, it.load()!!.certificateFingerprint) }
    }

    @Test fun rotation_lost_creation_response_reopens_original_key_without_replacement() {
        val old = store().use { activate(it) }; keys.failAfterCreate = true
        store().use { storage -> assertFails { storage.requestRotation("rotate-one") }; frozen(storage) }
        keys.failAfterCreate = false
        store().use { storage ->
            assertEquals(old.certificateFingerprint, storage.load()!!.certificateFingerprint)
            assertEquals("creating", storage.rotationRequest()!!.candidate.phase)
            assertEquals("pending", storage.requestRotation("rotate-one").candidate.phase)
        }
        assertEquals(2, keys.creates)
    }

    @Test fun rotation_missing_creating_key_refuses_regeneration() {
        store().use { activate(it) }; keys.failBeforeCreate = true
        store().use { assertFails { it.requestRotation("rotate-one") } }; keys.failBeforeCreate = false
        repeat(2) { store().use { storage -> assertFails { storage.requestRotation("rotate-one") }; frozen(storage) } }
        assertEquals(1, keys.creates)
    }

    @Test fun rotation_pending_commit_and_readback_failures_restore_same_candidate() {
        store().use { activate(it) }; vault.failSealPhase = "pending"
        store().use { storage -> assertFails { storage.requestRotation("rotate-one") }; frozen(storage) }
        vault.failSealPhase = null; vault.failPendingReadback = true
        store().use { storage -> assertFails { storage.requestRotation("rotate-one") }; frozen(storage) }
        val original = vault.lastPendingCsr
        store().use { assertEquals(original, it.requestRotation("rotate-one").candidate.request!!.pem) }
        assertEquals(2, keys.creates)
    }

    @Test fun rotation_switch_rollback_retains_old_certificate_authorization_and_journal() {
        val old = store().use { activate(it) }
        val view = store().use { storage -> storage.authorize("com.example.player", true); storage.journal(old.binding).commit("full-original".toByteArray()); storage.requestRotation("rotate-one") }
        val cert = IdentityFixtures.sign(view.candidate.request!!.pem); val receipt = rotationReceipt(view, cert)
        vault.failRotationActive = true
        store().use { storage -> assertFails { storage.activateRotation(storage.previewRotation(cert, receipt)) }; frozen(storage) }
        vault.failRotationActive = false
        store().use { storage ->
            assertEquals(old.certificateFingerprint, storage.load()!!.certificateFingerprint); assertEquals("pending", storage.rotationRequest()!!.candidate.phase)
            assertEquals(setOf("com.example.player"), storage.allowed()); assertContentEquals("full-original".toByteArray(), storage.journal(old.binding).read())
            storage.activateRotation(storage.previewRotation(cert, receipt))
        }
    }

    @Test fun activation_proof_is_durable_bound_and_recoverable_during_next_candidate() {
        store().use { activate(it) }
        val view = store().use { it.requestRotation("rotate-one") }; val cert = IdentityFixtures.sign(view.candidate.request!!.pem)
        val receipt = rotationReceipt(view, cert)
        store().use { storage -> storage.activateRotation(storage.previewRotation(cert, receipt)); assertFails { storage.requestRotation("rotate-two") } }
        vault.failProofSeal = true
        store().use { storage -> assertFails { storage.activationProof("rotate-one") }; frozen(storage) }
        vault.failProofSeal = false
        val proof = store().use { storage ->
            val proof = storage.activationProof("rotate-one"); assertEquals(proof, storage.activationProof("rotate-one"))
            assertFails { storage.confirmRotationManagement(receipt) }; storage.confirmRotationManagement(rotationReceipt(view, cert, true))
            storage.requestRotation("rotate-two")
            assertEquals(proof, storage.activationProof("rotate-one")); proof
        }
        store().use { assertEquals(proof, it.activationProof("rotate-one")) }
        val key = keys.pairs.values.elementAt(1).let { DeviceSigningKey.from(it.private, it.public) }
        assertTrue(key.verifyRotationActivationProof(view.candidate.setup.identity, "rotate-one", receipt.certificateFingerprint, receipt.challenge, proof))
        assertFalse(key.verifyRotationActivationProof(view.candidate.setup.identity, "rotate-two", receipt.certificateFingerprint, receipt.challenge, proof))
        assertFalse(key.verifyRotationActivationProof(view.candidate.setup.identity, "rotate-one", receipt.certificateFingerprint, "00".repeat(32), proof))
        assertFalse(keys.pairs.values.first().let { DeviceSigningKey.from(it.private, it.public) }.verifyRotationActivationProof(view.candidate.setup.identity, "rotate-one", receipt.certificateFingerprint, receipt.challenge, proof))
        assertEquals(3, keys.creates)
    }

    @Test fun version_two_migration_only_adds_rotation_records() {
        val legacy = IdentityFixtures.legacy(); val path = context.getDatabasePath("tv-agent.db")
        path.parentFile!!.mkdirs()
        val credentials = vault.seal(legacy.encoded(), legacy.binding)
        SQLiteDatabase.openOrCreateDatabase(path, null).use { db ->
            db.execSQL("CREATE TABLE agent (slot INTEGER PRIMARY KEY CHECK(slot=1), binding TEXT NOT NULL, credentials BLOB NOT NULL, journal BLOB)")
            db.execSQL("CREATE TABLE applications (package TEXT PRIMARY KEY, slot INTEGER NOT NULL DEFAULT 1 REFERENCES agent(slot))")
            db.execSQL("CREATE TABLE identity (slot INTEGER PRIMARY KEY CHECK(slot=1), binding TEXT NOT NULL, document BLOB NOT NULL)")
            db.execSQL("INSERT INTO agent VALUES(1,?,?,?)", arrayOf(legacy.binding, credentials, "full-original-journal".toByteArray()))
            db.execSQL("INSERT INTO applications VALUES('com.example.player',1)"); db.version = 2
        }
        store().use { storage ->
            assertEquals(legacy.certificateFingerprint, storage.load()!!.certificateFingerprint); assertNull(storage.rotationRequest())
            assertEquals(setOf("com.example.player"), storage.allowed()); assertContentEquals("full-original-journal".toByteArray(), storage.journal(legacy.binding).read())
        }
        database().use { db ->
            assertEquals(3, db.version)
            db.rawQuery("SELECT credentials FROM agent", null).use { it.moveToFirst(); assertContentEquals(credentials, it.getBlob(0)) }
        }
        assertEquals(0, keys.creates)
    }

    @Test fun missing_pending_rotation_key_does_not_fallback_or_replace_identity() {
        val old = store().use { activate(it) }
        store().use { it.requestRotation("rotate-one") }
        keys.pairs.remove(keys.pairs.keys.last())
        store().use { storage ->
            assertFails { storage.load() }; assertFails { storage.requestRotation("rotate-one") }
            assertContentEquals(null, storage.journal(old.binding).read())
        }
        assertEquals(2, keys.creates)
    }

    @Test fun stored_activation_proof_is_verified_after_reopen() {
        val old = store().use { activate(it) }
        store().use { storage ->
            val view = storage.requestRotation("rotate-one"); val cert = IdentityFixtures.sign(view.candidate.request!!.pem)
            storage.activateRotation(storage.previewRotation(cert, rotationReceipt(view, cert))); storage.activationProof("rotate-one")
        }
        database().use { db -> db.rawQuery("SELECT document FROM rotations", null).use {
            it.moveToFirst(); val binding = "tv-rotation-v1/${old.binding}"
            val value = DeviceDocument.parse(vault.open(it.getBlob(0), binding), 32768).toMutableMap()
            value["proof"] = JsonPrimitive("00".repeat(70))
            db.execSQL("UPDATE rotations SET document=?", arrayOf(vault.seal(DeviceDocument.canonical(JsonObject(value)).toByteArray(), binding)))
        } }
        store().use { assertFails { it.load() }; assertFails { it.activationProof("rotate-one") } }
        assertEquals(2, keys.creates)
    }

    @Test fun rotation_receipt_rejects_bad_digest_duplicate_and_unknown_fields() {
        store().use { activate(it) }
        val view = store().use { it.requestRotation("rotate-one") }; val cert = IdentityFixtures.sign(view.candidate.request!!.pem)
        val receipt = rotationReceipt(view, cert); val value = DeviceDocument.parse(receipt.encoded()).toMutableMap()
        value["request_sha256"] = JsonPrimitive("sha256:" + "00".repeat(32))
        assertFails { DeviceRotationReceipt.parse(DeviceDocument.canonical(JsonObject(value)).toByteArray()) }
        value["request_sha256"] = JsonPrimitive(receipt.requestDigest); value["unexpected"] = JsonPrimitive(true)
        assertFails { DeviceRotationReceipt.parse(DeviceDocument.canonical(JsonObject(value)).toByteArray()) }
        assertFails { DeviceRotationReceipt.parse((String(receipt.encoded()).dropLast(1) + ",\"request_id\":\"rotate-one\"}").toByteArray()) }
        assertEquals(2, keys.creates)
    }

    private data class CompletedRotation(val old: DeviceEnrollment, val view: RotationRequestView, val certificate: ByteArray)

    @Test fun apk_snapshot_preserves_pending_request_and_refuses_missing_key_without_recreation() {
        val request = store().use { it.requestIdentity(setup()) }
        val snapshot = store().use { it.apkContinuity() }
        assertEquals(request.setup.binding, snapshot.binding); assertNull(snapshot.journal)
        assertEquals(snapshot, store().use { it.apkContinuity() }); assertEquals(1, keys.creates)
        keys.pairs.clear()
        store().use { assertFails { it.apkContinuity() } }
        assertEquals(1, keys.creates)
    }

    @Test fun apk_snapshot_reads_original_creating_state_before_or_after_lost_creation_response() {
        keys.failAfterCreate = true
        store().use { assertFails { it.requestIdentity(setup()) } }
        keys.failAfterCreate = false
        val snapshot = store().use { it.apkContinuity() }
        assertNull(snapshot.journal); assertEquals(1, keys.creates)
        store().use {
            val request = it.requestIdentity(setup()); assertEquals("pending", request.phase)
            assertNotEquals(snapshot.digest, it.apkContinuity().digest)
        }
        assertEquals(1, keys.creates)
    }

    @Test fun apk_snapshot_keeps_creating_request_with_no_key_and_never_retries_creation() {
        keys.failBeforeCreate = true
        store().use { assertFails { it.requestIdentity(setup()) } }
        val snapshot = store().use { it.apkContinuity() }
        assertEquals(snapshot, store().use { it.apkContinuity() }); assertEquals(0, keys.creates)
    }

    @Test fun apk_snapshot_keeps_prepared_initial_request_and_refuses_unapproved_missing_retained_key() {
        vault.failSealPhase = "creating"
        store().use { assertFails { it.requestIdentity(setup()) } }
        vault.failSealPhase = null
        val prepared = store().use { it.apkContinuity() }
        assertEquals(0, keys.creates); assertNull(prepared.journal)
        val rotated = store().use { completeRotation(it) }
        keys.pairs.remove(rotated.old.keyReference)
        store().use { assertEquals("identity_key_unavailable", assertFailsWith<AgentStoreFault> { it.apkContinuity() }.code) }
        assertEquals(0, keys.retirements); assertEquals(2, keys.creates)
    }

    @Test fun apk_snapshot_covers_all_history_and_retired_keys_without_reapproving_or_recreating_them() {
        val first = store().use { completeRotation(it, "retire-one") }
        val second = store().use { completeRotation(it, "retire-two") }
        val original = ApkJournalFixture.bytes(second.view.candidate.setup.identity)
        val crl = IdentityFixtures.crl(first.old.publicCertificate(), second.old.publicCertificate())
        store().use {
            it.authorize("com.example.player", true); it.journal(first.old.binding).commit(original)
            it.retirePreviousKey(it.previewKeyRetirement("retire-two", crl))
            it.retirePreviousKey(it.previewKeyRetirement("retire-one", crl))
        }
        val snapshot = store().use {
            it.allowed()
            val before = context.getDatabasePath("tv-agent.db").readBytes()
            val value = it.apkContinuity()
            assertEquals(value, it.apkContinuity())
            assertContentEquals(before, context.getDatabasePath("tv-agent.db").readBytes())
            value
        }
        assertEquals(DeviceJournalInspection(9, 1, 1, 1, 1, false), snapshot.journal)
        assertEquals(snapshot, store().use { it.apkContinuity() })
        assertEquals(3, keys.creates); assertEquals(2, keys.retirements); assertEquals(1, keys.pairs.size)
        database().use { it.execSQL("UPDATE rotations SET number=number+10") }
        assertNotEquals(snapshot.digest, store().use { it.apkContinuity() }.digest)
        store().use { assertContentEquals(original, it.journal(first.old.binding).read()) }
    }

    @Test fun apk_snapshot_preserves_unknown_retirement_without_repeating_the_delete() {
        val rotated = store().use { completeRotation(it) }
        keys.failAfterRetire = true
        store().use { assertFails { it.retirePreviousKey(it.previewKeyRetirement("retire-one", IdentityFixtures.crl(rotated.old.publicCertificate()))) } }
        keys.failAfterRetire = false
        val snapshot = store().use { it.apkContinuity() }
        store().use {
            assertEquals("deleting", it.keyRetirements().single().phase); assertEquals(snapshot, it.apkContinuity())
        }
        assertEquals(1, keys.retirements); assertEquals(2, keys.creates)
        store().use { it.retirePreviousKey(it.previewKeyRetirement("retire-one")); assertNotEquals(snapshot.digest, it.apkContinuity().digest) }
        assertEquals(1, keys.retirements)
    }
    private fun completeRotation(storage: AndroidAgentStore, id: String = "retire-one"): CompletedRotation {
        val old = storage.load() ?: activate(storage)
        val view = storage.requestRotation(id); val cert = IdentityFixtures.sign(view.candidate.request!!.pem)
        storage.activateRotation(storage.previewRotation(cert, rotationReceipt(view, cert))); storage.activationProof(id)
        storage.confirmRotationManagement(rotationReceipt(view, cert, true))
        return CompletedRotation(old, view, cert)
    }

    @Test fun verified_retirement_preserves_current_key_authorization_and_full_journal() {
        val rotated = store().use { storage ->
            val value = completeRotation(storage); storage.authorize("com.example.player", true); storage.journal(value.old.binding).commit("complete-original-journal".toByteArray()); value
        }
        val crl = IdentityFixtures.crl(rotated.old.publicCertificate())
        store().use { storage ->
            val preview = storage.previewKeyRetirement("retire-one", crl)
            assertEquals(0, keys.retirements); assertTrue(keys.contains(rotated.old.keyReference!!))
            storage.retirePreviousKey(preview); storage.retirePreviousKey(preview)
        }
        store().use { storage ->
            assertEquals("retired", storage.keyRetirements().single().phase)
            assertFalse(keys.contains(rotated.old.keyReference!!)); assertEquals(1, keys.pairs.size)
            assertEquals(rotated.view.candidate.request!!.publicKeyFingerprint, storage.load()!!.publicKeyFingerprint)
            assertEquals(setOf("com.example.player"), storage.allowed()); assertContentEquals("complete-original-journal".toByteArray(), storage.journal(rotated.old.binding).read())
        }
        assertEquals(1, keys.retirements); assertEquals(2, keys.creates)
    }

    @Test fun unsigned_management_completion_and_wrong_crls_never_delete_keys() {
        val rotated = store().use { completeRotation(it) }
        val old = rotated.old.publicCertificate()
        val good = IdentityFixtures.crl(old)
        val badSignature = String(good).replace(Regex("[A-Za-z0-9+/=\\s]+(?=-----END X509 CRL-----)")) { match ->
            val raw = Base64.getMimeDecoder().decode(match.value); raw[raw.lastIndex] = (raw.last().toInt() xor 1).toByte()
            "\n" + Base64.getMimeEncoder(64, byteArrayOf(10)).encodeToString(raw) + "\n"
        }.toByteArray()
        val wrong = listOf(IdentityFixtures.crl(), IdentityFixtures.crl(old, foreignCa = true), IdentityFixtures.crl(old, expired = true),
            IdentityFixtures.crl(old, future = true), IdentityFixtures.crl(old, rotated.certificate), good + good, badSignature,
            IdentityFixtures.crl(old, extension = "1.2.3.4=critical,DER:05:00"), IdentityFixtures.crl(old, extension = "2.5.29.27=critical,DER:02:01:01"))
        store().use { storage ->
            for (crl in wrong) assertFails { storage.previewKeyRetirement("retire-one", crl) }
            assertEquals("retained", storage.keyRetirements().single().phase); assertEquals(2, keys.pairs.size); assertEquals(0, keys.retirements)
            assertNotNull(storage.previewKeyRetirement("retire-one", good))
        }
    }

    @Test fun retirement_intent_commit_failure_performs_zero_deletions() {
        val rotated = store().use { completeRotation(it) }; val crl = IdentityFixtures.crl(rotated.old.publicCertificate())
        vault.failRetirementPhase = "deleting"
        store().use { storage -> assertFails { storage.retirePreviousKey(storage.previewKeyRetirement("retire-one", crl)) }; frozen(storage) }
        assertEquals(0, keys.retirements); assertTrue(keys.contains(rotated.old.keyReference!!)); vault.failRetirementPhase = null
        store().use { storage -> assertEquals("retained", storage.keyRetirements().single().phase); storage.retirePreviousKey(storage.previewKeyRetirement("retire-one", crl)) }
        assertEquals(1, keys.retirements)
    }

    @Test fun delete_failure_before_effect_reopens_original_intent() {
        val rotated = store().use { completeRotation(it) }; val crl = IdentityFixtures.crl(rotated.old.publicCertificate())
        keys.failBeforeRetire = true
        store().use { storage -> assertFails { storage.retirePreviousKey(storage.previewKeyRetirement("retire-one", crl)) }; frozen(storage) }
        keys.failBeforeRetire = false; assertTrue(keys.contains(rotated.old.keyReference!!))
        store().use { storage -> assertEquals("deleting", storage.keyRetirements().single().phase); storage.retirePreviousKey(storage.previewKeyRetirement("retire-one")) }
        assertEquals(1, keys.retirements); assertEquals(2, keys.creates)
    }

    @Test fun delete_effect_with_lost_response_recovers_missing_old_key_without_recreation() {
        val rotated = store().use { completeRotation(it) }; val crl = IdentityFixtures.crl(rotated.old.publicCertificate())
        keys.failAfterRetire = true
        store().use { storage -> assertFails { storage.retirePreviousKey(storage.previewKeyRetirement("retire-one", crl)) }; frozen(storage) }
        keys.failAfterRetire = false; assertFalse(keys.contains(rotated.old.keyReference!!))
        store().use { storage -> assertEquals("deleting", storage.keyRetirements().single().phase); storage.retirePreviousKey(storage.previewKeyRetirement("retire-one")) }
        assertEquals(1, keys.retirements); assertEquals(2, keys.creates)
    }

    @Test fun retirement_final_commit_failure_recovers_original_delete_without_second_effect() {
        val rotated = store().use { completeRotation(it) }; val crl = IdentityFixtures.crl(rotated.old.publicCertificate())
        vault.failRetirementPhase = "retired"
        store().use { storage -> assertFails { storage.retirePreviousKey(storage.previewKeyRetirement("retire-one", crl)) }; frozen(storage) }
        vault.failRetirementPhase = null
        store().use { storage -> assertEquals("deleting", storage.keyRetirements().single().phase); storage.retirePreviousKey(storage.previewKeyRetirement("retire-one")) }
        assertEquals(1, keys.retirements); assertEquals(2, keys.creates)
    }

    @Test fun committed_retirement_with_lost_readback_remains_retired_after_reopen() {
        val rotated = store().use { completeRotation(it) }; val crl = IdentityFixtures.crl(rotated.old.publicCertificate())
        vault.failRetiredReadback = true
        store().use { storage -> assertFails { storage.retirePreviousKey(storage.previewKeyRetirement("retire-one", crl)) }; frozen(storage) }
        store().use { storage -> assertEquals("retired", storage.keyRetirements().single().phase); storage.retirePreviousKey(storage.previewKeyRetirement("retire-one")) }
        assertEquals(1, keys.retirements)
    }

    @Test fun missing_old_key_without_intent_is_refused_and_not_claimed_retired() {
        val rotated = store().use { completeRotation(it) }; keys.pairs.remove(rotated.old.keyReference)
        store().use { storage ->
            assertFails { storage.previewKeyRetirement("retire-one", IdentityFixtures.crl(rotated.old.publicCertificate())) }
            assertEquals("retained", storage.keyRetirements().single().phase); assertNotNull(storage.load())
        }
        assertEquals(0, keys.retirements); assertEquals(2, keys.creates)
    }

    @Test fun old_record_without_key_provenance_is_read_only_and_not_guessed() {
        val rotated = store().use { completeRotation(it) }
        val encrypted = database().use { db -> db.rawQuery("SELECT document FROM rotations", null).use {
            it.moveToFirst(); val binding = "tv-rotation-v1/${rotated.old.binding}"
            val value = DeviceDocument.parse(vault.open(it.getBlob(0), binding), 32768).toMutableMap()
            value["schema_version"] = JsonPrimitive(1); value.remove("previous_key_reference"); value.remove("previous_certificate_pem"); value.remove("retirement")
            val encrypted = vault.seal(DeviceDocument.canonical(JsonObject(value)).toByteArray(), binding)
            db.execSQL("UPDATE rotations SET document=?", arrayOf(encrypted)); encrypted
        } }
        store().use { storage ->
            assertNotNull(storage.load()); assertEquals("untracked", storage.keyRetirements().single().phase)
            assertFails { storage.previewKeyRetirement("retire-one", IdentityFixtures.crl(rotated.old.publicCertificate())) }
        }
        database().use { db -> db.rawQuery("SELECT document FROM rotations", null).use { it.moveToFirst(); assertContentEquals(encrypted, it.getBlob(0)) } }
        assertEquals(0, keys.retirements)
    }

    @Test fun historical_cleanup_does_not_need_retired_intermediate_private_key() {
        val first = store().use { completeRotation(it, "retire-one") }
        val second = store().use { completeRotation(it, "retire-two") }
        val crl = IdentityFixtures.crl(first.old.publicCertificate(), second.old.publicCertificate())
        store().use { storage ->
            storage.retirePreviousKey(storage.previewKeyRetirement("retire-two", crl))
            assertFalse(keys.contains(second.old.keyReference!!))
            storage.retirePreviousKey(storage.previewKeyRetirement("retire-one", crl))
            assertEquals(second.view.candidate.request!!.publicKeyFingerprint, storage.load()!!.publicKeyFingerprint)
            assertTrue(storage.keyRetirements().all { it.phase == "retired" })
        }
        assertEquals(2, keys.retirements); assertEquals(3, keys.creates); assertEquals(1, keys.pairs.size)
    }

    @Test fun cleanup_rejects_reference_to_current_key_even_in_historical_record() {
        val first = store().use { completeRotation(it, "retire-one") }
        val second = store().use { completeRotation(it, "retire-two") }
        val reference = store().use { it.load()!!.keyReference!! }
        database().use { db -> db.rawQuery("SELECT document FROM rotations WHERE request_id='retire-one'", null).use {
            it.moveToFirst(); val binding = "tv-rotation-v1/${first.old.binding}"
            val value = DeviceDocument.parse(vault.open(it.getBlob(0), binding), 32768).toMutableMap()
            value["previous_key_reference"] = JsonPrimitive(reference)
            db.execSQL("UPDATE rotations SET document=? WHERE request_id='retire-one'", arrayOf(vault.seal(DeviceDocument.canonical(JsonObject(value)).toByteArray(), binding)))
        } }
        store().use { storage ->
            assertEquals("key_retirement_current_key", assertFailsWith<AgentStoreFault> { storage.previewKeyRetirement("retire-one", IdentityFixtures.crl(first.old.publicCertificate())) }.code)
            assertEquals(second.view.candidate.request!!.publicKeyFingerprint, storage.load()!!.publicKeyFingerprint)
        }
        assertEquals(0, keys.retirements); assertTrue(keys.contains(reference))
    }

    @Test fun old_alias_public_key_mismatch_never_deletes_another_key() {
        val rotated = store().use { completeRotation(it) }
        keys.pairs[rotated.old.keyReference!!] = keys.pairs.values.last()
        store().use { storage -> assertFails { storage.previewKeyRetirement("retire-one", IdentityFixtures.crl(rotated.old.publicCertificate())) }; assertNotNull(storage.load()) }
        assertEquals(0, keys.retirements); assertEquals(2, keys.pairs.size)
    }

    @Test fun cleanup_requires_ca_crl_sign_usage_even_when_signature_is_valid() {
        val rotated = store().use { storage ->
            val request = storage.requestIdentity(IdentityFixtures.setup("no-crl", "ssl://localhost:8883", crlSigning = false)).request!!
            storage.activateIdentity(storage.previewCertificate(IdentityFixtures.sign(request.pem)))
            completeRotation(storage)
        }
        store().use { storage -> assertFails { storage.previewKeyRetirement("retire-one", IdentityFixtures.crl(rotated.old.publicCertificate())) }; assertNotNull(storage.load()) }
        assertEquals(0, keys.retirements)
    }

    @Test fun legacy_pem_rotation_is_explicitly_not_a_keystore_deletion_target() {
        store().use { storage ->
            storage.install(IdentityFixtures.legacy()); val rotated = completeRotation(storage)
            assertEquals("not_applicable", storage.keyRetirements().single().phase)
            assertFails { storage.previewKeyRetirement("retire-one", IdentityFixtures.crl(rotated.old.publicCertificate())) }
        }
        assertEquals(0, keys.retirements); assertEquals(1, keys.pairs.size)
    }

    @Test fun oversized_retirement_record_is_rejected_before_intent_or_delete() {
        val rotated = store().use { completeRotation(it) }
        val before = database().use { db -> db.rawQuery("SELECT document FROM rotations", null).use {
            it.moveToFirst(); val binding = "tv-rotation-v1/${rotated.old.binding}"
            val value = DeviceDocument.parse(vault.open(it.getBlob(0), binding), 32768).toMutableMap()
            val candidate = value["candidate"]!!.jsonObject.toMutableMap(); val setup = candidate["setup"]!!.jsonObject.toMutableMap()
            setup["ca_pem"] = JsonPrimitive(setup["ca_pem"]!!.jsonPrimitive.content.padEnd(4096, ' ')); candidate["setup"] = JsonObject(setup)
            candidate["csr_pem"] = JsonPrimitive(candidate["csr_pem"]!!.jsonPrimitive.content.padEnd(4096, ' ')); value["candidate"] = JsonObject(candidate)
            value["previous_certificate_pem"] = JsonPrimitive(value["previous_certificate_pem"]!!.jsonPrimitive.content.padEnd(4096, ' '))
            val receipt = value["receipt"]!!.jsonObject.toMutableMap(); receipt["status"] = JsonPrimitive("ok"); receipt["action"] = JsonPrimitive("resolve-csr"); receipt["output"] = JsonPrimitive("x".repeat(4096)); value["receipt"] = JsonObject(receipt)
            val encrypted = vault.seal(DeviceDocument.canonical(JsonObject(value)).toByteArray(), binding)
            db.execSQL("UPDATE rotations SET document=?", arrayOf(encrypted)); encrypted
        } }
        val crl = IdentityFixtures.crl(rotated.old.publicCertificate())
        store().use { storage ->
            assertEquals("capacity_exceeded", assertFailsWith<AgentStoreFault> { storage.previewKeyRetirement("retire-one", String(crl).padEnd(16384, ' ').toByteArray()) }.code)
            assertNotNull(storage.load()); assertNotNull(storage.previewKeyRetirement("retire-one", crl))
        }
        database().use { db -> db.rawQuery("SELECT document FROM rotations", null).use { it.moveToFirst(); assertContentEquals(before, it.getBlob(0)) } }
        assertEquals(0, keys.retirements)
    }

    @Test fun interrupted_approved_delete_recovers_original_decision_after_crl_expiry() {
        val rotated = store().use { completeRotation(it) }
        val crl = IdentityFixtures.crl(rotated.old.publicCertificate(), nextUpdateAt = System.currentTimeMillis() + 2500)
        val proof = DeviceRevocationProof.parse(crl); keys.failAfterRetire = true
        store().use { storage -> assertFails { storage.retirePreviousKey(storage.previewKeyRetirement("retire-one", crl)) }; frozen(storage) }
        keys.failAfterRetire = false
        val deadline = System.currentTimeMillis() + 5000
        while (System.currentTimeMillis() < proof.nextUpdate && System.currentTimeMillis() < deadline) Thread.sleep(25)
        assertTrue(System.currentTimeMillis() >= proof.nextUpdate)
        store().use { storage ->
            assertFails { storage.previewKeyRetirement("retire-one", IdentityFixtures.crl(rotated.old.publicCertificate())) }
            storage.retirePreviousKey(storage.previewKeyRetirement("retire-one")); assertEquals("retired", storage.keyRetirements().single().phase)
        }
        assertEquals(1, keys.retirements); assertEquals(2, keys.creates)
    }

    /** 模拟已保存叶证书到期后的磁盘状态；不改变系统墙钟或产品的导入/TLS校验。 */
    private fun savedCertificateFixture(certificate: ByteArray) {
        database().use { db ->
            val record = db.rawQuery("SELECT binding,document FROM identity WHERE slot=1", null).use {
                assertTrue(it.moveToFirst()); LocalIdentityRecord.parse(vault.open(it.getBlob(1), "tv-identity-v1/${it.getString(0)}"))
            }
            val fingerprint = "sha256:" + java.security.MessageDigest.getInstance("SHA-256").digest((CertificateFactory.getInstance("X.509").generateCertificate(certificate.inputStream()) as X509Certificate).encoded).joinToString("") { "%02x".format(it.toInt() and 255) }
            val credentials = buildJsonObject {
                put("schema_version", 3); put("space_id", record.setup.identity.space); put("device_id", record.setup.identity.device)
                put("broker", record.setup.broker); put("ca_pem", record.setup.caPem); put("model_profile", record.setup.identity.profile.id)
                put("certificate_pem", certificate.toString(Charsets.US_ASCII)); put("key_reference", record.reference)
                put("public_key_fingerprint", record.publicKeyFingerprint!!); put("request_id", record.setup.requestId)
            }.toString().toByteArray()
            val encrypted = vault.seal(credentials, record.setup.binding)
            val values = android.content.ContentValues().apply { put("binding", record.setup.binding); put("credentials", encrypted) }
            if (db.update("agent", values, "slot=1", null) == 0) { values.put("slot", 1); db.insertOrThrow("agent", null, values) }
            db.execSQL("UPDATE identity SET document=? WHERE slot=1", arrayOf(vault.seal(record.copy(phase = "active", certificateFingerprint = fingerprint).encoded(), "tv-identity-v1/${record.setup.binding}")))
        }
    }

    private fun expiredIdentity(): DeviceMaintenanceIdentity {
        val request = store().use { it.requestIdentity(setup()).request!! }
        savedCertificateFixture(IdentityFixtures.sign(request.pem, expired = true))
        return store().use { it.maintenance()!! }
    }

    @Test fun expired_identity_is_maintenance_only_and_does_not_expose_tls_or_private_material() {
        val old = expiredIdentity()
        store().use { storage ->
            storage.authorize("com.example.player", true); storage.journal(old.binding).commit("confirmed-unknown-original-ledger".toByteArray())
            assertTrue(storage.maintenance()!!.expired); assertFails { storage.load() }
            assertFails { storage.requestIdentity(setup()) }; assertFails { storage.install(IdentityFixtures.legacy()) }
            assertEquals("active", storage.identityRequest()!!.phase)
            assertEquals(setOf("com.example.player"), storage.allowed()); assertContentEquals("confirmed-unknown-original-ledger".toByteArray(), storage.journal(old.binding).read())
        }
        assertFalse(old.javaClass.methods.any { it.name in setOf("tls", "encoded") })
        assertFails { DeviceTls.create(old.identity, old.setupForRequest("inspect").caPem.toByteArray(), old.publicCertificate(), keys.load(old.keyReference!!)) }
        assertEquals(1, keys.creates)
    }

    @Test fun recovery_and_regular_rotation_require_the_correct_current_certificate_state() {
        store().use { storage ->
            activate(storage)
            assertEquals("identity_not_expired", assertFailsWith<AgentStoreFault> { storage.requestExpiredRecovery("recover-one") }.code)
        }
        val request = store().use { it.identityRequest()!!.request!! }
        savedCertificateFixture(IdentityFixtures.sign(request.pem, expired = true))
        store().use { storage ->
            assertEquals("expired_identity_requires_recovery", assertFailsWith<AgentStoreFault> { storage.requestRotation("rotate-one") }.code)
            assertNull(storage.rotationRequest())
        }
        assertEquals(1, keys.creates)
    }

    @Test fun expired_recovery_preserves_original_request_and_full_records_through_activation_and_retirement() {
        val old = expiredIdentity()
        val view = store().use { storage ->
            storage.authorize("com.example.player", true); storage.journal(old.binding).commit("full-original-ledger".toByteArray())
            storage.requestExpiredRecovery("recover-one")
        }
        assertTrue(view.expiredRecovery)
        store().use { storage ->
            assertEquals(view.candidate.request!!.pem, storage.requestExpiredRecovery("recover-one").candidate.request!!.pem)
            assertFails { storage.requestRotation("recover-one") }; assertFails { storage.requestExpiredRecovery("recover-two") }
            assertEquals(old.certificateFingerprint, storage.maintenance()!!.certificateFingerprint); assertFails { storage.load() }
        }
        val certificate = IdentityFixtures.sign(view.candidate.request!!.pem); val receipt = rotationReceipt(view, certificate)
        store().use { storage ->
            storage.activateRotation(storage.previewRotation(certificate, receipt))
            assertFalse(storage.maintenance()!!.expired); assertEquals(receipt.certificateFingerprint, storage.load()!!.certificateFingerprint)
            storage.load()!!.tls(); storage.activateRotation(storage.previewRotation(certificate, receipt))
            assertEquals(setOf("com.example.player"), storage.allowed()); assertContentEquals("full-original-ledger".toByteArray(), storage.journal(old.binding).read())
        }
        val proof = store().use { it.activationProof("recover-one") }
        store().use { storage ->
            assertEquals(proof, storage.activationProof("recover-one"))
            storage.confirmRotationManagement(rotationReceipt(view, certificate, true))
            storage.retirePreviousKey(storage.previewKeyRetirement("recover-one", IdentityFixtures.crl(old.publicCertificate())))
        }
        store().use { storage ->
            assertTrue(storage.rotationRequest()!!.managementCompleted); assertTrue(storage.rotationRequest()!!.expiredRecovery)
            assertEquals("retired", storage.keyRetirements().single().phase); storage.load()!!.tls()
        }
        assertEquals(2, keys.creates); assertEquals(1, keys.retirements)
    }

    @Test fun recovery_receipt_cannot_be_downgraded_or_substituted_for_regular_rotation() {
        expiredIdentity()
        val view = store().use { it.requestExpiredRecovery("recover-one") }
        val certificate = IdentityFixtures.sign(view.candidate.request!!.pem)
        val regular = rotationReceipt(view.copy(expiredRecovery = false), certificate)
        store().use { assertFails { it.previewRotation(certificate, regular) }; assertTrue(it.maintenance()!!.expired) }
        for (mutation in listOf<(MutableMap<String, JsonElement>) -> Unit>(
            { it.remove("recovery_reason") }, { it["recovery_reason"] = JsonPrimitive("manual") },
            { it["schema_version"] = JsonPrimitive(2) }, { it["schema_version"] = JsonPrimitive(4) }
        )) assertFails { rotationReceipt(view, certificate, change = mutation) }
        assertEquals(2, keys.creates)
    }

    @Test fun recovery_lost_key_creation_response_restores_original_key_and_csr_without_replacement() {
        expiredIdentity(); keys.failAfterCreate = true
        store().use { assertFails { it.requestExpiredRecovery("recover-one") }; frozen(it) }
        keys.failAfterCreate = false
        val first = store().use { it.requestExpiredRecovery("recover-one") }
        store().use { assertEquals(first.candidate.request!!.pem, it.requestExpiredRecovery("recover-one").candidate.request!!.pem) }
        assertEquals(2, keys.creates)
    }

    @Test fun recovery_missing_pending_key_is_not_recreated_or_replaced_by_another_request() {
        expiredIdentity(); store().use { it.requestExpiredRecovery("recover-one") }
        keys.pairs.remove(keys.pairs.keys.last())
        store().use { storage ->
            assertFails { storage.maintenance() }; assertFails { storage.requestExpiredRecovery("recover-one") }
            assertFails { storage.requestExpiredRecovery("recover-two") }; assertFails { storage.load() }
        }
        assertEquals(2, keys.creates)
    }

    @Test fun recovery_switch_failure_rolls_back_to_the_expired_original_and_recovers_same_candidate() {
        val old = expiredIdentity(); val view = store().use { it.requestExpiredRecovery("recover-one") }
        val certificate = IdentityFixtures.sign(view.candidate.request!!.pem); val receipt = rotationReceipt(view, certificate)
        vault.failRotationActive = true
        store().use { assertFails { it.activateRotation(it.previewRotation(certificate, receipt)) }; frozen(it) }
        vault.failRotationActive = false
        store().use { storage ->
            assertEquals(old.certificateFingerprint, storage.maintenance()!!.certificateFingerprint); assertFails { storage.load() }
            assertEquals(view.candidate.request!!.pem, storage.requestExpiredRecovery("recover-one").candidate.request!!.pem)
            storage.activateRotation(storage.previewRotation(certificate, receipt)); storage.load()!!.tls()
        }
        assertEquals(2, keys.creates)
    }

    private fun pendingRotationThatActuallyExpires(): Pair<RotationRequestView, ByteArray> {
        val request = store().use { it.requestIdentity(setup()).request!! }
        val certificate = IdentityFixtures.sign(request.pem, until = System.currentTimeMillis() + 4000)
        val previous = store().use { storage ->
            storage.activateIdentity(storage.previewCertificate(certificate)); storage.load()!!
        }
        val view = store().use { storage ->
            storage.authorize("com.example.player", true); storage.journal(previous.binding).commit("original-unknown-confirmed-ledger".toByteArray())
            storage.requestRotation("rotate-before-expiry")
        }
        val next = IdentityFixtures.sign(view.candidate.request!!.pem)
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (System.currentTimeMillis() < previous.certificateExpiresAt && System.nanoTime() < deadline) Thread.sleep(10)
        store().use { assertTrue(it.maintenance()!!.expired); assertFails { it.load() } }
        return view to next
    }

    @Test fun pending_rotation_enters_expired_maintenance_without_replacing_its_original_request() {
        val (original, certificate) = pendingRotationThatActuallyExpires()
        val receipt = rotationReceipt(original, certificate)
        val recovered = store().use { storage ->
            assertFails { storage.requestRotation("rotate-before-expiry") }
            assertFails { storage.previewRotation(certificate, receipt) }
            assertFails { storage.requestExpiredRecovery("new-request-must-not-bypass") }
            storage.requestExpiredRecovery("rotate-before-expiry")
        }
        assertEquals("pending_rotation", recovered.recoveryOrigin)
        assertEquals(original.candidate.request!!.pem, recovered.candidate.request!!.pem)
        assertEquals(original.candidate.request!!.publicKeyFingerprint, recovered.candidate.request!!.publicKeyFingerprint)
        store().use { storage ->
            val reopened = storage.rotationRequest()!!
            assertContentEquals(recovered.candidate.setup.encoded(), reopened.candidate.setup.encoded())
            assertEquals(recovered.candidate.request!!.pem, reopened.candidate.request!!.pem)
            assertEquals(recovered.candidate.request!!.csrSha256, reopened.candidate.request!!.csrSha256)
            assertEquals(recovered.candidate.request!!.publicKeyFingerprint, reopened.candidate.request!!.publicKeyFingerprint)
            assertEquals(recovered.previousSerial, reopened.previousSerial); assertEquals(recovered.previousCertificate, reopened.previousCertificate)
            assertTrue(reopened.expiredRecovery); assertEquals("pending_rotation", reopened.recoveryOrigin); assertFalse(reopened.managementCompleted)
            storage.activateRotation(storage.previewRotation(certificate, receipt))
            storage.activationProof("rotate-before-expiry")
            storage.confirmRotationManagement(rotationReceipt(original, certificate, true))
            assertFails { storage.previewRotation(certificate, rotationReceipt(recovered, certificate)) }
            assertEquals(setOf("com.example.player"), storage.allowed())
            assertContentEquals("original-unknown-confirmed-ledger".toByteArray(), storage.journal(storage.load()!!.binding).read())
        }
        store().use { assertTrue(it.rotationRequest()!!.managementCompleted); it.load()!!.tls() }
        assertEquals(2, keys.creates)
    }

    @Test fun pending_legacy_record_accepts_expired_recovery_only_after_the_original_conversion_is_durable() {
        val (original, certificate) = pendingRotationThatActuallyExpires()
        // 旧v1未保存旧alias；转换只取当前经核对的身份引用，不枚举密钥。
        database().use { db -> db.rawQuery("SELECT document FROM rotations", null).use {
            assertTrue(it.moveToFirst()); val binding = "tv-rotation-v1/${original.candidate.setup.binding}"
            val fields = DeviceDocument.parse(vault.open(it.getBlob(0), binding), 32768).toMutableMap()
            fields["schema_version"] = JsonPrimitive(1)
            for (name in listOf("previous_key_reference", "previous_certificate_pem", "retirement")) fields.remove(name)
            db.execSQL("UPDATE rotations SET document=?", arrayOf(vault.seal(DeviceDocument.canonical(JsonObject(fields)).toByteArray(), binding)))
        } }
        vault.failSealPhase = "pending"
        store().use { storage -> assertFails { storage.requestExpiredRecovery("rotate-before-expiry") }; frozen(storage) }
        vault.failSealPhase = null
        store().use { assertFalse(it.rotationRequest()!!.expiredRecovery) }
        val recovered = store().use { it.requestExpiredRecovery("rotate-before-expiry") }
        assertEquals(original.candidate.request!!.pem, recovered.candidate.request!!.pem)
        assertEquals("pending_rotation", recovered.recoveryOrigin)
        store().use { storage ->
            val receipt = rotationReceipt(recovered, certificate)
            storage.activateRotation(storage.previewRotation(certificate, receipt)); storage.activationProof("rotate-before-expiry")
            storage.confirmRotationManagement(rotationReceipt(recovered, certificate, true))
            assertEquals("retained", storage.keyRetirements().single().phase)
            storage.load()!!.tls()
        }
        assertEquals(2, keys.creates)
    }

    @Test fun expired_maintenance_still_rejects_future_wrong_ca_wrong_subject_and_wrong_key() {
        val request = store().use { it.requestIdentity(setup()).request!! }
        val other = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair().let { DeviceSigningKey.from(it.private, it.public) }
        val invalid = listOf(IdentityFixtures.sign(request.pem, future = true), IdentityFixtures.sign(request.pem, expired = true, foreignCa = true), IdentityFixtures.sign(request.pem, expired = true, subject = "foreign-device"), IdentityFixtures.sign(other.certificateRequest(setup().identity).pem, expired = true))
        for (certificate in invalid) {
            savedCertificateFixture(certificate)
            store().use { assertFails { it.maintenance() }; assertFails { it.requestExpiredRecovery("recover-one") } }
        }
        assertEquals(1, keys.creates)
    }

    @Test fun actual_nas_expired_recovery_preserves_identity_and_broker_rejects_the_expired_certificate() {
        val rootValue = System.getenv("LIMEIOT_TV_AGENT_IDENTITY_ROOT")
        assumeTrue("requires explicit isolated NAS CSR environment", rootValue != null)
        val root = java.nio.file.Paths.get(rootValue!!)
        val python = System.getenv("LIMEIOT_TV_AGENT_IDENTITY_PYTHON") ?: root.resolve(".dev/firmware-tools/venv/bin/python").toString()
        val work = Files.createTempDirectory(root.resolve(".dev"), "tv-expired-csr-", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")))
        val nas = work.resolve("nas")
        var managementSequence = 0
        fun management(vararg arguments: String): JsonObject {
            val process = ProcessBuilder(python, *arguments).directory(root.toFile()).redirectError(work.resolve("last-stderr.log").toFile()).start()
            if (!process.waitFor(20, TimeUnit.SECONDS)) { process.destroyForcibly(); fail("management command timed out") }
            val result = process.inputStream.readBytes()
            Files.write(work.resolve("management-result-${++managementSequence}.json"), result)
            assertEquals(0, process.exitValue(), "management command failed; see private fixture log")
            return DeviceDocument.parse(result, 65536)
        }
        management("deploy/nas/manage.py", "init", "--directory", nas.toString(), "--origin", "https://127.0.0.1:18443")
        val setup = DeviceIdentitySetup.parse(buildJsonObject {
            put("schema_version", 1); put("request_id", "tv-expired-initial"); put("space_id", "space-demo"); put("device_id", "device-lamp")
            put("broker", "ssl://127.0.0.1:8883"); put("model_profile", "android-tv-agent")
            put("ca_pem", Files.readAllBytes(nas.resolve("broker-tls/ca.crt")).toString(Charsets.US_ASCII))
        }.toString().toByteArray())
        val initial = store().use { it.requestIdentity(setup).request!! }
        val csr = work.resolve("expired.csr"); Files.write(csr, initial.pem.toByteArray())
        val oldCertificate = work.resolve("expired.crt")
        management("-c", """
            import json,os,sys
            from pathlib import Path
            from datetime import datetime,timedelta,timezone
            os.umask(0o077)
            sys.path.insert(0,"deploy/nas")
            from device_identity import openssl
            authority=Path(sys.argv[1])/"device-authority"
            now=datetime.now(timezone.utc)
            openssl("ca","-batch","-config",authority/"openssl.cnf","-extensions","client","-notext","-in",sys.argv[2],"-out",sys.argv[3],"-startdate",(now-timedelta(days=2)).strftime("%Y%m%d%H%M%SZ"),"-enddate",(now-timedelta(days=1)).strftime("%Y%m%d%H%M%SZ"))
            print(json.dumps({"fixture":True}))
        """.trimIndent(), nas.toString(), csr.toString(), oldCertificate.toString())
        savedCertificateFixture(Files.readAllBytes(oldCertificate))
        val previous = store().use { storage ->
            assertFails { storage.load() }; assertTrue(storage.maintenance()!!.expired)
            storage.authorize("com.example.player", true); storage.journal(setup.binding).commit("full-original-ledger-with-unknown".toByteArray())
            storage.maintenance()!!
        }
        val view = store().use { it.requestExpiredRecovery("tv-expired-recover") }
        store().use { assertEquals(view.candidate.request!!.pem, it.requestExpiredRecovery("tv-expired-recover").candidate.request!!.pem) }
        val nextCsr = work.resolve("recovery.csr"); Files.write(nextCsr, view.candidate.request!!.pem.toByteArray())
        val output = work.resolve("recovery-issued")
        val issued = management("deploy/nas/device_identity.py", "recover-csr", "--directory", nas.toString(), "--device-id", "device-lamp", "--csr", nextCsr.toString(),
            "--request-id", "tv-expired-recover", "--public-key-fingerprint", view.candidate.request!!.publicKeyFingerprint,
            "--previous-serial", previous.certificateSerial, "--previous-certificate-fingerprint", previous.certificateFingerprint, "--output", output.toString())
        assertEquals(JsonPrimitive(3), issued["schema_version"]); assertEquals(JsonPrimitive("certificate_expired"), issued["recovery_reason"])
        val receipt = DeviceRotationReceipt.parse(Files.readAllBytes(output.resolve("enrollment.json")))
        store().use { storage -> storage.activateRotation(storage.previewRotation(Files.readAllBytes(output.resolve("device.crt")), receipt)) }
        val current = store().use { it.load()!! }
        val proof = store().use { it.activationProof("tv-expired-recover") }
        store().use { storage ->
            assertEquals(proof, storage.activationProof("tv-expired-recover")); assertEquals(previous.binding, storage.load()!!.binding)
            assertEquals(setOf("com.example.player"), storage.allowed()); assertContentEquals("full-original-ledger-with-unknown".toByteArray(), storage.journal(previous.binding).read())
        }
        val port = java.net.ServerSocket(0).use { it.localPort }
        val config = work.resolve("mosquitto.conf")
        Files.write(config, ("listener $port 127.0.0.1\ncafile ${nas.resolve("broker-tls/ca.crt")}\ncertfile ${nas.resolve("broker-tls/server.crt")}\nkeyfile ${nas.resolve("broker-tls/server.key")}\ncrlfile ${nas.resolve("broker-tls/revoked.crl")}\nrequire_certificate true\nallow_anonymous true\npersistence false\n").toByteArray())
        fun broker(label: String): Process {
            val log = work.resolve("broker-$label.log")
            val child = ProcessBuilder(root.resolve(".dev/tools/mosquitto-build/src/mosquitto").toString(), "-c", config.toString()).redirectErrorStream(true).redirectOutput(log.toFile()).start()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (System.nanoTime() < deadline && child.isAlive) {
                if (String(Files.readAllBytes(log)).contains(" running")) return child
                Thread.sleep(20)
            }
            child.destroyForcibly(); child.waitFor(5, TimeUnit.SECONDS); fail("isolated Broker startup failed")
        }
        fun stop(child: Process) { child.destroy(); if (!child.waitFor(5, TimeUnit.SECONDS)) { child.destroyForcibly(); assertTrue(child.waitFor(5, TimeUnit.SECONDS)) } }
        fun connect() { (current.tls().socketFactory.createSocket("127.0.0.1", port) as SSLSocket).use {
            it.soTimeout = 5000; it.enabledProtocols = arrayOf("TLSv1.2"); it.sslParameters = it.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }; it.startHandshake()
        } }
        // 仅宿主夹具可以编码此测试旧键；产品维护对象没有私钥导出或TLS入口。
        val oldKey = work.resolve("expired-test-key.pem")
        Files.write(oldKey, ("-----BEGIN PRIVATE KEY-----\n" + Base64.getMimeEncoder(64, byteArrayOf(10)).encodeToString(keys.pairs.getValue(previous.keyReference!!).private.encoded) + "\n-----END PRIVATE KEY-----\n").toByteArray(), java.nio.file.StandardOpenOption.CREATE_NEW)
        Files.setPosixFilePermissions(oldKey, PosixFilePermissions.fromString("rw-------"))
        val before = broker("before-completion")
        try {
            val client = ProcessBuilder("openssl", "s_client", "-tls1_2", "-connect", "127.0.0.1:$port", "-cert", oldCertificate.toString(), "-key", oldKey.toString(), "-CAfile", nas.resolve("broker-tls/ca.crt").toString(), "-verify_return_error", "-verify_ip", "127.0.0.1").redirectErrorStream(true).redirectOutput(work.resolve("expired-client.log").toFile()).start()
            client.outputStream.close()
            if (!client.waitFor(8, TimeUnit.SECONDS)) { client.destroyForcibly(); fail("expired TLS rejection timed out") }
            assertNotEquals(0, client.exitValue()); assertTrue(Files.readAllBytes(work.resolve("expired-client.log")).toString(Charsets.UTF_8).contains("certificate expired"))
            connect()
        } finally { stop(before) }
        val completed = management("deploy/nas/device_identity.py", "complete-rotation", "--directory", nas.toString(), "--request-id", "tv-expired-recover", "--activation-proof", proof)
        val resolved = management("deploy/nas/device_identity.py", "resolve-csr", "--directory", nas.toString(), "--request-id", "tv-expired-recover")
        assertEquals(issued["request_sha256"], resolved["request_sha256"]); assertEquals(completed["certificate_sha256"], resolved["certificate_sha256"])
        store().use { storage -> storage.confirmRotationManagement(DeviceRotationReceipt.parse(DeviceDocument.canonical(resolved).toByteArray())) }
        val after = broker("after-completion")
        try {
            connect()
            store().use { storage ->
                storage.retirePreviousKey(storage.previewKeyRetirement("tv-expired-recover", Files.readAllBytes(nas.resolve("broker-tls/revoked.crl"))))
                assertTrue(storage.rotationRequest()!!.managementCompleted); assertEquals("retired", storage.keyRetirements().single().phase)
                assertEquals(setOf("com.example.player"), storage.allowed()); assertContentEquals("full-original-ledger-with-unknown".toByteArray(), storage.journal(previous.binding).read())
            }
            connect()
        } finally { stop(after) }
        assertEquals(2, keys.creates); assertFalse(keys.contains(previous.keyReference!!))
        Files.write(work.resolve("result.json"), buildJsonObject {
            put("passed", true); put("expired_identity_flow", true); put("real_nas_recover_csr", true); put("management_schema", 3)
            put("original_request_retained", true); put("sqlite_reopen", true); put("actual_broker", true); put("expired_tls_rejected", true)
            put("new_identity_accepted", true); put("activation_and_revocation", true); put("old_key_retired", true); put("key_creations", keys.creates)
            put("host_private_key_fixture", true); put("android_keystore", false); put("native_app_runtime", false); put("hardware", false)
        }.toString().toByteArray())
    }

    private class TestKeys : IdentityKeys, IdentityKeyRetirement {
        val pairs = linkedMapOf<String, KeyPair>(); var creates = 0
        var failBeforeCreate = false; var failAfterCreate = false
        var failBeforeRetire = false; var failAfterRetire = false; var retirements = 0
        override fun create(reference: String): DeviceSigningKey {
            check(!failBeforeCreate); check(reference !in pairs)
            val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
            pairs[reference] = pair; creates++
            check(!failAfterCreate)
            return load(reference)
        }
        override fun load(reference: String): DeviceSigningKey {
            val pair = pairs[reference] ?: throw AgentStoreFault("identity_key_unavailable")
            return DeviceSigningKey.from(pair.private, pair.public)
        }
        override fun contains(reference: String): Boolean = reference in pairs
        override fun retire(reference: String, expectedPublicKey: String) {
            check(!failBeforeRetire)
            if (!contains(reference)) return
            if (load(reference).publicKeyFingerprint != expectedPublicKey) throw AgentStoreFault("identity_mismatch")
            pairs.remove(reference); retirements++
            check(!failAfterRetire)
        }
    }
    private class TestVault : EnrollmentVault {
        private val key = KeyGenerator.getInstance("AES").apply { init(128) }.generateKey()
        var failSealPhase: String? = null; var failPendingReadback = false; var lastPendingCsr: String? = null
        var failRotationActive = false; var failProofSeal = false
        var failRetirementPhase: String? = null; var failRetiredReadback = false
        private var failOpen = false
        override fun seal(bytes: ByteArray, binding: String): ByteArray {
            if (binding.startsWith("tv-identity-v1/") || binding.startsWith("tv-rotation-v1/")) {
                val document = DeviceDocument.parse(bytes, 32768)
                val record = if (binding.startsWith("tv-rotation-v1/")) document["candidate"]!!.jsonObject else document
                val phase = record["phase"]!!.jsonPrimitive.content
                val retirement = (document["retirement"] as? JsonObject)?.get("phase")?.jsonPrimitive?.content
                if (retirement != null && retirement == failRetirementPhase) error("injected retirement write failure")
                if (retirement == "retired" && failRetiredReadback) { failRetiredReadback = false; failOpen = true }
                if (phase == failSealPhase) error("injected seal failure")
                if (binding.startsWith("tv-rotation-v1/") && (failRotationActive && phase == "active" || failProofSeal && document["proof"] != JsonNull)) error("injected rotation failure")
                if (phase == "pending") {
                    lastPendingCsr = record["csr_pem"]!!.jsonPrimitive.content
                    if (failPendingReadback) { failOpen = true; failPendingReadback = false }
                }
            }
            return Cipher.getInstance("AES/GCM/NoPadding").run { init(Cipher.ENCRYPT_MODE, key); updateAAD(binding.toByteArray()); iv + doFinal(bytes) }
        }
        override fun open(bytes: ByteArray, binding: String): ByteArray {
            if (failOpen) { failOpen = false; error("injected committed readback failure") }
            return Cipher.getInstance("AES/GCM/NoPadding").run { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12))); updateAAD(binding.toByteArray()); doFinal(bytes.copyOfRange(12, bytes.size)) }
        }
    }
}

private object IdentityFixtures {
    private val directory = Files.createTempDirectory("limeiot-tv-local-identity-")
    private var sequence = 0
    private fun openssl(vararg args: String) {
        val process = ProcessBuilder(listOf("openssl") + args).directory(directory.toFile()).redirectErrorStream(true).start()
        val output = process.inputStream.readBytes()
        check(process.waitFor() == 0) { "identity fixture preparation failed (${output.size} diagnostic bytes)" }
    }
    init {
        openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2", "-subj", "/CN=Test CA", "-keyout", "ca.key", "-out", "ca.crt", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign")
        openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2", "-subj", "/CN=Foreign CA", "-keyout", "foreign.key", "-out", "foreign.crt", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign")
        openssl("req", "-x509", "-key", "ca.key", "-days", "2", "-subj", "/CN=Test CA", "-out", "nocrl.crt", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign")
    }
    fun setup(request: String, broker: String, crlSigning: Boolean = true): DeviceIdentitySetup = DeviceIdentitySetup.parse(buildJsonObject {
        put("schema_version", 1); put("request_id", request); put("space_id", "space-demo"); put("device_id", "device-tv")
        put("broker", broker); put("model_profile", "android-tv-agent"); put("ca_pem", String(Files.readAllBytes(directory.resolve(if (crlSigning) "ca.crt" else "nocrl.crt")), Charsets.US_ASCII))
    }.toString().toByteArray())
    @Synchronized fun sign(csr: String, usage: String = "clientAuth", subject: String? = null, expired: Boolean = false, foreignCa: Boolean = false, future: Boolean = false, until: Long? = null): ByteArray {
        val name = "certificate-${++sequence}"
        Files.write(directory.resolve("$name.csr"), csr.toByteArray(Charsets.US_ASCII))
        Files.write(directory.resolve("$name.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=$usage\n".toByteArray())
        val authority = if (foreignCa) "foreign" else "ca"
        val args = mutableListOf("x509", "-req", "-in", "$name.csr", "-CA", "$authority.crt", "-CAkey", "$authority.key", "-CAcreateserial", "-days", "1", "-extfile", "$name.ext", "-out", "$name.crt")
        if (subject != null) args += listOf("-subj", "/CN=$subject")
        if (expired) args += listOf("-not_before", "20200101000000Z", "-not_after", "20200102000000Z")
        if (future) args += listOf("-not_before", "20990101000000Z", "-not_after", "20990102000000Z")
        if (until != null) args += listOf("-not_after", java.time.format.DateTimeFormatter.ofPattern("yyyyMMddHHmmss'Z'").withZone(java.time.ZoneOffset.UTC).format(java.time.Instant.ofEpochMilli(until)))
        openssl(*args.toTypedArray())
        return Files.readAllBytes(directory.resolve("$name.crt"))
    }
    fun legacy(): DeviceEnrollment {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val key = DeviceSigningKey.from(pair.private, pair.public)
        val setup = setup("legacy", "ssl://localhost:8883")
        val certificate = sign(key.certificateRequest(setup.identity).pem)
        val pem = "-----BEGIN PRIVATE KEY-----\n" + Base64.getMimeEncoder(64, byteArrayOf(10)).encodeToString(pair.private.encoded) + "\n-----END PRIVATE KEY-----\n"
        return DeviceEnrollment.parse(buildJsonObject {
            put("schema_version", 2); put("space_id", setup.identity.space); put("device_id", setup.identity.device)
            put("broker", setup.broker); put("model_profile", setup.identity.profile.id); put("ca_pem", setup.caPem)
            put("certificate_pem", String(certificate, Charsets.US_ASCII)); put("private_key_pem", pem)
        }.toString().toByteArray())
    }

    @Synchronized fun crl(vararg certificates: ByteArray, foreignCa: Boolean = false, expired: Boolean = false, future: Boolean = false, extension: String? = null, nextUpdateAt: Long? = null): ByteArray {
        val name = "revocation-${++sequence}"; val authority = if (foreignCa) "foreign" else "ca"
        val date = java.text.SimpleDateFormat("yyMMddHHmmss'Z'", java.util.Locale.ROOT).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
        val lines = certificates.joinToString("") {
            val cert = CertificateFactory.getInstance("X.509").generateCertificate(it.inputStream()) as X509Certificate
            val serial = cert.serialNumber.toString(16).uppercase().let { raw -> if (raw.length % 2 == 0) raw else "0$raw" }
            "R\t${date.format(cert.notAfter)}\t${date.format(java.util.Date(System.currentTimeMillis() - 1000))}\t$serial\tunknown\t/CN=device-tv\n"
        }
        Files.write(directory.resolve("$name.index"), lines.toByteArray())
        val config = "[ca]\ndefault_ca=authority\n[authority]\ndatabase=$name.index\nprivate_key=$authority.key\ncertificate=$authority.crt\ndefault_md=sha256\ndefault_crl_days=1\n" +
            (extension?.let { "crl_extensions=extensions\n[extensions]\n$it\n" } ?: "")
        Files.write(directory.resolve("$name.conf"), config.toByteArray())
        val args = mutableListOf("ca", "-gencrl", "-batch", "-config", "$name.conf", "-out", "$name.crl")
        if (expired) args += listOf("-crl_lastupdate", "20200101000000Z", "-crl_nextupdate", "20200102000000Z")
        if (future) args += listOf("-crl_lastupdate", "20990101000000Z", "-crl_nextupdate", "20990102000000Z")
        if (nextUpdateAt != null) args += listOf("-crl_nextupdate", date.format(java.util.Date(nextUpdateAt)))
        openssl(*args.toTypedArray())
        return Files.readAllBytes(directory.resolve("$name.crl"))
    }
}
