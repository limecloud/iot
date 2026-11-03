package run.limeai.iot.television

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import run.limeai.iot.device.DeviceIdentity
import java.security.KeyStore
import java.util.UUID

/** 独立端上门槛；编译此类不表示已取得实际EC持钥证据。 */
@RunWith(AndroidJUnit4::class)
class IdentityKeyRuntimeTest {
    @Test fun retired_fixture_key_requires_exact_public_key_and_remains_absent_after_reopen() {
        val alias = "limeiot-tv-identity-" + UUID.randomUUID().toString().replace("-", "")
        val keys = AndroidIdentityKeys(); val key = keys.create(alias)
        var rejected = false
        try { keys.retire(alias, "sha256:" + "00".repeat(32)) } catch (error: AgentStoreFault) { rejected = error.code == "identity_mismatch" }
        assertTrue(rejected); assertTrue(keys.contains(alias))
        keys.retire(alias, key.publicKeyFingerprint)
        assertFalse(AndroidIdentityKeys().contains(alias))
        keys.retire(alias, key.publicKeyFingerprint)
        assertFalse(keys.contains(alias))
    }
    @Test fun p256_identity_key_is_nonexportable_reopenable_and_never_recreated_by_read() {
        val alias = "limeiot-tv-identity-" + UUID.randomUUID().toString().replace("-", "")
        val keys = AndroidIdentityKeys()
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertFalse(store.containsAlias(alias))
        var absent = false
        try { keys.load(alias) } catch (error: AgentStoreFault) { absent = error.code == "identity_key_unavailable" }
        assertTrue(absent)
        assertFalse("read must not generate a replacement key", store.containsAlias(alias))
        val key = keys.create(alias)
        val request = key.certificateRequest(DeviceIdentity("space-runtime", "device-runtime"))
        assertTrue(request.pem.startsWith("-----BEGIN CERTIFICATE REQUEST-----\n"))
        assertFalse(request.pem.contains("PRIVATE KEY"))
        assertEquals(key.publicKeyFingerprint, request.publicKeyFingerprint)
        val privateKey = store.getKey(alias, null)
        assertNotNull(privateKey)
        assertNull("EC key encoding must remain unavailable", privateKey.encoded)
        assertEquals(key.publicKeyFingerprint, AndroidIdentityKeys().load(alias).publicKeyFingerprint)
        var duplicate = false
        try { keys.create(alias) } catch (error: AgentStoreFault) { duplicate = error.code == "identity_key_exists" }
        assertTrue("explicit create cannot replace an existing identity key", duplicate)
        assertEquals(key.publicKeyFingerprint, keys.load(alias).publicKeyFingerprint)
    }
}
