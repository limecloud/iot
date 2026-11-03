package run.limeai.iot.television

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import run.limeai.iot.device.DeviceSigningKey
import run.limeai.iot.device.DeviceKeyResolver
import run.limeai.iot.device.DeviceKeyReference
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.spec.ECGenParameterSpec

/** 仅提供明确创建/读取；请求与alias归属由耐久身份流程管理，读取绝不补建丢失密钥。 */
interface IdentityKeys : DeviceKeyResolver { fun create(reference: String): DeviceSigningKey }
interface IdentityKeyRetirement {
    fun contains(reference: String): Boolean
    fun retire(reference: String, expectedPublicKey: String)
}

class AndroidIdentityKeys : IdentityKeys, IdentityKeyRetirement {
    override fun create(reference: String): DeviceSigningKey = synchronized(lock) {
        val alias = reference
        checked(alias)
        if (store().containsAlias(alias)) throw AgentStoreFault("identity_key_exists")
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
            initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false).build())
        }.generateKeyPair()
        load(alias)
    }

    override fun load(reference: String): DeviceSigningKey = synchronized(lock) {
        val alias = reference
        checked(alias)
        val store = store()
        val privateKey = store.getKey(alias, null) as? PrivateKey ?: throw AgentStoreFault("identity_key_unavailable")
        val publicKey = store.getCertificate(alias)?.publicKey ?: throw AgentStoreFault("identity_key_unavailable")
        DeviceSigningKey.from(privateKey, publicKey)
    }

    override fun contains(reference: String): Boolean = synchronized(lock) { checked(reference); store().containsAlias(reference) }

    /** 仅由已提交的清理意图调用；比较实际公钥后删除，缺席可供原意图幂等恢复。 */
    override fun retire(reference: String, expectedPublicKey: String): Unit = synchronized(lock) {
        checked(reference)
        val store = store()
        if (!store.containsAlias(reference)) return@synchronized
        if (load(reference).publicKeyFingerprint != expectedPublicKey) throw AgentStoreFault("identity_mismatch")
        store.deleteEntry(reference)
        if (store.containsAlias(reference)) throw AgentStoreFault("key_retirement_unknown")
    }

    private fun store(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun checked(alias: String) {
        if (!DeviceKeyReference.valid(alias)) throw AgentStoreFault("invalid_identity_key_alias")
    }
    private companion object { val lock = Any() }
}
