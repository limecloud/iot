/* 编译实际存储适配器；硬件和NVS调用均为显式宿主夹具。 */
#include "limeiot_espidf.h"
#include "storage_test_api.h"
#include <openssl/hmac.h>
#include <openssl/crypto.h>
#include <stdio.h>
#include <string.h>

static const char *mode;
static unsigned char image[4096], root_key[32];
static unsigned plain_calls, secure_calls, key_reads, hmac_calls, zero_calls;
static esp_partition_t partition = {4096, false, true};
static nvs_sec_scheme_t scheme = {NVS_SEC_SCHEME_HMAC};
static bool is(const char *value) { return !strcmp(mode, value); }
esp_efuse_purpose_t esp_efuse_get_key_purpose(esp_efuse_block_t block) { return block == EFUSE_BLK_KEY0 && !is("missing-key") ? ESP_EFUSE_KEY_PURPOSE_HMAC_UP : 0; }
bool esp_efuse_get_key_dis_read(esp_efuse_block_t block) { return block == EFUSE_BLK_KEY0 && !is("readable-key"); }
bool esp_efuse_get_key_dis_write(esp_efuse_block_t block) { return block == EFUSE_BLK_KEY0 && !is("writable-key"); }
bool esp_efuse_get_keypurpose_dis_write(esp_efuse_block_t block) { return block == EFUSE_BLK_KEY0 && !is("purpose-writable"); }
const esp_partition_t *esp_partition_find_first(int type, int subtype, const char *label) {
    if (is("missing-binding") || type != 1 || subtype != 0x40 || strcmp(label, "li-security")) return NULL;
    partition.size = is("wrong-size") ? 8192 : 4096; partition.encrypted = is("encrypted-binding");
    partition.readonly = !is("writable-binding"); return &partition;
}
esp_err_t esp_partition_read(const esp_partition_t *part, size_t offset, void *out, size_t length) {
    if (is("read-failed") || part != &partition || offset || length != 208) return ESP_FAIL;
    memcpy(out, image, length); return ESP_OK;
}
esp_err_t esp_hmac_calculate(hmac_key_id_t id, const void *data, size_t length, void *out) {
    hmac_calls++; if (is("hmac-failed") || id != 0) return ESP_FAIL;
    unsigned int size = 0;
    return HMAC(EVP_sha256(), root_key, 32, data, length, out, &size) && size == 32 ? ESP_OK : ESP_FAIL;
}
nvs_sec_scheme_t *nvs_flash_get_default_security_scheme(void) { scheme.scheme_id = is("wrong-scheme") ? 0 : NVS_SEC_SCHEME_HMAC; return is("missing-scheme") ? NULL : &scheme; }
esp_err_t nvs_flash_read_security_cfg_v2(nvs_sec_scheme_t *source, nvs_sec_cfg_t *keys) {
    key_reads++; if (source != &scheme || is("derivation-failed")) return ESP_FAIL;
    memset(keys, 0x5a, sizeof(*keys)); return ESP_OK;
}
esp_err_t nvs_flash_secure_init_partition(const char *name, nvs_sec_cfg_t *keys) {
    secure_calls++; if (strcmp(name, "nvs") && strcmp(name, "journal")) return ESP_FAIL;
    return keys->eky[0] == 0x5a && !is("nvs-failed") ? ESP_OK : ESP_FAIL;
}
esp_err_t nvs_flash_init_partition(const char *name) { plain_calls++; return !strcmp(name, "nvs") || !strcmp(name, "journal") ? ESP_OK : ESP_FAIL; }
void mbedtls_platform_zeroize(void *value, size_t size) { zero_calls++; OPENSSL_cleanse(value, size); }
int sodium_memcmp(const void *a, const void *b, size_t size) { return CRYPTO_memcmp(a, b, size); }
static bool load(const char *filename, unsigned char *out, size_t size) {
    FILE *file = fopen(filename, "rb"); if (!file) return false;
    bool valid = fread(out, 1, size, file) == size && fgetc(file) == EOF; fclose(file); return valid;
}
int main(int argc, char **argv) {
    if (argc != 4 || !load(argv[1], image, sizeof(image)) || !load(argv[2], root_key, sizeof(root_key))) return 5;
    mode = argv[3];
    if (is("bad-format")) image[0] ^= 1;
    if (is("wrong-id")) image[9] = 1;
    if (is("bad-mac")) image[176] ^= 1;
    if (is("wrong-root")) root_key[0] ^= 1;
    li_error_t result = li_espidf_storage_init_partition(is("unknown-partition") ? "secrets" : "nvs");
    if (result == LI_OK) result = li_espidf_storage_verify_identity(is("wrong-space") ? "another-space" : "space-demo", is("wrong-device") ? "other-device" : "device-lamp");
    if (result == LI_OK) result = li_espidf_storage_init_partition("journal");
    printf("{\"ok\":%s,\"plain_calls\":%u,\"secure_calls\":%u,\"key_reads\":%u,\"hmac_calls\":%u,\"zero_calls\":%u,\"hardware\":false}\n", result == LI_OK ? "true" : "false", plain_calls, secure_calls, key_reads, hmac_calls, zero_calls);
    return 0;
}
