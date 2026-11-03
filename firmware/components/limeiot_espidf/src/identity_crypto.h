#ifndef LI_IDENTITY_CRYPTO_H
#define LI_IDENTITY_CRYPTO_H
#include "limeiot_device_identity.h"
bool li_identity_key_generate(char[LI_IDENTITY_KEY_PEM_SIZE]);
bool li_identity_key_fingerprint(const char *, unsigned char[32]);
bool li_identity_ca_fingerprint(const char *, unsigned char[32]);
bool li_identity_certificate_fingerprint(const char *, unsigned char[32]);
bool li_identity_sign(const char *, const void *, size_t, char[LI_IDENTITY_PROOF_SIZE]);
bool li_identity_csr(const char *, const char *, char *, size_t);
bool li_identity_csr_matches(const char *, const char *, const char *);
bool li_identity_certificate(const char *, const char *, const char *, const char *);
/* 只放行已到期叶证书的诊断；CA/未来日期及其他验证仍严格执行。 */
bool li_identity_certificate_state(const char *, const char *, const char *, const char *, bool *);
bool li_espidf_storage_authenticate(const void *, size_t, unsigned char[32]);
#endif
