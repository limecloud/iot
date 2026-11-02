/* cJSON仅用于解析；本模块规范化固件合同的ASCII/安全整数子集，密码学由端口提供。 */
#include "limeiot_ota.h"
#include "cJSON.h"
#include "ota_internal.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define OTA_MAX_NODES 2048
#define OTA_DOMAIN "LimeIoT Device Firmware v1\n"
typedef struct { char *data; size_t size, capacity; } buffer_t;
static bool append(buffer_t *out, const char *value, size_t length) {
    if (length > out->capacity - out->size) return false;
    memcpy(out->data + out->size, value, length); out->size += length; return true;
}
static bool string(buffer_t *out, const char *value) {
    if (!append(out, "\"", 1)) return false;
    for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
        const char *escaped = NULL;
        switch (*p) {
            case '"': escaped = "\\\""; break;
            case '\\': escaped = "\\\\"; break;
            case '\b': escaped = "\\b"; break;
            case '\t': escaped = "\\t"; break;
            case '\n': escaped = "\\n"; break;
            case '\f': escaped = "\\f"; break;
            case '\r': escaped = "\\r"; break;
        }
        if (*p > 127) return false;
        if (escaped) { if (!append(out, escaped, 2)) return false; }
        else if (*p < 32) {
            char encoded[7]; snprintf(encoded, sizeof(encoded), "\\u%04x", (unsigned)*p);
            if (!append(out, encoded, 6)) return false;
        } else if (!append(out, (const char *)p, 1)) return false;
    }
    return append(out, "\"", 1);
}
static int compare(const void *a, const void *b) {
    return strcmp((*(const cJSON *const *)a)->string, (*(const cJSON *const *)b)->string);
}
static bool canonical(buffer_t *out, const cJSON *value, bool unsigned_manifest) {
    if (cJSON_IsObject(value)) {
        size_t count = (size_t)cJSON_GetArraySize(value), used = 0;
        const cJSON **fields = count ? malloc(count * sizeof(*fields)) : NULL;
        if (count && !fields) return false;
        for (const cJSON *field = value->child; field; field = field->next)
            if (!unsigned_manifest || strcmp(field->string, "signature") != 0) fields[used++] = field;
        if (used) qsort(fields, used, sizeof(*fields), compare);
        bool ok = append(out, "{", 1);
        for (size_t i = 0; ok && i < used; i++) {
            if (i && !append(out, ",", 1)) { ok = false; break; }
            ok = string(out, fields[i]->string) && append(out, ":", 1) && canonical(out, fields[i], false);
        }
        free(fields); return ok && append(out, "}", 1);
    }
    if (cJSON_IsArray(value)) {
        if (!append(out, "[", 1)) return false;
        for (const cJSON *item = value->child; item; item = item->next) {
            if (item != value->child && !append(out, ",", 1)) return false;
            if (!canonical(out, item, false)) return false;
        }
        return append(out, "]", 1);
    }
    if (cJSON_IsString(value)) return string(out, value->valuestring);
    if (cJSON_IsNumber(value)) {
        if (!isfinite(value->valuedouble) || fabs(value->valuedouble) > 9007199254740991.0 || trunc(value->valuedouble) != value->valuedouble) return false;
        char number[32]; int length = snprintf(number, sizeof(number), "%lld", (long long)value->valuedouble);
        return length > 0 && (size_t)length < sizeof(number) && append(out, number, (size_t)length);
    }
    if (cJSON_IsBool(value)) return append(out, cJSON_IsTrue(value) ? "true" : "false", cJSON_IsTrue(value) ? 4 : 5);
    return cJSON_IsNull(value) && append(out, "null", 4);
}
static bool bounded(const char *data, size_t length, size_t maximum) {
    if (!data || !length || length > maximum) return false;
    bool quoted = false; unsigned depth = 0;
    for (size_t i = 0; i < length; i++) {
        unsigned char ch = (unsigned char)data[i];
        if (!ch || ch > 127) return false;
        if (quoted) {
            if (ch == '\\') {
                if (++i >= length) return false;
                if (data[i] == 'u') {
                    if (length - i < 5 || memcmp(data + i + 1, "0000", 4) == 0) return false;
                }
            } else if (ch == '"') quoted = false;
            else if (ch < 32) return false;
        } else if (ch == '"') quoted = true;
        else if (ch == '{' || ch == '[') { if (++depth > 16) return false; }
        else if (ch == '}' || ch == ']') { if (!depth) return false; depth--; }
        else if (ch == '-' || (ch >= '0' && ch <= '9')) {
            size_t first = i;
            if (ch == '-') { if (++i >= length || data[i] < '0' || data[i] > '9') return false; first = i; }
            while (i + 1 < length && data[i+1] >= '0' && data[i+1] <= '9') i++;
            if (data[first] == '0' && i != first) return false;
            if (i + 1 < length && (data[i+1] == '.' || data[i+1] == 'e' || data[i+1] == 'E')) return false;
        }
    }
    return !quoted && !depth;
}
static bool unique(const cJSON *value, unsigned *remaining) {
    if (!*remaining) return false;
    (*remaining)--;
    for (const cJSON *field = value->child; field; field = field->next) {
        if (cJSON_IsObject(value)) {
            if (!field->string) return false;
            for (const cJSON *next = field->next; next; next = next->next)
                if (!next->string || strcmp(field->string, next->string) == 0) return false;
        }
        if (!unique(field, remaining)) return false;
    }
    return true;
}
cJSON *li_ota_document_parse_limit(const char *json, size_t length, size_t maximum) {
    if (!bounded(json, length, maximum)) return NULL;
    const char *end = NULL; cJSON *root = cJSON_ParseWithLengthOpts(json, length, &end, false);
    if (!root) return NULL;
    while (end < json+length && (*end == ' ' || *end == '\n' || *end == '\r' || *end == '\t')) end++;
    unsigned nodes = OTA_MAX_NODES;
    if (end != json+length || !cJSON_IsObject(root) || !unique(root, &nodes)) { cJSON_Delete(root); return NULL; }
    return root;
}
cJSON *li_ota_document_parse(const char *json, size_t length) { return li_ota_document_parse_limit(json, length, LI_MAX_PACKET); }
char *li_ota_json_encode(const cJSON *value, size_t maximum, size_t *length) {
    if (maximum > 32768) return NULL;
    buffer_t out = {.data = malloc(maximum+1), .capacity = maximum};
    if (!out.data || !value || !canonical(&out, value, false)) { free(out.data); return NULL; }
    out.data[out.size] = 0; if (length) *length = out.size; return out.data;
}
static int digit(unsigned char ch) {
    if (ch >= 'A' && ch <= 'Z') return ch - 'A';
    if (ch >= 'a' && ch <= 'z') return ch - 'a' + 26;
    if (ch >= '0' && ch <= '9') return ch - '0' + 52;
    return ch == '+' ? 62 : ch == '/' ? 63 : -1;
}
static bool base64(const char *text, uint8_t *out, size_t size) {
    if (!text || strlen(text) != ((size + 2)/3)*4) return false;
    size_t count = 0;
    for (size_t i = 0; text[i]; i += 4) {
        int a = digit((unsigned char)text[i]), b = digit((unsigned char)text[i+1]);
        int c = text[i+2] == '=' ? 0 : digit((unsigned char)text[i+2]);
        int d = text[i+3] == '=' ? 0 : digit((unsigned char)text[i+3]);
        if (a < 0 || b < 0 || c < 0 || d < 0) return false;
        if (count >= size) return false;
        out[count++] = (uint8_t)((a << 2) | (b >> 4));
        if (count == size) return text[i+2] == '=' && text[i+3] == '=' && !text[i+4] && (b & 15) == 0;
        if (text[i+2] == '=') return false;
        out[count++] = (uint8_t)((b << 4) | (c >> 2));
        if (count == size) return text[i+3] == '=' && !text[i+4] && (c & 3) == 0;
        if (text[i+3] == '=') return false;
        out[count++] = (uint8_t)((c << 6) | d);
    }
    return count == size;
}
static bool hash(const li_ota_crypto_t *ports, const uint8_t *data, size_t length, char result[72]) {
    uint8_t digest[32];
    if (!ports || !ports->sha256 || !ports->sha256(ports->context, data, length, digest)) return false;
    memcpy(result, "sha256:", 7);
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < 32; i++) { result[7+2*i] = hex[digest[i] >> 4]; result[8+2*i] = hex[digest[i] & 15]; }
    result[71] = 0; return true;
}
bool li_ota_json_hash(const li_ota_crypto_t *crypto, const cJSON *value, size_t maximum, char result[72]) {
    size_t length = 0; char *encoded = li_ota_json_encode(value, maximum, &length);
    bool ok = encoded && hash(crypto, (const uint8_t *)encoded, length, result);
    free(encoded); return ok;
}
li_error_t li_ota_key_validate(const li_ota_crypto_t *ports, const li_ota_key_t *key) {
    char fingerprint[72];
    if (!key || !memchr(key->signing_key_id, 0, sizeof(key->signing_key_id)) || !hash(ports, key->public_key, sizeof(key->public_key), fingerprint)) return LI_INVALID;
    return strcmp(fingerprint, key->signing_key_id) == 0 ? LI_OK : LI_INVALID;
}
li_error_t li_ota_key_decode(const li_ota_crypto_t *ports, const char *public_key, const char *key_id, li_ota_key_t *result) {
    if (!result) return LI_INVALID;
    memset(result, 0, sizeof(*result)); li_ota_key_t key = {0};
    if (!key_id || strlen(key_id) != 71 || !base64(public_key, key.public_key, sizeof(key.public_key))) return LI_INVALID;
    memcpy(key.signing_key_id, key_id, sizeof(key.signing_key_id));
    if (li_ota_key_validate(ports, &key) != LI_OK) return LI_INVALID;
    *result = key; return LI_OK;
}
static bool equals(const cJSON *root, const char *name, const char *expected) {
    const cJSON *value = cJSON_GetObjectItemCaseSensitive(root, name);
    return cJSON_IsString(value) && strcmp(value->valuestring, expected) == 0;
}
li_error_t li_ota_authenticate(const li_ota_crypto_t *ports, const li_ota_key_t *key, const char *json, size_t length, li_ota_authentication_t *result) {
    if (!result) return LI_INVALID;
    memset(result, 0, sizeof(*result));
    if (!ports || !ports->ed25519_verify || li_ota_key_validate(ports, key) != LI_OK) return LI_INVALID;
    cJSON *root = li_ota_document_parse(json, length);
    if (!root) return LI_INVALID;
    li_error_t error = LI_INVALID;
    const cJSON *version = cJSON_GetObjectItemCaseSensitive(root, "version");
    const cJSON *signature = cJSON_GetObjectItemCaseSensitive(root, "signature");
    const cJSON *statement = cJSON_GetObjectItemCaseSensitive(root, "statement");
    uint8_t decoded[64]; buffer_t out = {0};
    if (cJSON_GetArraySize(root) != 6
        || !equals(root, "schema", "limeiot.ota-manifest") || !equals(root, "algorithm", "Ed25519")
        || !equals(root, "signing_key_id", key->signing_key_id) || !cJSON_IsNumber(version) || version->valuedouble != 1
        || !cJSON_IsObject(statement) || !cJSON_IsString(signature) || !base64(signature->valuestring, decoded, sizeof(decoded))) goto finish;
    out.capacity = LI_MAX_PACKET + sizeof(OTA_DOMAIN); out.data = malloc(out.capacity);
    if (!out.data) { error = LI_CAPACITY; goto finish; }
    if (!append(&out, OTA_DOMAIN, sizeof(OTA_DOMAIN)-1) || !canonical(&out, root, true)
        || !ports->ed25519_verify(ports->context, key->public_key, (const uint8_t *)out.data, out.size, decoded)) goto finish;
    out.size = 0;
    if (!canonical(&out, root, false) || !hash(ports, (const uint8_t *)out.data, out.size, result->manifest_digest)) goto finish;
    memcpy(result->signing_key_id, key->signing_key_id, sizeof(result->signing_key_id)); error = LI_OK;
finish:
    free(out.data); cJSON_Delete(root);
    if (error != LI_OK) memset(result, 0, sizeof(*result));
    return error;
}
