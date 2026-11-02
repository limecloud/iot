#ifndef LI_ESPIDF_CRYPTO_H
#define LI_ESPIDF_CRYPTO_H
#include "limeiot_ota.h"
bool li_esp_sha256(void *, const uint8_t *, size_t, uint8_t[32]);
#endif
