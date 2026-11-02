package run.limeai.iot

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.security.MessageDigest
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class SecureStoreRuntimeTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private fun account(origin: String) = MessageDigest.getInstance("SHA-256").digest(origin.toByteArray()).joinToString("") { "%02x".format(it) }

    @Test fun encryptedStorageSurvivesNewAdapterAndKeepsOriginsSeparate() = runBlocking {
        val prefix = "https://runtime-${UUID.randomUUID()}.example.test"
        val cloud = "limeiot.control:v1:$prefix"
        val value = "test-only-session-${UUID.randomUUID()}"
        val store = SecureStore(context)
        try {
            store.save(prefix, value); store.save(cloud, "other-test-session")
            val stored = context.getSharedPreferences("local-sessions", Context.MODE_PRIVATE).getString(account(prefix), null)
            assertNotNull(stored); assertFalse(stored!!.contains(value))
            assertEquals(value, SecureStore(context).load(prefix))
            assertEquals("other-test-session", SecureStore(context).load(cloud))
            store.save(prefix, null)
            assertNull(store.load(prefix)); assertEquals("other-test-session", store.load(cloud))
        } finally { store.save(prefix, null); store.save(cloud, null) }
    }

    @Test fun movedOrCorruptCiphertextFailsAuthenticationWithoutReplacingIt() = runBlocking {
        val origin = "https://runtime-${UUID.randomUUID()}.example.test"
        val moved = "$origin#pending"
        val store = SecureStore(context)
        val preferences = context.getSharedPreferences("local-sessions", Context.MODE_PRIVATE)
        try {
            store.save(origin, "test-only-material")
            val ciphertext = preferences.getString(account(origin), null)!!
            check(preferences.edit().putString(account(moved), ciphertext).commit())
            assertTrue(runCatching { store.load(moved) }.isFailure)
            assertEquals(ciphertext, preferences.getString(account(moved), null))
            assertEquals("test-only-material", store.load(origin))
            check(preferences.edit().putString(account(origin), "not-a-ciphertext").commit())
            assertTrue(runCatching { store.load(origin) }.isFailure)
            assertEquals("not-a-ciphertext", preferences.getString(account(origin), null))
        } finally { store.save(origin, null); store.save(moved, null) }
    }
}
