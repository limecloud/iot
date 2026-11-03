/* 固定ESP-IDF的PSA/Mbed TLS适配；不自定义密钥或证书算法。 */
#include "identity_crypto.h"
#include "mbedtls/oid.h"
#include "mbedtls/pk.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/x509_crt.h"
#include "mbedtls/x509_csr.h"
#include "psa/crypto.h"
#include "sodium.h"
#include <stdio.h>
#include <string.h>

static bool sha256(const void *data, size_t length, unsigned char digest[32]) {
    size_t actual = 0;
    return psa_hash_compute(PSA_ALG_SHA_256, data, length, digest, 32, &actual) == PSA_SUCCESS && actual == 32;
}
static bool p256(const mbedtls_pk_context *key, bool private_key) {
    return mbedtls_pk_get_bitlen(key) == 256
        && mbedtls_pk_get_key_type(key) == (private_key ? PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1) : PSA_KEY_TYPE_ECC_PUBLIC_KEY(PSA_ECC_FAMILY_SECP_R1));
}
static bool public_fingerprint(const mbedtls_pk_context *key, unsigned char digest[32]) {
    unsigned char der[256];
    int length = mbedtls_pk_write_pubkey_der(key, der, sizeof(der));
    return length > 0 && (size_t)length <= sizeof(der) && sha256(der + sizeof(der) - (size_t)length, (size_t)length, digest);
}
static bool single_certificate(const char *pem) {
    if (!pem || strlen(pem) >= LI_IDENTITY_CERT_PEM_SIZE) return false;
    const char *begin = "-----BEGIN CERTIFICATE-----", *end = "-----END CERTIFICATE-----";
    if (strncmp(pem, begin, strlen(begin))) return false;
    const char *body = pem + strlen(begin), *footer = strstr(body, end);
    if ((*body != '\n' && *body != '\r') || !footer || footer == body) return false;
    for (const char *p = body; p < footer; p++)
        if (!((*p >= 'A' && *p <= 'Z') || (*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9') || *p == '+' || *p == '/' || *p == '=' || *p == '\r' || *p == '\n')) return false;
    for (const char *p = footer + strlen(end); *p; p++) if (*p != '\r' && *p != '\n') return false;
    return true;
}
bool li_identity_key_generate(char output[LI_IDENTITY_KEY_PEM_SIZE]) {
    if (!output) return false;
    memset(output, 0, LI_IDENTITY_KEY_PEM_SIZE);
    psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
    mbedtls_svc_key_id_t key = 0;
    mbedtls_pk_context context; mbedtls_pk_init(&context);
    psa_set_key_type(&attributes, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
    psa_set_key_bits(&attributes, 256);
    psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_EXPORT | PSA_KEY_USAGE_SIGN_HASH | PSA_KEY_USAGE_VERIFY_HASH);
    psa_set_key_algorithm(&attributes, MBEDTLS_PK_ALG_ECDSA(PSA_ALG_SHA_256));
    bool valid = psa_crypto_init() == PSA_SUCCESS && psa_generate_key(&attributes, &key) == PSA_SUCCESS
        && mbedtls_pk_wrap_psa(&context, key) == 0
        && mbedtls_pk_write_key_pem(&context, (unsigned char *)output, LI_IDENTITY_KEY_PEM_SIZE) == 0;
    mbedtls_pk_free(&context);
    if (key) (void)psa_destroy_key(key);
    psa_reset_key_attributes(&attributes);
    if (!valid) mbedtls_platform_zeroize(output, LI_IDENTITY_KEY_PEM_SIZE);
    return valid;
}
bool li_identity_key_fingerprint(const char *pem, unsigned char digest[32]) {
    if (!pem || !digest || strlen(pem) >= LI_IDENTITY_KEY_PEM_SIZE || psa_crypto_init() != PSA_SUCCESS) return false;
    mbedtls_pk_context key; mbedtls_pk_init(&key);
    bool valid = mbedtls_pk_parse_key(&key, (const unsigned char *)pem, strlen(pem) + 1, NULL, 0) == 0
        && p256(&key, true) && public_fingerprint(&key, digest);
    mbedtls_pk_free(&key); return valid;
}
bool li_identity_ca_fingerprint(const char *pem, unsigned char digest[32]) {
    if (!digest || !single_certificate(pem) || psa_crypto_init() != PSA_SUCCESS) return false;
    mbedtls_x509_crt ca; mbedtls_x509_crt_init(&ca);
    bool valid = mbedtls_x509_crt_parse(&ca, (const unsigned char *)pem, strlen(pem) + 1) == 0
        && !ca.next && mbedtls_x509_crt_get_ca_istrue(&ca) == 1 && sha256(ca.raw.p, ca.raw.len, digest);
    mbedtls_x509_crt_free(&ca); return valid;
}
bool li_identity_certificate_fingerprint(const char *pem, unsigned char digest[32]) {
    if (!digest || !single_certificate(pem) || psa_crypto_init() != PSA_SUCCESS) return false;
    mbedtls_x509_crt certificate; mbedtls_x509_crt_init(&certificate);
    bool valid = mbedtls_x509_crt_parse(&certificate, (const unsigned char *)pem, strlen(pem) + 1) == 0
        && !certificate.next && sha256(certificate.raw.p, certificate.raw.len, digest);
    mbedtls_x509_crt_free(&certificate); return valid;
}
bool li_identity_sign(const char *pem, const void *message, size_t length, char proof[LI_IDENTITY_PROOF_SIZE]) {
    if (!pem || !message || !length || !proof || strlen(pem) >= LI_IDENTITY_KEY_PEM_SIZE) return false;
    memset(proof, 0, LI_IDENTITY_PROOF_SIZE);
    unsigned char digest[32] = {0}, signature[72] = {0}; size_t signature_size = 0;
    mbedtls_pk_context key; mbedtls_pk_init(&key);
    bool valid = psa_crypto_init() == PSA_SUCCESS && sha256(message, length, digest)
        && mbedtls_pk_parse_key(&key, (const unsigned char *)pem, strlen(pem) + 1, NULL, 0) == 0 && p256(&key, true)
        && mbedtls_pk_sign(&key, MBEDTLS_MD_SHA256, digest, sizeof(digest), signature, sizeof(signature), &signature_size) == 0;
    static const char hex[] = "0123456789abcdef";
    if (valid) for (size_t i = 0; i < signature_size; i++) { proof[i*2] = hex[signature[i] >> 4]; proof[i*2+1] = hex[signature[i] & 15]; }
    mbedtls_platform_zeroize(digest, sizeof(digest)); mbedtls_platform_zeroize(signature, sizeof(signature));
    mbedtls_pk_free(&key); return valid;
}
bool li_identity_csr(const char *pem, const char *device, char *output, size_t capacity) {
#if defined(MBEDTLS_X509_CSR_WRITE_C)
    if (!pem || !device || !output || !capacity || strlen(pem) >= LI_IDENTITY_KEY_PEM_SIZE) return false;
    memset(output, 0, capacity);
    char subject[LI_ID_SIZE + 3];
    int count = snprintf(subject, sizeof(subject), "CN=%s", device);
    if (count <= 0 || (size_t)count >= sizeof(subject) || psa_crypto_init() != PSA_SUCCESS) return false;
    mbedtls_pk_context key; mbedtls_pk_init(&key);
    mbedtls_x509write_csr csr; mbedtls_x509write_csr_init(&csr);
    bool valid = mbedtls_pk_parse_key(&key, (const unsigned char *)pem, strlen(pem) + 1, NULL, 0) == 0 && p256(&key, true);
    if (valid) {
        mbedtls_x509write_csr_set_key(&csr, &key);
        mbedtls_x509write_csr_set_md_alg(&csr, MBEDTLS_MD_SHA256);
        valid = mbedtls_x509write_csr_set_subject_name(&csr, subject) == 0
            && mbedtls_x509write_csr_pem(&csr, (unsigned char *)output, capacity) == 0;
    }
    mbedtls_x509write_csr_free(&csr); mbedtls_pk_free(&key);
    if (!valid) memset(output, 0, capacity);
    return valid;
#else
    (void)pem; (void)device; (void)output; (void)capacity; return false;
#endif
}
bool li_identity_csr_matches(const char *private_pem, const char *device, const char *pem) {
    if (!private_pem || !device || !pem || strlen(pem) >= LI_IDENTITY_CSR_PEM_SIZE
        || strncmp(pem, "-----BEGIN CERTIFICATE REQUEST-----\n", strlen("-----BEGIN CERTIFICATE REQUEST-----\n"))) return false;
    const char *footer = strstr(pem, "-----END CERTIFICATE REQUEST-----");
    if (!footer) return false;
    for (const char *p = footer + strlen("-----END CERTIFICATE REQUEST-----"); *p; p++)
        if (*p != '\r' && *p != '\n') return false;
    mbedtls_x509_csr csr; mbedtls_x509_csr_init(&csr);
    unsigned char expected[32] = {0}, actual[32] = {0}, digest[32] = {0};
    bool valid = psa_crypto_init() == PSA_SUCCESS && mbedtls_x509_csr_parse(&csr, (const unsigned char *)pem, strlen(pem) + 1) == 0
        && !csr.subject.next && !csr.subject.MBEDTLS_PRIVATE(next_merged) && MBEDTLS_OID_CMP(MBEDTLS_OID_AT_CN, &csr.subject.oid) == 0
        && csr.subject.val.len == strlen(device) && !memcmp(csr.subject.val.p, device, csr.subject.val.len)
        && csr.MBEDTLS_PRIVATE(sig_md) == MBEDTLS_MD_SHA256 && p256(&csr.pk, false)
        && li_identity_key_fingerprint(private_pem, expected) && public_fingerprint(&csr.pk, actual)
        && sodium_memcmp(expected, actual, 32) == 0 && sha256(csr.cri.p, csr.cri.len, digest)
        && mbedtls_pk_verify(&csr.pk, MBEDTLS_MD_SHA256, digest, 32, csr.MBEDTLS_PRIVATE(sig).p, csr.MBEDTLS_PRIVATE(sig).len) == 0;
    mbedtls_platform_zeroize(expected, sizeof(expected)); mbedtls_platform_zeroize(actual, sizeof(actual));
    mbedtls_platform_zeroize(digest, sizeof(digest)); mbedtls_x509_csr_free(&csr); return valid;
}
static int maintenance_verify(void *context, mbedtls_x509_crt *certificate, int depth, uint32_t *flags) {
    (void)context; (void)certificate;
    if (depth == 0) *flags &= ~MBEDTLS_X509_BADCERT_EXPIRED;
    return 0;
}
bool li_identity_certificate_state(const char *private_pem, const char *certificate, const char *ca_pem, const char *device, bool *expired) {
    if (!expired) return false;
    *expired = false;
#if !defined(MBEDTLS_HAVE_TIME_DATE)
    (void)private_pem; (void)certificate; (void)ca_pem; (void)device;
    return false;
#else
    if (!private_pem || !device || !single_certificate(certificate) || !single_certificate(ca_pem) || psa_crypto_init() != PSA_SUCCESS) return false;
    mbedtls_x509_crt leaf, ca; mbedtls_x509_crt_init(&leaf); mbedtls_x509_crt_init(&ca);
    unsigned char expected[32] = {0}, actual[32] = {0}; uint32_t flags = 0;
    mbedtls_x509_crt_profile profile = mbedtls_x509_crt_profile_default;
    profile.allowed_mds = MBEDTLS_X509_ID_FLAG(MBEDTLS_MD_SHA256);
    bool valid = mbedtls_x509_crt_parse(&leaf, (const unsigned char *)certificate, strlen(certificate) + 1) == 0
        && mbedtls_x509_crt_parse(&ca, (const unsigned char *)ca_pem, strlen(ca_pem) + 1) == 0
        && !leaf.next && !ca.next && mbedtls_x509_crt_has_ext_type(&leaf, MBEDTLS_X509_EXT_BASIC_CONSTRAINTS)
        && mbedtls_x509_crt_get_ca_istrue(&leaf) == 0 && mbedtls_x509_crt_get_ca_istrue(&ca) == 1
        && !leaf.subject.next && !leaf.subject.MBEDTLS_PRIVATE(next_merged) && MBEDTLS_OID_CMP(MBEDTLS_OID_AT_CN, &leaf.subject.oid) == 0
        && leaf.subject.val.len == strlen(device) && !memcmp(leaf.subject.val.p, device, leaf.subject.val.len)
        && mbedtls_x509_crt_has_ext_type(&leaf, MBEDTLS_X509_EXT_KEY_USAGE)
        && mbedtls_x509_crt_has_ext_type(&leaf, MBEDTLS_X509_EXT_EXTENDED_KEY_USAGE)
        && mbedtls_x509_crt_check_key_usage(&leaf, MBEDTLS_X509_KU_DIGITAL_SIGNATURE) == 0
        && !leaf.ext_key_usage.next && MBEDTLS_OID_CMP(MBEDTLS_OID_CLIENT_AUTH, &leaf.ext_key_usage.buf) == 0
        && p256(&leaf.pk, false) && li_identity_key_fingerprint(private_pem, expected)
        && public_fingerprint(&leaf.pk, actual) && sodium_memcmp(expected, actual, sizeof(expected)) == 0
        && mbedtls_x509_crt_verify_with_profile(&leaf, &ca, NULL, &profile, NULL, &flags, maintenance_verify, NULL) == 0 && flags == 0;
    const unsigned prohibited[] = {MBEDTLS_X509_KU_NON_REPUDIATION, MBEDTLS_X509_KU_KEY_ENCIPHERMENT,
        MBEDTLS_X509_KU_DATA_ENCIPHERMENT, MBEDTLS_X509_KU_KEY_AGREEMENT, MBEDTLS_X509_KU_KEY_CERT_SIGN, MBEDTLS_X509_KU_CRL_SIGN};
    for (size_t i = 0; valid && i < sizeof(prohibited)/sizeof(prohibited[0]); i++)
        if (mbedtls_x509_crt_check_key_usage(&leaf, prohibited[i]) == 0) valid = false;
    if (valid) *expired = mbedtls_x509_time_is_past(&leaf.valid_to) != 0;
    mbedtls_platform_zeroize(expected, sizeof(expected)); mbedtls_platform_zeroize(actual, sizeof(actual));
    mbedtls_x509_crt_free(&leaf); mbedtls_x509_crt_free(&ca); return valid;
#endif
}
bool li_identity_certificate(const char *private_pem, const char *certificate, const char *ca_pem, const char *device) {
    bool expired = false;
    return li_identity_certificate_state(private_pem, certificate, ca_pem, device, &expired) && !expired;
}
