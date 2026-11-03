#ifndef LI_STORAGE_TEST_API_H
#define LI_STORAGE_TEST_API_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_PARTITION_TYPE_DATA 1
#define EFUSE_BLK_KEY0 4
#define ESP_EFUSE_KEY_PURPOSE_HMAC_UP 8
#define NVS_SEC_SCHEME_HMAC 1
typedef int esp_efuse_block_t;
typedef int esp_efuse_purpose_t;
typedef int hmac_key_id_t;
typedef struct { uint32_t size; bool encrypted, readonly; } esp_partition_t;
typedef struct { unsigned char eky[32], tky[32]; } nvs_sec_cfg_t;
typedef struct { int scheme_id; } nvs_sec_scheme_t;
esp_efuse_purpose_t esp_efuse_get_key_purpose(esp_efuse_block_t);
bool esp_efuse_get_key_dis_read(esp_efuse_block_t);
bool esp_efuse_get_key_dis_write(esp_efuse_block_t);
bool esp_efuse_get_keypurpose_dis_write(esp_efuse_block_t);
const esp_partition_t *esp_partition_find_first(int, int, const char *);
esp_err_t esp_partition_read(const esp_partition_t *, size_t, void *, size_t);
esp_err_t esp_hmac_calculate(hmac_key_id_t, const void *, size_t, void *);
nvs_sec_scheme_t *nvs_flash_get_default_security_scheme(void);
esp_err_t nvs_flash_read_security_cfg_v2(nvs_sec_scheme_t *, nvs_sec_cfg_t *);
esp_err_t nvs_flash_secure_init_partition(const char *, nvs_sec_cfg_t *);
esp_err_t nvs_flash_init_partition(const char *);
void mbedtls_platform_zeroize(void *, size_t);
int sodium_memcmp(const void *, const void *, size_t);
#endif
