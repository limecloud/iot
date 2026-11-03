/* 只读取预置硬件密钥；缺失、错绑或损坏时拒绝初始化，不生成密钥或迁移明文。 */
#include "sdkconfig.h"
#include "limeiot_espidf.h"
#include "nvs_flash.h"
#include <string.h>

#if CONFIG_LIMEIOT_NVS_HMAC_PROTECTED
#if !CONFIG_NVS_ENCRYPTION || !CONFIG_NVS_SEC_KEY_PROTECT_USING_HMAC || CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID < 0 || CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID > 5
#error "LimeIoT protected storage requires an explicit HMAC NVS key block"
#endif
#include "esp_efuse.h"
#include "esp_hmac.h"
#include "esp_partition.h"
#include "nvs_sec_provider.h"
#include "mbedtls/platform_util.h"
#include "sodium.h"

static bool valid_id(const unsigned char *value, size_t length) {
    if (!length || length > 64) return false;
    for (size_t i = 0; i < 64; i++) {
        unsigned char c = value[i];
        if (i >= length) { if (c) return false; continue; }
        bool alphanumeric = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
        if (!alphanumeric && (i == 0 || (c != '_' && c != '-'))) return false;
    }
    return true;
}
static bool binding(const char *space, const char *device) {
    const esp_efuse_block_t block = (esp_efuse_block_t)(EFUSE_BLK_KEY0 + CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID);
    if (esp_efuse_get_key_purpose(block) != ESP_EFUSE_KEY_PURPOSE_HMAC_UP
        || !esp_efuse_get_key_dis_read(block) || !esp_efuse_get_key_dis_write(block)
        || !esp_efuse_get_keypurpose_dis_write(block)) return false;
    const esp_partition_t *partition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, 0x40, "li-security");
    unsigned char raw[208], mac[32];
    if (!partition || partition->size != 4096 || partition->encrypted || !partition->readonly
        || esp_partition_read(partition, 0, raw, sizeof(raw)) != ESP_OK
        || memcmp(raw, "LI-NVS1\0", 8) || raw[8] != 1 || raw[9] != CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID
        || !valid_id(raw + 12, raw[10]) || !valid_id(raw + 76, raw[11])
        || raw[172] || raw[173] || raw[174] || raw[175]) return false;
    if (esp_hmac_calculate((hmac_key_id_t)CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID, raw, 176, mac) != ESP_OK) return false;
    bool valid = sodium_memcmp(mac, raw + 176, sizeof(mac)) == 0;
    mbedtls_platform_zeroize(mac, sizeof(mac));
    if (space) valid = valid && strlen(space) == raw[11] && !memcmp(space, raw + 76, raw[11]);
    if (device) valid = valid && strlen(device) == raw[10] && !memcmp(device, raw + 12, raw[10]);
    return valid;
}
#endif

li_error_t li_espidf_storage_init_partition(const char *partition) {
    if (!partition || (strcmp(partition, "nvs") && strcmp(partition, "journal"))) return LI_INVALID;
#if CONFIG_LIMEIOT_NVS_HMAC_PROTECTED
    if (!binding(NULL, NULL)) return LI_STORAGE;
    nvs_sec_scheme_t *scheme = nvs_flash_get_default_security_scheme();
    nvs_sec_cfg_t keys = {0};
    if (!scheme || scheme->scheme_id != NVS_SEC_SCHEME_HMAC) return LI_STORAGE;
    /* 不使用nvs_flash_init：其缺钥分支会调用generate并写eFuse。 */
    esp_err_t result = nvs_flash_read_security_cfg_v2(scheme, &keys);
    if (result == ESP_OK) result = nvs_flash_secure_init_partition(partition, &keys);
    mbedtls_platform_zeroize(&keys, sizeof(keys));
    return result == ESP_OK ? LI_OK : LI_STORAGE;
#else
    return nvs_flash_init_partition(partition) == ESP_OK ? LI_OK : LI_STORAGE;
#endif
}

li_error_t li_espidf_storage_verify_identity(const char *space, const char *device) {
    if (!space || !device) return LI_INVALID;
#if CONFIG_LIMEIOT_NVS_HMAC_PROTECTED
    return binding(space, device) ? LI_OK : LI_STORAGE;
#else
    return LI_OK;
#endif
}

/* 身份单Blob使用独立格式域并认证全部密钥/证书字节；不提供旧备份防回退。 */
bool li_espidf_storage_authenticate(const void *data, size_t length, unsigned char mac[32]) {
#if CONFIG_LIMEIOT_NVS_HMAC_PROTECTED
    return data && length && mac && binding(NULL, NULL)
        && esp_hmac_calculate((hmac_key_id_t)CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID, data, length, mac) == ESP_OK;
#else
    (void)data; (void)length; (void)mac; return false;
#endif
}
