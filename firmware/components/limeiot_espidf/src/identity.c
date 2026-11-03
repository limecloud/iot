/* 同一NVS Blob提交密钥与证书；不确定写入后冻结，必须重新打开读取实际状态。 */
#include "sdkconfig.h"
#include "identity_crypto.h"
#include "limeiot_espidf.h"
#include "mbedtls/platform_util.h"
#include "nvs.h"
#include "sodium.h"
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#define SPACE_OFFSET 16
#define DEVICE_OFFSET (SPACE_OFFSET + LI_ID_SIZE)
#define CA_OFFSET (DEVICE_OFFSET + LI_ID_SIZE)
#define KEY_OFFSET (CA_OFFSET + 32)
#define CERT_OFFSET (KEY_OFFSET + LI_IDENTITY_KEY_PEM_SIZE)
#define V1_MAC_OFFSET (CERT_OFFSET + LI_IDENTITY_CERT_PEM_SIZE)
#define V1_RECORD_SIZE (V1_MAC_OFFSET + 32)
#define ROTATION_OFFSET V1_MAC_OFFSET
#define PENDING_KEY_OFFSET (ROTATION_OFFSET + LI_ID_SIZE)
#define PREVIOUS_CERT_OFFSET (PENDING_KEY_OFFSET + LI_IDENTITY_KEY_PEM_SIZE)
#define V2_MAC_OFFSET (PREVIOUS_CERT_OFFSET + 32)
#define V2_RECORD_SIZE (V2_MAC_OFFSET + 32)
#define CSR_OFFSET V2_MAC_OFFSET
#define MAC_OFFSET (CSR_OFFSET + LI_IDENTITY_CSR_PEM_SIZE)
#define RECORD_SIZE (MAC_OFFSET + 32)
struct li_espidf_identity {
    li_espidf_identity_options_t options;
    nvs_handle_t storage;
    bool opened, present, frozen;
    char space[LI_ID_SIZE], device[LI_ID_SIZE], ca[LI_IDENTITY_CERT_PEM_SIZE];
    unsigned char ca_fingerprint[32], record[RECORD_SIZE];
};
static bool valid_id(const char *value) {
    if (!value || !*value || strlen(value) >= LI_ID_SIZE) return false;
    for (size_t i = 0; value[i]; i++) {
        char c = value[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) && (!i || (c != '_' && c != '-'))) return false;
    }
    return true;
}
static bool padded_string(const unsigned char *value, size_t size) {
    const unsigned char *end = memchr(value, 0, size);
    if (!end || end == value) return false;
    for (const unsigned char *p = end; p < value + size; p++) if (*p) return false;
    return true;
}
static bool zeroes(const unsigned char *value, size_t size) {
    for (size_t i = 0; i < size; i++) if (value[i]) return false;
    return true;
}
static uint32_t generation(const unsigned char *record) {
    if (record[8] == 1) return 0;
    uint32_t value = 0;
    for (size_t i = 0; i < 4; i++) value |= (uint32_t)record[10 + i] << (i*8);
    return value;
}
static void format_fingerprint(const unsigned char digest[32], char output[LI_IDENTITY_FINGERPRINT_SIZE]) {
    static const char hex[] = "0123456789abcdef";
    memset(output, 0, LI_IDENTITY_FINGERPRINT_SIZE); memcpy(output, "sha256:", 7);
    for (size_t i = 0; i < 32; i++) { output[7 + i*2] = hex[digest[i] >> 4]; output[8 + i*2] = hex[digest[i] & 15]; }
}
static bool record_valid(li_espidf_identity_t *identity, const unsigned char *record, size_t size) {
    bool v1 = size == V1_RECORD_SIZE && record[8] == 1, v2 = size == V2_RECORD_SIZE && record[8] == 2;
    bool v3 = size == RECORD_SIZE && record[8] == 3;
    if (!v1 && !v2 && !v3) return false;
    size_t mac_offset = size - 32;
    unsigned char mac[32] = {0}, public[32] = {0};
    bool valid = li_espidf_storage_authenticate(record, mac_offset, mac)
        && sodium_memcmp(mac, record + mac_offset, sizeof(mac)) == 0
        && !memcmp(record, "LI-ID01\0", 8) && (v1 ? (record[9] == 1 || record[9] == 2) : (record[9] == 2 || record[9] == 3))
        && (v3 ? (record[14] >= 1 && record[14] <= 2 && record[15] == 0) : zeroes(record + (v1 ? 10 : 14), v1 ? 6 : 2));
    valid = valid && padded_string(record + SPACE_OFFSET, LI_ID_SIZE) && padded_string(record + DEVICE_OFFSET, LI_ID_SIZE)
        && !strcmp((const char *)record + SPACE_OFFSET, identity->options.space_id)
        && !strcmp((const char *)record + DEVICE_OFFSET, identity->options.device_id)
        && sodium_memcmp(record + CA_OFFSET, identity->ca_fingerprint, 32) == 0
        && padded_string(record + KEY_OFFSET, LI_IDENTITY_KEY_PEM_SIZE)
        && li_identity_key_fingerprint((const char *)record + KEY_OFFSET, public);
    if (valid && record[9] == 1) valid = zeroes(record + CERT_OFFSET, LI_IDENTITY_CERT_PEM_SIZE);
    if (valid && record[9] != 1) valid = padded_string(record + CERT_OFFSET, LI_IDENTITY_CERT_PEM_SIZE);
    if (valid && !v1) {
        valid = padded_string(record + ROTATION_OFFSET, LI_ID_SIZE) && valid_id((const char *)record + ROTATION_OFFSET)
            && !zeroes(record + PREVIOUS_CERT_OFFSET, 32);
        if (valid && record[9] == 3) {
            unsigned char pending[32] = {0}, previous[32] = {0};
            valid = padded_string(record + PENDING_KEY_OFFSET, LI_IDENTITY_KEY_PEM_SIZE)
                && li_identity_key_fingerprint((const char *)record + PENDING_KEY_OFFSET, pending)
                && sodium_memcmp(public, pending, 32) != 0
                && li_identity_certificate_fingerprint((const char *)record + CERT_OFFSET, previous)
                && sodium_memcmp(previous, record + PREVIOUS_CERT_OFFSET, 32) == 0;
            mbedtls_platform_zeroize(pending, sizeof(pending)); mbedtls_platform_zeroize(previous, sizeof(previous));
        } else if (valid) valid = generation(record) > 0 && zeroes(record + PENDING_KEY_OFFSET, LI_IDENTITY_KEY_PEM_SIZE);
        if (valid && v3) valid = padded_string(record + CSR_OFFSET, LI_IDENTITY_CSR_PEM_SIZE)
            && li_identity_csr_matches((const char *)record + (record[9] == 3 ? PENDING_KEY_OFFSET : KEY_OFFSET),
                identity->device, (const char *)record + CSR_OFFSET);
    }
    mbedtls_platform_zeroize(mac, sizeof(mac)); mbedtls_platform_zeroize(public, sizeof(public));
    return valid;
}
static li_error_t usable(li_espidf_identity_t *identity) {
    if (!identity) return LI_INVALID;
    if (identity->frozen || !identity->opened) return LI_STORAGE;
    return identity->options.trusted_clock(identity->options.clock_context) ? LI_OK : LI_CLOCK;
}
static li_error_t persist(li_espidf_identity_t *identity, unsigned char *record) {
    size_t size = record[8] == 1 ? V1_RECORD_SIZE : record[8] == 2 ? V2_RECORD_SIZE : RECORD_SIZE, mac_offset = size - 32;
    bool valid = li_espidf_storage_authenticate(record, mac_offset, record + mac_offset);
    if (valid) valid = nvs_set_blob(identity->storage, "identity", record, size) == ESP_OK && nvs_commit(identity->storage) == ESP_OK;
    /* 关闭缓存句柄再重开回读；任何不确定结果禁止在当前对象上继续生成或导入。 */
    nvs_close(identity->storage); identity->opened = false;
    if (valid) {
        valid = nvs_open_from_partition("journal", "li-identity", NVS_READWRITE, &identity->storage) == ESP_OK;
        identity->opened = valid;
    }
    size_t length = size;
    unsigned char *readback = valid ? calloc(1, RECORD_SIZE) : NULL;
    valid = valid && readback && nvs_get_blob(identity->storage, "identity", readback, &length) == ESP_OK
        && length == size && sodium_memcmp(record, readback, size) == 0 && record_valid(identity, readback, size);
    if (readback) { mbedtls_platform_zeroize(readback, RECORD_SIZE); free(readback); }
    if (!valid) { identity->frozen = true; return LI_STORAGE; }
    memset(identity->record, 0, RECORD_SIZE); memcpy(identity->record, record, size);
    identity->present = true; return LI_OK;
}
li_error_t li_espidf_identity_open(const li_espidf_identity_options_t *options, li_espidf_identity_t **output) {
    if (!output) return LI_INVALID;
    *output = NULL;
    if (!options || !valid_id(options->space_id) || !valid_id(options->device_id) || !options->ca_pem
        || strlen(options->ca_pem) >= LI_IDENTITY_CERT_PEM_SIZE || !options->trusted_clock) return LI_INVALID;
#if !CONFIG_LIMEIOT_DEVICE_LOCAL_IDENTITY
    return LI_STORAGE;
#else
    li_espidf_identity_t *identity = calloc(1, sizeof(*identity));
    if (!identity) return LI_CAPACITY;
    identity->options = *options;
    memcpy(identity->space, options->space_id, strlen(options->space_id) + 1);
    memcpy(identity->device, options->device_id, strlen(options->device_id) + 1);
    memcpy(identity->ca, options->ca_pem, strlen(options->ca_pem) + 1);
    identity->options.space_id = identity->space; identity->options.device_id = identity->device; identity->options.ca_pem = identity->ca;
    li_error_t result = LI_STORAGE;
    if (!li_identity_ca_fingerprint(identity->ca, identity->ca_fingerprint)) { result = LI_INVALID; goto done; }
    if (li_espidf_storage_init_partition("journal") != LI_OK
        || li_espidf_storage_verify_identity(options->space_id, options->device_id) != LI_OK
        || nvs_open_from_partition("journal", "li-identity", NVS_READWRITE, &identity->storage) != ESP_OK) goto done;
    identity->opened = true;
    size_t length = RECORD_SIZE;
    esp_err_t read = nvs_get_blob(identity->storage, "identity", identity->record, &length);
    if (read != ESP_ERR_NVS_NOT_FOUND && (read != ESP_OK || !record_valid(identity, identity->record, length))) goto done;
    identity->present = read == ESP_OK;
    *output = identity; return LI_OK;
done:
    li_espidf_identity_close(identity); return result;
#endif
}
void li_espidf_identity_close(li_espidf_identity_t *identity) {
    if (!identity) return;
    if (identity->opened) nvs_close(identity->storage);
    mbedtls_platform_zeroize(identity, sizeof(*identity)); free(identity);
}
li_error_t li_espidf_identity_request(li_espidf_identity_t *identity, char *csr, size_t capacity, char fingerprint[LI_IDENTITY_FINGERPRINT_SIZE]) {
    if (!csr || !capacity || !fingerprint) return LI_INVALID;
    memset(csr, 0, capacity); memset(fingerprint, 0, LI_IDENTITY_FINGERPRINT_SIZE);
    li_error_t error = usable(identity); if (error != LI_OK) return error;
    if (capacity < LI_IDENTITY_CSR_PEM_SIZE) return LI_CAPACITY;
    if (identity->present && identity->record[9] != 1) return LI_CONFLICT;
    if (!identity->present) {
        unsigned char *record = calloc(1, RECORD_SIZE); if (!record) return LI_CAPACITY;
        memcpy(record, "LI-ID01\0", 8); record[8] = 1; record[9] = 1;
        memcpy(record + SPACE_OFFSET, identity->options.space_id, strlen(identity->options.space_id));
        memcpy(record + DEVICE_OFFSET, identity->options.device_id, strlen(identity->options.device_id));
        memcpy(record + CA_OFFSET, identity->ca_fingerprint, 32);
        if (!li_identity_key_generate((char *)record + KEY_OFFSET)) error = LI_DRIVER;
        else error = persist(identity, record);
        mbedtls_platform_zeroize(record, RECORD_SIZE); free(record);
        if (error != LI_OK) return error;
    }
    unsigned char digest[32] = {0};
    bool valid = li_identity_key_fingerprint((const char *)identity->record + KEY_OFFSET, digest)
        && li_identity_csr((const char *)identity->record + KEY_OFFSET, identity->options.device_id, csr, capacity);
    if (valid) format_fingerprint(digest, fingerprint);
    mbedtls_platform_zeroize(digest, sizeof(digest)); return valid ? LI_OK : LI_DRIVER;
}
li_error_t li_espidf_identity_import(li_espidf_identity_t *identity, const char *certificate) {
    li_error_t error = usable(identity); if (error != LI_OK) return error;
    if (!certificate || strlen(certificate) >= LI_IDENTITY_CERT_PEM_SIZE) return LI_INVALID;
    if (!identity->present) return LI_CONFLICT;
    if (identity->record[9] == 3) return LI_CONFLICT;
    if (!li_identity_certificate((const char *)identity->record + KEY_OFFSET, certificate, identity->options.ca_pem, identity->options.device_id)) return LI_INVALID;
    if (identity->record[9] == 2) return !strcmp((const char *)identity->record + CERT_OFFSET, certificate) ? LI_OK : LI_CONFLICT;
    unsigned char *record = malloc(RECORD_SIZE); if (!record) return LI_CAPACITY;
    memcpy(record, identity->record, RECORD_SIZE); record[9] = 2;
    memcpy(record + CERT_OFFSET, certificate, strlen(certificate) + 1);
    error = persist(identity, record); mbedtls_platform_zeroize(record, RECORD_SIZE); free(record); return error;
}
li_error_t li_espidf_identity_credentials(li_espidf_identity_t *identity, char *certificate, size_t certificate_size, char *private_key, size_t private_size) {
    if (!certificate || !private_key || !certificate_size || !private_size) return LI_INVALID;
    memset(certificate, 0, certificate_size); memset(private_key, 0, private_size);
    li_error_t error = usable(identity); if (error != LI_OK) return error;
    if (!identity->present || identity->record[9] == 1) return LI_CONFLICT;
    const char *key = (const char *)identity->record + KEY_OFFSET, *leaf = (const char *)identity->record + CERT_OFFSET;
    if (!li_identity_certificate(key, leaf, identity->options.ca_pem, identity->options.device_id)) return LI_INVALID;
    if (strlen(key) >= private_size || strlen(leaf) >= certificate_size) return LI_CAPACITY;
    memcpy(private_key, key, strlen(key) + 1); memcpy(certificate, leaf, strlen(leaf) + 1); return LI_OK;
}
li_error_t li_espidf_identity_status(li_espidf_identity_t *identity, li_espidf_identity_status_t *output) {
    if (!output) return LI_INVALID;
    memset(output, 0, sizeof(*output));
    li_error_t error = usable(identity); if (error != LI_OK) return error;
    if (!identity->present) return LI_OK;
    unsigned char digest[32] = {0};
    bool valid = li_identity_key_fingerprint((const char *)identity->record + KEY_OFFSET, digest);
    if (valid) format_fingerprint(digest, output->public_key_fingerprint);
    if (valid && identity->record[9] != 1) {
        valid = li_identity_certificate_state((const char *)identity->record + KEY_OFFSET,
            (const char *)identity->record + CERT_OFFSET, identity->ca, identity->device, &output->certificate_expired)
            && li_identity_certificate_fingerprint((const char *)identity->record + CERT_OFFSET, digest);
        if (valid) format_fingerprint(digest, output->certificate_fingerprint);
    }
    if (valid && identity->record[9] == 3) {
        valid = li_identity_key_fingerprint((const char *)identity->record + PENDING_KEY_OFFSET, digest);
        if (valid) format_fingerprint(digest, output->pending_public_key_fingerprint);
    }
    if (valid) {
        output->state = identity->record[9]; output->generation = generation(identity->record);
        if (identity->record[8] >= 2) memcpy(output->rotation_id, identity->record + ROTATION_OFFSET, LI_ID_SIZE);
        if (identity->record[8] == 3) output->recovery_origin = identity->record[14];
    } else memset(output, 0, sizeof(*output));
    mbedtls_platform_zeroize(digest, sizeof(digest)); return valid ? LI_OK : LI_INVALID;
}
li_error_t li_espidf_identity_rotate_request(li_espidf_identity_t *identity, const char *rotation_id,
    char *csr, size_t capacity, char fingerprint[LI_IDENTITY_FINGERPRINT_SIZE]) {
    if (!csr || !capacity || !fingerprint) return LI_INVALID;
    memset(csr, 0, capacity); memset(fingerprint, 0, LI_IDENTITY_FINGERPRINT_SIZE);
    li_error_t error = usable(identity); if (error != LI_OK) return error;
    if (!valid_id(rotation_id)) return LI_INVALID;
    if (capacity < LI_IDENTITY_CSR_PEM_SIZE) return LI_CAPACITY;
    if (!identity->present || identity->record[9] == 1 || generation(identity->record) == UINT32_MAX) return LI_CONFLICT;
    if (!li_identity_certificate((const char *)identity->record + KEY_OFFSET, (const char *)identity->record + CERT_OFFSET,
            identity->ca, identity->device)) return LI_INVALID;
    if (identity->record[9] == 3) {
        if (strcmp((const char *)identity->record + ROTATION_OFFSET, rotation_id)) return LI_CONFLICT;
        if (identity->record[8] == 3) return LI_CONFLICT;
    } else {
        if (identity->record[8] >= 2 && !strcmp((const char *)identity->record + ROTATION_OFFSET, rotation_id)) return LI_CONFLICT;
        unsigned char *record = calloc(1, RECORD_SIZE); if (!record) return LI_CAPACITY;
        memcpy(record, identity->record, V1_MAC_OFFSET); record[8] = 2; record[9] = 3;
        record[14] = record[15] = 0;
        memcpy(record + ROTATION_OFFSET, rotation_id, strlen(rotation_id));
        bool generated = li_identity_key_generate((char *)record + PENDING_KEY_OFFSET)
            && li_identity_certificate_fingerprint((const char *)record + CERT_OFFSET, record + PREVIOUS_CERT_OFFSET);
        if (!generated) error = LI_DRIVER;
        else error = persist(identity, record);
        mbedtls_platform_zeroize(record, RECORD_SIZE); free(record);
        if (error != LI_OK) return error;
    }
    unsigned char digest[32] = {0};
    bool valid = li_identity_key_fingerprint((const char *)identity->record + PENDING_KEY_OFFSET, digest)
        && li_identity_csr((const char *)identity->record + PENDING_KEY_OFFSET, identity->device, csr, capacity);
    if (valid) format_fingerprint(digest, fingerprint);
    mbedtls_platform_zeroize(digest, sizeof(digest)); return valid ? LI_OK : LI_DRIVER;
}
li_error_t li_espidf_identity_recover_request(li_espidf_identity_t *identity, const char *rotation_id,
    const char *original_csr, char *csr, size_t capacity, char fingerprint[LI_IDENTITY_FINGERPRINT_SIZE]) {
    if (!csr || !capacity || !fingerprint) return LI_INVALID;
    memset(csr, 0, capacity); memset(fingerprint, 0, LI_IDENTITY_FINGERPRINT_SIZE);
    li_error_t error = usable(identity); if (error != LI_OK) return error;
    if (!valid_id(rotation_id)) return LI_INVALID;
    if (capacity < LI_IDENTITY_CSR_PEM_SIZE) return LI_CAPACITY;
    if (!identity->present || identity->record[9] == 1 || generation(identity->record) == UINT32_MAX) return LI_CONFLICT;
    bool expired = false;
    if (!li_identity_certificate_state((const char *)identity->record + KEY_OFFSET, (const char *)identity->record + CERT_OFFSET,
            identity->ca, identity->device, &expired) || !expired) return LI_INVALID;
    if (identity->record[9] == 3) {
        if (strcmp((const char *)identity->record + ROTATION_OFFSET, rotation_id)) return LI_CONFLICT;
        if (identity->record[8] == 3) {
            if (original_csr && strcmp(original_csr, (const char *)identity->record + CSR_OFFSET)) return LI_CONFLICT;
        } else if (!original_csr || !li_identity_csr_matches((const char *)identity->record + PENDING_KEY_OFFSET,
                identity->device, original_csr)) return LI_INVALID;
    } else if (identity->record[8] >= 2 && !strcmp((const char *)identity->record + ROTATION_OFFSET, rotation_id)) return LI_CONFLICT;
    if (identity->record[8] != 3 || identity->record[9] != 3) {
        bool pending = identity->record[9] == 3;
        if (!pending && original_csr) return LI_INVALID;
        unsigned char *record = calloc(1, RECORD_SIZE); if (!record) return LI_CAPACITY;
        memcpy(record, identity->record, pending ? V2_MAC_OFFSET : V1_MAC_OFFSET);
        record[8] = 3; record[9] = 3; record[14] = pending ? 2 : 1; record[15] = 0;
        if (pending) memcpy(record + CSR_OFFSET, original_csr, strlen(original_csr) + 1);
        else {
            memcpy(record + ROTATION_OFFSET, rotation_id, strlen(rotation_id));
            if (!li_identity_key_generate((char *)record + PENDING_KEY_OFFSET)
                || !li_identity_csr((const char *)record + PENDING_KEY_OFFSET, identity->device, (char *)record + CSR_OFFSET, LI_IDENTITY_CSR_PEM_SIZE)
                || !li_identity_certificate_fingerprint((const char *)record + CERT_OFFSET, record + PREVIOUS_CERT_OFFSET)) error = LI_DRIVER;
        }
        if (error == LI_OK) error = persist(identity, record);
        mbedtls_platform_zeroize(record, RECORD_SIZE); free(record);
        if (error != LI_OK) return error;
    }
    unsigned char digest[32] = {0};
    bool valid = li_identity_key_fingerprint((const char *)identity->record + PENDING_KEY_OFFSET, digest);
    if (valid) { memcpy(csr, identity->record + CSR_OFFSET, strlen((const char *)identity->record + CSR_OFFSET) + 1); format_fingerprint(digest, fingerprint); }
    mbedtls_platform_zeroize(digest, sizeof(digest)); return valid ? LI_OK : LI_DRIVER;
}
li_error_t li_espidf_identity_rotate_import(li_espidf_identity_t *identity, const char *rotation_id, const char *certificate) {
    li_error_t error = usable(identity); if (error != LI_OK) return error;
    if (!valid_id(rotation_id) || !certificate || strlen(certificate) >= LI_IDENTITY_CERT_PEM_SIZE) return LI_INVALID;
    if (!identity->present || identity->record[8] < 2 || strcmp((const char *)identity->record + ROTATION_OFFSET, rotation_id)) return LI_CONFLICT;
    if (identity->record[9] == 2) {
        return !strcmp((const char *)identity->record + CERT_OFFSET, certificate)
            && li_identity_certificate((const char *)identity->record + KEY_OFFSET, certificate, identity->ca, identity->device) ? LI_OK : LI_CONFLICT;
    }
    if (identity->record[9] != 3 || generation(identity->record) == UINT32_MAX) return LI_CONFLICT;
    bool expired = false;
    if (!li_identity_certificate_state((const char *)identity->record + KEY_OFFSET, (const char *)identity->record + CERT_OFFSET,
            identity->ca, identity->device, &expired) || (expired && identity->record[8] != 3)) return LI_INVALID;
    if (!li_identity_certificate((const char *)identity->record + PENDING_KEY_OFFSET, certificate, identity->ca, identity->device)) return LI_INVALID;
    unsigned char *record = malloc(RECORD_SIZE); if (!record) return LI_CAPACITY;
    memcpy(record, identity->record, RECORD_SIZE); record[9] = 2;
    uint32_t next = generation(record) + 1;
    for (size_t i = 0; i < 4; i++) record[10 + i] = (unsigned char)(next >> (i*8));
    memcpy(record + KEY_OFFSET, record + PENDING_KEY_OFFSET, LI_IDENTITY_KEY_PEM_SIZE);
    memset(record + PENDING_KEY_OFFSET, 0, LI_IDENTITY_KEY_PEM_SIZE);
    memset(record + CERT_OFFSET, 0, LI_IDENTITY_CERT_PEM_SIZE);
    memcpy(record + CERT_OFFSET, certificate, strlen(certificate) + 1);
    error = persist(identity, record); mbedtls_platform_zeroize(record, RECORD_SIZE); free(record); return error;
}
li_error_t li_espidf_identity_rotation_proof(li_espidf_identity_t *identity, const char *rotation_id,
    const char *challenge, char proof[LI_IDENTITY_PROOF_SIZE]) {
    if (!proof) return LI_INVALID;
    memset(proof, 0, LI_IDENTITY_PROOF_SIZE);
    li_error_t error = usable(identity); if (error != LI_OK) return error;
    if (!valid_id(rotation_id) || !challenge || strlen(challenge) != 64) return LI_INVALID;
    for (size_t i = 0; i < 64; i++) if (!((challenge[i] >= '0' && challenge[i] <= '9') || (challenge[i] >= 'a' && challenge[i] <= 'f'))) return LI_INVALID;
    if (!identity->present || identity->record[8] < 2 || generation(identity->record) == 0
        || (identity->record[9] != 2 && identity->record[9] != 3)) return LI_CONFLICT;
    if (!li_identity_certificate((const char *)identity->record + KEY_OFFSET, (const char *)identity->record + CERT_OFFSET, identity->ca, identity->device)) return LI_INVALID;
    unsigned char digest[32] = {0}; char certificate[LI_IDENTITY_FINGERPRINT_SIZE], message[384];
    bool valid = li_identity_certificate_fingerprint((const char *)identity->record + CERT_OFFSET, digest);
    if (valid) format_fingerprint(digest, certificate);
    int length = valid ? snprintf(message, sizeof(message), "limeiot.device-rotation-activate/v1\n%s\n%s\n%s\n%s\n%s",
        identity->space, identity->device, rotation_id, certificate, challenge) : -1;
    valid = valid && length > 0 && (size_t)length < sizeof(message)
        && li_identity_sign((const char *)identity->record + KEY_OFFSET, message, (size_t)length, proof);
    mbedtls_platform_zeroize(digest, sizeof(digest)); return valid ? LI_OK : LI_DRIVER;
}
