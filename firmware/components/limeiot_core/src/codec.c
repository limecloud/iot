/* cJSON 仅在这个编解码适配器中出现。当前绑定子集为布尔值、整数和单整数字段事件。 */
#include "internal.h"
#include "cJSON.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static bool bounded_json(const char *data, size_t size) {
    unsigned depth = 0; bool string = false;
    for (size_t i = 0; i < size; i++) {
        unsigned char byte = (unsigned char)data[i];
        if (byte == 0) return false;
        if (string) {
            if (byte == '\\') {
                if (++i >= size) return false;
                if (data[i] == 'u' && i + 4 < size && memcmp(data + i + 1, "0000", 4) == 0) return false;
            } else if (byte == '"') string = false;
        } else if (byte == '"') string = true;
        else if (byte == '-' || (byte >= '0' && byte <= '9')) {
            while (i + 1 < size && data[i+1] >= '0' && data[i+1] <= '9') i++;
            if (i + 1 < size && (data[i+1] == '.' || data[i+1] == 'e' || data[i+1] == 'E')) return false;
        }
        else if (byte == '{' || byte == '[') { if (++depth > 16) return false; }
        else if (byte == '}' || byte == ']') { if (depth == 0) return false; depth--; }
    }
    return depth == 0 && !string;
}
static bool unique_keys(const cJSON *value) {
    if (cJSON_IsObject(value)) {
        for (const cJSON *field = value->child; field; field = field->next) {
            for (const cJSON *next = field->next; next; next = next->next) if (strcmp(field->string, next->string) == 0) return false;
            if (!unique_keys(field)) return false;
        }
    } else if (cJSON_IsArray(value)) { for (const cJSON *item = value->child; item; item = item->next) if (!unique_keys(item)) return false; }
    return true;
}
static cJSON *parse(const char *data, size_t length) {
    if (length == 0 || length > LI_MAX_PACKET || !bounded_json(data, length)) return NULL;
    const char *end = NULL;
    cJSON *root = cJSON_ParseWithLengthOpts(data, length, &end, false);
    if (!root) return NULL;
    while (end < data + length && (*end == ' ' || *end == '\t' || *end == '\r' || *end == '\n')) end++;
    if (end != data + length || !unique_keys(root)) { cJSON_Delete(root); return NULL; }
    return root;
}
static bool keys(const cJSON *object, const char *const *allowed, size_t count) {
    if (!cJSON_IsObject(object) || (size_t)cJSON_GetArraySize(object) != count) return false;
    for (size_t i = 0; i < count; i++) if (!cJSON_GetObjectItemCaseSensitive(object, allowed[i])) return false;
    return true;
}
#define KEYS(object, ...) keys((object), (const char *const[]){__VA_ARGS__}, sizeof((const char *const[]){__VA_ARGS__})/sizeof(const char *))
static bool text(const cJSON *object, const char *key, char *destination, size_t capacity) {
    const cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
    if (!cJSON_IsString(value) || strlen(value->valuestring) >= capacity) return false;
    strcpy(destination, value->valuestring); return true;
}
static bool equals(const cJSON *object, const char *key, const char *expected) {
    const cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
    return cJSON_IsString(value) && strcmp(value->valuestring, expected) == 0;
}
static bool integer(const cJSON *value, int64_t *result) {
    if (!cJSON_IsNumber(value) || !isfinite(value->valuedouble) || fabs(value->valuedouble) > 9007199254740991.0 || trunc(value->valuedouble) != value->valuedouble) return false;
    *result = (int64_t)value->valuedouble; return true;
}
static bool value_decode(const cJSON *value, li_value_t *result) {
    if (cJSON_IsBool(value)) { result->type = LI_BOOLEAN; result->boolean = cJSON_IsTrue(value); return true; }
    result->type = LI_INTEGER; return integer(value, &result->integer);
}
static cJSON *value_encode(li_value_t value) { return value.type == LI_BOOLEAN ? cJSON_CreateBool(value.boolean) : cJSON_CreateNumber((double)value.integer); }
static int digits(const char *text, unsigned count) {
    int value = 0;
    for (unsigned i = 0; i < count; i++) { if (text[i] < '0' || text[i] > '9') return -1; value = 10 * value + text[i] - '0'; }
    return value;
}
static bool timestamp(const cJSON *object, const char *key, int64_t *result) {
    char value[40]; if (!text(object, key, value, sizeof(value))) return false;
    size_t size = strlen(value);
    if (size < 20 || value[4] != '-' || value[7] != '-' || value[10] != 'T' || value[13] != ':' || value[16] != ':' || value[size-1] != 'Z') return false;
    int year = digits(value, 4), month = digits(value + 5, 2), day = digits(value + 8, 2), hour = digits(value + 11, 2), minute = digits(value + 14, 2), second = digits(value + 17, 2);
    static const int days[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    if (year < 2020 || year > 2100 || month < 1 || month > 12 || day < 1 || day > days[month-1] + (month == 2 && leap) || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return false;
    int milliseconds = 0;
    if (size != 20) {
        if (size < 22 || size > 30 || value[19] != '.') return false;
        for (size_t i = 20; i < size - 1; i++) { if (value[i] < '0' || value[i] > '9') return false; if (i < 23) milliseconds += (value[i] - '0') * (i == 20 ? 100 : i == 21 ? 10 : 1); }
    }
    int adjusted = year - (month <= 2), era = adjusted / 400, year_of_era = adjusted - era * 400;
    int shifted_month = month + (month > 2 ? -3 : 9);
    int day_of_year = (153 * shifted_month + 2)/5 + day - 1;
    int64_t absolute_days = (int64_t)era * 146097 + year_of_era * 365 + year_of_era/4 - year_of_era/100 + day_of_year - 719468;
    *result = ((absolute_days * 24 + hour) * 3600 + minute * 60 + second) * 1000 + milliseconds; return true;
}
static void add_timestamp(cJSON *object, const char *key, int64_t milliseconds) {
    time_t seconds = (time_t)(milliseconds / 1000); struct tm utc; char value[32];
    if (!gmtime_r(&seconds, &utc)) return;
    snprintf(value, sizeof(value), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday, utc.tm_hour, utc.tm_min, utc.tm_sec, (int)(milliseconds % 1000));
    cJSON_AddStringToObject(object, key, value);
}
/* 这里只处理已通过严格字段校验的 ASCII 命令子集，不声称是通用 JCS 实现。 */
static int compare_fields(const void *left, const void *right) { return strcmp((*(const cJSON *const *)left)->string, (*(const cJSON *const *)right)->string); }
static cJSON *ordered(const cJSON *object) {
    if (!cJSON_IsObject(object)) return cJSON_Duplicate(object, true);
    size_t count = (size_t)cJSON_GetArraySize(object);
    if (count > 16) return NULL;
    const cJSON *fields[16]; size_t i = 0;
    for (const cJSON *field = object->child; field; field = field->next) fields[i++] = field;
    qsort(fields, count, sizeof(fields[0]), compare_fields);
    cJSON *result = cJSON_CreateObject();
    if (!result) return NULL;
    for (i = 0; i < count; i++) { cJSON *child = ordered(fields[i]); if (!child || !cJSON_AddItemToObject(result, fields[i]->string, child)) { cJSON_Delete(child); cJSON_Delete(result); return NULL; } }
    return result;
}
li_error_t li_codec_decode(const char *payload, size_t length, li_down_t *down) {
    cJSON *root = parse(payload, length); if (!root) return LI_INVALID;
    li_error_t result = LI_INVALID; int64_t version;
    if (!KEYS(root, "v", "kind", "message_id", "device_id", "model_revision", "session_id", "body") || !integer(cJSON_GetObjectItemCaseSensitive(root, "v"), &version) || version != 1) goto finish;
    if (!text(root, "message_id", down->message, sizeof(down->message)) || !li_identifier(down->message) || !text(root, "device_id", down->device, sizeof(down->device)) || !li_identifier(down->device) || !text(root, "model_revision", down->revision, sizeof(down->revision)) || !text(root, "session_id", down->session, sizeof(down->session)) || !li_identifier(down->session)) goto finish;
    const cJSON *body = cJSON_GetObjectItemCaseSensitive(root, "body");
    if (equals(root, "kind", "welcome")) {
        int64_t limit;
        if (!KEYS(body, "challenge", "time", "max_packet_bytes") || !text(body, "challenge", down->challenge, sizeof(down->challenge)) || !li_identifier(down->challenge) || !timestamp(body, "time", &down->time_ms) || !integer(cJSON_GetObjectItemCaseSensitive(body, "max_packet_bytes"), &limit) || limit < 1024 || limit > LI_MAX_PACKET) goto finish;
        down->kind = LI_DOWN_WELCOME;
    } else if (equals(root, "kind", "command")) {
        if (!KEYS(body, "command_id", "issued_at", "expires_at", "operation") || !text(body, "command_id", down->command, sizeof(down->command)) || !li_identifier(down->command) || !timestamp(body, "issued_at", &down->issued_ms) || !timestamp(body, "expires_at", &down->expires_ms)) goto finish;
        const cJSON *operation = cJSON_GetObjectItemCaseSensitive(body, "operation");
        if (!KEYS(operation, "type", "path", "value") || !equals(operation, "type", "property.set") || !text(operation, "path", down->path, sizeof(down->path)) || !value_decode(cJSON_GetObjectItemCaseSensitive(operation, "value"), &down->value)) goto finish;
        cJSON *canonical = ordered(root); if (!canonical) goto finish;
        down->canonical = cJSON_PrintUnformatted(canonical); cJSON_Delete(canonical);
        if (!down->canonical) goto finish;
        down->kind = LI_DOWN_COMMAND;
    } else goto finish;
    result = LI_OK;
finish:
    cJSON_Delete(root); return result;
}
void li_codec_free(char *data) { cJSON_free(data); }
void li_codec_down_free(li_down_t *down) { li_codec_free(down->canonical); down->canonical = NULL; }
static char *print(cJSON *root) { if (!root) return NULL; char *result = cJSON_PrintUnformatted(root); cJSON_Delete(root); return result; }
static cJSON *envelope(li_core_t *core, const char *kind, cJSON *body) {
    char message[LI_ID_SIZE];
    if (!body || core->seq >= LI_MAX_SEQUENCE || !li_new_id(core, message)) { cJSON_Delete(body); return NULL; }
    cJSON *root = cJSON_CreateObject(); if (!root) { cJSON_Delete(body); return NULL; }
    cJSON_AddNumberToObject(root, "v", 1); cJSON_AddStringToObject(root, "kind", kind);
    cJSON_AddStringToObject(root, "message_id", message); cJSON_AddStringToObject(root, "device_id", core->config.device_id);
    cJSON_AddStringToObject(root, "model_revision", core->config.model_revision); cJSON_AddStringToObject(root, "boot_id", core->boot);
    cJSON_AddNumberToObject(root, "seq", (double)++core->seq);
    if (core->session[0]) cJSON_AddStringToObject(root, "session_id", core->session);
    cJSON_AddItemToObject(root, "body", body); return root;
}
char *li_codec_hello(li_core_t *core) {
    cJSON *body = cJSON_CreateObject(); if (!body) return NULL;
    cJSON_AddStringToObject(body, "challenge", core->challenge); cJSON_AddStringToObject(body, "firmware", core->config.firmware_version); cJSON_AddStringToObject(body, "hardware", core->config.hardware_revision);
    return print(envelope(core, "hello", body));
}
char *li_codec_snapshot(li_core_t *core, int64_t now, const li_value_t *values) {
    cJSON *body = cJSON_CreateObject(); if (!body) return NULL;
    cJSON_AddStringToObject(body, "type", "snapshot"); cJSON_AddNumberToObject(body, "revision", (double)++core->snapshot_revision);
    cJSON *properties = cJSON_AddArrayToObject(body, "properties");
    if (!properties) { cJSON_Delete(body); return NULL; }
    for (size_t i = 0; i < core->config.property_count; i++) {
        cJSON *entry = cJSON_CreateObject(); if (!entry) { cJSON_Delete(body); return NULL; }
        cJSON_AddStringToObject(entry, "path", core->config.properties[i].path); cJSON_AddItemToObject(entry, "value", value_encode(values[i]));
        add_timestamp(entry, "observed_at", now); cJSON_AddStringToObject(entry, "quality", "confirmed"); cJSON_AddStringToObject(entry, "source", core->config.observation_source ? core->config.observation_source : "driver.applied"); cJSON_AddItemToArray(properties, entry);
    }
    return print(envelope(core, "state", body));
}
char *li_codec_event(li_core_t *core, int64_t now, const li_event_t *spec, int64_t value) {
    char event[LI_ID_SIZE]; if (!li_new_id(core, event)) return NULL;
    cJSON *body = cJSON_CreateObject(); if (!body) return NULL;
    cJSON_AddStringToObject(body, "event_id", event); cJSON_AddStringToObject(body, "path", spec->path); cJSON_AddBoolToObject(body, "historical", false); add_timestamp(body, "occurred_at", now);
    cJSON *data = cJSON_AddObjectToObject(body, "data"); if (!data) { cJSON_Delete(body); return NULL; }
    cJSON_AddNumberToObject(data, spec->field, (double)value); return print(envelope(core, "event", body));
}
char *li_codec_result(li_core_t *core, const li_receipt_t *receipt) {
    cJSON *body = cJSON_CreateObject(); if (!body) return NULL;
    cJSON_AddStringToObject(body, "command_id", receipt->command);
    cJSON_AddStringToObject(body, "status", receipt->stage == LI_CONFIRMED ? "confirmed" : receipt->stage == LI_FAILED ? "failed" : "unknown");
    if (receipt->stage != LI_CONFIRMED) cJSON_AddStringToObject(body, "error", receipt->stage == LI_FAILED ? receipt->error : "execution_unknown");
    cJSON *evidence = cJSON_AddObjectToObject(body, "evidence"); if (!evidence) { cJSON_Delete(body); return NULL; }
    cJSON_AddStringToObject(evidence, "type", "device_result"); add_timestamp(evidence, "observed_at", receipt->observed_ms);
    cJSON *reported = cJSON_AddObjectToObject(evidence, "reported"); if (!reported) { cJSON_Delete(body); return NULL; }
    if (receipt->stage == LI_CONFIRMED) cJSON_AddItemToObject(reported, receipt->path, value_encode(receipt->value));
    return print(envelope(core, "result", body));
}
char *li_codec_receipt_encode(const li_receipt_t *receipt) {
    cJSON *record = cJSON_CreateObject(); if (!record) return NULL;
    cJSON_AddNumberToObject(record, "version", 1); cJSON_AddNumberToObject(record, "stage", receipt->stage);
    cJSON_AddStringToObject(record, "command", receipt->command); cJSON_AddStringToObject(record, "fingerprint", receipt->fingerprint);
    cJSON_AddStringToObject(record, "session", receipt->session); cJSON_AddStringToObject(record, "path", receipt->path);
    cJSON_AddStringToObject(record, "error", receipt->error);
    cJSON_AddNumberToObject(record, "expires_ms", (double)receipt->expires_ms); cJSON_AddNumberToObject(record, "observed_ms", (double)receipt->observed_ms);
    cJSON_AddItemToObject(record, "value", value_encode(receipt->value)); return print(record);
}
bool li_codec_receipt_decode(const char *data, size_t length, li_receipt_t *record) {
    cJSON *root = parse(data, length); if (!root) return false;
    int64_t version, stage;
    bool valid = KEYS(root, "version", "stage", "command", "fingerprint", "session", "path", "error", "expires_ms", "observed_ms", "value") && integer(cJSON_GetObjectItemCaseSensitive(root, "version"), &version) && version == 1 && integer(cJSON_GetObjectItemCaseSensitive(root, "stage"), &stage) && stage >= LI_INTENT && stage <= LI_FAILED && text(root, "command", record->command, sizeof(record->command)) && li_identifier(record->command) && text(root, "fingerprint", record->fingerprint, sizeof(record->fingerprint)) && strlen(record->fingerprint) == 64 && text(root, "session", record->session, sizeof(record->session)) && li_identifier(record->session) && text(root, "path", record->path, sizeof(record->path)) && text(root, "error", record->error, sizeof(record->error)) && integer(cJSON_GetObjectItemCaseSensitive(root, "expires_ms"), &record->expires_ms) && integer(cJSON_GetObjectItemCaseSensitive(root, "observed_ms"), &record->observed_ms) && record->expires_ms > 0 && record->observed_ms > 0 && value_decode(cJSON_GetObjectItemCaseSensitive(root, "value"), &record->value);
    if (valid) record->stage = (li_receipt_stage_t)stage;
    cJSON_Delete(root); return valid;
}
