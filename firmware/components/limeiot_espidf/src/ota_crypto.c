/* 第三方密码学类型只出现在ESP-IDF适配器，公共SDK仅暴露字节端口。 */
#include "limeiot_espidf.h"
#include "crypto.h"
#include "psa/crypto.h"
#include "sodium.h"

bool li_esp_sha256(void *context, const uint8_t *data, size_t length, uint8_t result[32]) {
    (void)context; size_t actual = 0;
    return psa_hash_compute(PSA_ALG_SHA_256, data, length, result, 32, &actual) == PSA_SUCCESS && actual == 32;
}
static bool verify(void *context, const uint8_t public_key[32], const uint8_t *message, size_t length, const uint8_t signature[64]) {
    (void)context;
    return crypto_sign_ed25519_verify_detached(signature, message, (unsigned long long)length, public_key) == 0;
}
bool li_espidf_ota_crypto(li_ota_crypto_t *result) {
    if (!result || psa_crypto_init() != PSA_SUCCESS || sodium_init() < 0) return false;
    *result = (li_ota_crypto_t){NULL, li_esp_sha256, verify}; return true;
}
