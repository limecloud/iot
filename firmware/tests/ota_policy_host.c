/* JSON只为测试夹具转成独立本地策略/驱动读数，不是设备的网络输入接口。 */
#include "limeiot_ota.h"
#include "ota_host_crypto.h"
#include "cJSON.h"
#include <stdio.h>
#include <stdlib.h>

typedef struct {
    cJSON *local;
    li_device_info_t info;
    unsigned reads, clocks;
} host_t;
static const cJSON *field(const cJSON *object, const char *name) { return cJSON_GetObjectItemCaseSensitive(object, name); }
static const char *text(const cJSON *object, const char *name) { return cJSON_GetStringValue(field(object, name)); }
static double number(const cJSON *object, const char *name) { return cJSON_GetNumberValue(field(object, name)); }
static bool fault(host_t *host, const char *name) {
    const char *value = text(host->local, "fault"); return value && !strcmp(value, name);
}
static bool read_info(void *context, li_device_info_t *info) {
    host_t *host = context; host->reads++;
    *info = host->info;
    return !fault(host, "device-unavailable");
}
static bool read_time(void *context, int64_t *now) {
    host_t *host = context; host->clocks++;
    *now = (int64_t)number(host->local, "now");
    if (fault(host, "expire-during-device-read") && host->reads) *now = INT64_C(4070908800);
    return !fault(host, "clock-untrusted");
}
static size_t list(const cJSON *object, const char *name, const char **values, size_t capacity) {
    const cJSON *array = field(object, name); int count = cJSON_GetArraySize(array);
    if (!cJSON_IsArray(array) || count < 0 || (size_t)count > capacity) return capacity+1;
    for (int i = 0; i < count; i++) values[i] = cJSON_GetStringValue(cJSON_GetArrayItem(array, i));
    return (size_t)count;
}
static char *read_file(const char *path, size_t *length) {
    FILE *file = fopen(path, "rb"); if (!file) return NULL;
    char *raw = calloc(LI_MAX_PACKET+2, 1); if (!raw) { fclose(file); return NULL; }
    *length = fread(raw, 1, LI_MAX_PACKET+1, file);
    bool ok = !ferror(file); fclose(file);
    if (!ok) { free(raw); return NULL; } return raw;
}
int main(int argc, char **argv) {
    if (argc != 3 && argc != 4) return 5;
    size_t length = 0, local_length = 0;
    char *raw = read_file(argv[1], &length), *local_raw = read_file(argv[2], &local_length);
    cJSON *local = local_raw ? cJSON_ParseWithLength(local_raw, local_length) : NULL;
    if (!raw || !local) { free(raw); free(local_raw); cJSON_Delete(local); return 5; }
    const cJSON *trust = field(local, "trust"), *device = field(local, "device");
    const char *products[16] = {0}, *origins[8] = {0}, *revoked[128] = {0};
    host_t host = {.local = local};
    li_ota_crypto_t crypto = {NULL, hash, verify}; li_ota_key_t key = {0};
    li_error_t error = li_ota_key_decode(&crypto, text(trust, "public_key"), text(trust, "signing_key_id"), &key);
    li_ota_policy_t policy = {
        .key = &key, .product_ids = products, .product_count = list(trust, "product_ids", products, 16),
        .download_origins = origins, .origin_count = list(trust, "download_origins", origins, 8),
        .revoked_artifact_ids = revoked, .revoked_count = list(trust, "revoked_artifact_ids", revoked, 128),
        .minimum_security_epoch = (uint32_t)number(trust, "minimum_security_epoch"),
        .minimum_battery_percent = (uint8_t)number(trust, "minimum_battery_percent"),
        .not_before = (int64_t)number(local, "trust_not_before"), .expires_at = (int64_t)number(local, "trust_expires_at")
    };
    li_config_t identity = {.device_id = text(device, "device_id"), .model_revision = text(device, "model_revision"),
        .firmware_version = text(device, "firmware_version"), .hardware_revision = text(device, "hardware_revision")};
    host.info = (li_device_info_t){.product_id=text(device,"product_id"), .architecture=text(device,"architecture"),
        .chip=text(device,"chip"), .board=text(device,"board"), .bootloader_version=text(device,"bootloader_version"),
        .security_epoch=(uint32_t)number(device,"security_epoch"), .ota_capacity_bytes=(uint32_t)number(device,"ota_capacity_bytes"),
        .external_power=cJSON_IsTrue(field(device,"external_power")), .has_battery=cJSON_IsNumber(field(device,"battery_percent")),
        .battery_percent=cJSON_IsNumber(field(device,"battery_percent")) ? (uint8_t)number(device,"battery_percent") : 0,
        .safe_to_update=cJSON_IsTrue(field(device,"safe_to_update")), .pending_update=cJSON_IsTrue(field(device,"pending_update"))};
    li_ota_environment_t environment = {&host, &identity, read_info, read_time};
    if (fault(&host,"no-clock-port")) environment.trusted_unix_seconds = NULL;
    if (fault(&host,"no-device-port")) environment.read_device_info = NULL;
    if (fault(&host,"no-identity")) environment.identity = NULL;
    if (fault(&host,"no-key")) policy.key = NULL;
    if (fault(&host,"no-products")) policy.product_ids = NULL;
    if (fault(&host,"no-origins")) policy.download_origins = NULL;
    if (fault(&host,"no-revocations")) { policy.revoked_count = 1; policy.revoked_artifact_ids = NULL; }
    li_ota_trust_t *decoded = NULL; bool trust_decoded = false;
    const li_ota_policy_t *active_policy = &policy;
    if (argc == 4 && error == LI_OK) {
        size_t trust_length = 0; char *trust_raw = read_file(argv[3], &trust_length);
        error = trust_raw ? li_ota_trust_decode(&crypto, trust_raw, trust_length, &decoded) : LI_INVALID;
        /* 解码后的策略必须拥有内容，不能引用已释放的输入字节。 */
        if (trust_raw) memset(trust_raw, 0xa5, trust_length);
        free(trust_raw);
        active_policy = li_ota_trust_policy(decoded); trust_decoded = active_policy != NULL;
        if (error == LI_OK && li_ota_policy_validate(&crypto, active_policy) != LI_OK) error = LI_INVALID;
    }
    li_ota_candidate_t result; memset(&result, 0xa5, sizeof(result)); const char *issue = "invalid_ota_key";
    if (error == LI_OK) error = li_ota_preflight(&crypto, active_policy, &environment, raw, length, &result, &issue);
    else { memset(&result, 0, sizeof(result)); if (argc == 4) issue = "invalid_ota_policy"; }
    bool cleared = true;
    for (size_t i = 0; i < sizeof(result); i++) if (((const uint8_t *)&result)[i]) cleared = false;
    cJSON *out = cJSON_CreateObject();
    cJSON_AddBoolToObject(out,"accepted",error==LI_OK); cJSON_AddStringToObject(out,"issue",issue);
    cJSON_AddBoolToObject(out,"candidate_cleared",cleared);
    cJSON_AddBoolToObject(out,"trust_decoded",trust_decoded);
    cJSON_AddBoolToObject(out,"null_policy_accessor",li_ota_trust_policy(NULL)==NULL);
    cJSON_AddNumberToObject(out,"device_reads",host.reads); cJSON_AddNumberToObject(out,"clock_reads",host.clocks);
    cJSON_AddStringToObject(out,"manifest_digest",result.authentication.manifest_digest);
    cJSON_AddStringToObject(out,"artifact_id",result.artifact_id); cJSON_AddStringToObject(out,"version",result.version);
    cJSON_AddStringToObject(out,"download_url",result.download_url); cJSON_AddStringToObject(out,"image_sha256",result.image_sha256);
    cJSON_AddNumberToObject(out,"size_bytes",result.size_bytes); cJSON_AddNumberToObject(out,"security_epoch",result.security_epoch);
    cJSON_AddNumberToObject(out,"issued_at",(double)result.issued_at); cJSON_AddNumberToObject(out,"expires_at",(double)result.expires_at);
    char *output = cJSON_PrintUnformatted(out); if (!output) return 5;
    puts(output); free(output); cJSON_Delete(out); li_ota_trust_destroy(decoded); li_ota_trust_destroy(NULL); cJSON_Delete(local); free(raw); free(local_raw);
    return error == LI_OK ? 0 : 2;
}
