/* 仅供宿主测试；设备密码学由ESP适配器实现。 */
#ifndef LI_OTA_HOST_CRYPTO_H
#define LI_OTA_HOST_CRYPTO_H
#include "limeiot_ota.h"
#include <openssl/evp.h>
#include <string.h>
static bool hash(void *context, const uint8_t *data, size_t length, uint8_t result[32]) {
    unsigned size = 0;
    return (!context || strcmp(context, "hash-fail") != 0) && EVP_Digest(data, length, result, &size, EVP_sha256(), NULL) == 1 && size == 32;
}
static bool verify(void *context, const uint8_t public_key[32], const uint8_t *message, size_t length, const uint8_t signature[64]) {
    if (context && strcmp(context, "verify-fail") == 0) return false;
    EVP_PKEY *key = EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519, NULL, public_key, 32);
    EVP_MD_CTX *md = EVP_MD_CTX_new();
    bool ok = key && md && EVP_DigestVerifyInit(md, NULL, NULL, NULL, key) == 1 && EVP_DigestVerify(md, signature, 64, message, length) == 1;
    EVP_MD_CTX_free(md); EVP_PKEY_free(key); return ok;
}
#endif
