#include "internal.h"
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

bool li_identifier(const char *value) {
    if (!value || !*value || strlen(value) >= LI_ID_SIZE) return false;
    for (; *value; value++) if (!((*value >= 'a' && *value <= 'z') || (*value >= 'A' && *value <= 'Z') || (*value >= '0' && *value <= '9') || *value == '-' || *value == '_')) return false;
    return true;
}
bool li_value_valid(const li_property_t *property, li_value_t value) {
    return value.type == property->type && (value.type == LI_BOOLEAN || (value.integer >= property->minimum && value.integer <= property->maximum));
}
bool li_new_id(li_core_t *core, char result[LI_ID_SIZE]) {
    uint8_t bytes[16];
    if (!core->ports.random_bytes(core->ports.context, bytes, sizeof(bytes))) return false;
    static const char hex[] = "0123456789abcdef";
    for (unsigned i = 0; i < sizeof(bytes); i++) { result[2*i] = hex[bytes[i] >> 4]; result[2*i+1] = hex[bytes[i] & 15]; }
    result[32] = '\0'; return true;
}
static const li_property_t *property(li_core_t *core, const char *path) {
    for (size_t i = 0; i < core->config.property_count; i++) if (strcmp(path, core->config.properties[i].path) == 0) return &core->config.properties[i];
    return NULL;
}
int64_t li_now(li_core_t *core) {
    int64_t now = core->ports.monotonic_ms(core->ports.context);
    if (!core->ready || now < core->anchor_mono || now - core->anchor_mono > INT64_C(86400000)) return -1;
    return core->anchor_unix + now - core->anchor_mono;
}
static li_error_t publish(li_core_t *core, const char *kind, char *payload) {
    if (!payload) return LI_CAPACITY;
    char topic[LI_TOPIC_SIZE];
    int size = snprintf(topic, sizeof(topic), "limeiot/v1/%s/%s/up/%s", core->config.space_id, core->config.device_id, kind);
    size_t length = strlen(payload);
    bool sent = size > 0 && (size_t)size < sizeof(topic) && length <= LI_MAX_PACKET && core->ports.publish(core->ports.context, topic, payload, length);
    li_codec_free(payload); return sent ? LI_OK : LI_TRANSPORT;
}
static bool store(li_core_t *core, unsigned slot, li_receipt_t *record) {
    char *json = li_codec_receipt_encode(record);
    if (!json) return false;
    bool result = core->ports.storage_write(core->ports.context, slot, json, strlen(json));
    li_codec_free(json);
    if (result) { core->receipts[slot] = *record; core->occupied[slot] = true; }
    return result;
}
li_core_t *li_core_create(const li_config_t *config, const li_ports_t *ports, li_error_t *error) {
    if (error) *error = LI_INVALID;
    if (!config || !ports || !li_identifier(config->space_id) || !li_identifier(config->device_id) || !config->model_revision || strlen(config->model_revision) != 71 || strncmp(config->model_revision, "sha256:", 7) != 0 || !config->firmware_version || !config->hardware_revision || config->property_count > LI_MAX_PROPERTIES || config->event_count > LI_MAX_PROPERTIES || (config->property_count && !config->properties) || (config->event_count && !config->events)) return NULL;
    if (!ports->random_bytes || !ports->monotonic_ms || !ports->sha256 || !ports->storage_read || !ports->storage_write || !ports->publish || !ports->read_property || !ports->write_property) return NULL;
    if (strlen(config->firmware_version) > 64 || strlen(config->hardware_revision) > 64 || (config->observation_source && strlen(config->observation_source) > 64)) return NULL;
    for (unsigned i = 7; i < 71; i++) if (!((config->model_revision[i] >= '0' && config->model_revision[i] <= '9') || (config->model_revision[i] >= 'a' && config->model_revision[i] <= 'f'))) return NULL;
    for (size_t i = 0; i < config->property_count; i++) {
        const li_property_t *spec = &config->properties[i];
        if (!spec->path || strlen(spec->path) >= LI_PATH_SIZE || (spec->type != LI_BOOLEAN && spec->type != LI_INTEGER) || spec->minimum > spec->maximum) return NULL;
        for (size_t j = 0; j < i; j++) if (strcmp(config->properties[j].path, spec->path) == 0) return NULL;
    }
    li_core_t *core = calloc(1, sizeof(*core));
    if (!core) { if (error) *error = LI_CAPACITY; return NULL; }
    for (size_t i = 0; i < config->event_count; i++) if (!config->events[i].path || strlen(config->events[i].path) >= LI_PATH_SIZE || !li_identifier(config->events[i].field) || config->events[i].minimum > config->events[i].maximum) { free(core); return NULL; }
    core->config = *config; core->ports = *ports;
    if (!li_new_id(core, core->boot)) { free(core); return NULL; }
    for (unsigned slot = 0; slot < LI_RECEIPT_SLOTS; slot++) {
        char data[LI_STORAGE_BYTES]; size_t length = 0; bool found = false;
        if (!ports->storage_read(ports->context, slot, data, sizeof(data), &length, &found)) goto storage_error;
        if (!found) continue;
        if (length >= sizeof(data) || !li_codec_receipt_decode(data, length, &core->receipts[slot])) goto storage_error;
        const li_property_t *spec = property(core, core->receipts[slot].path);
        if (!spec || !li_value_valid(spec, core->receipts[slot].value)) goto storage_error;
        for (unsigned previous = 0; previous < slot; previous++) if (core->occupied[previous] && strcmp(core->receipts[previous].command, core->receipts[slot].command) == 0) goto storage_error;
        core->occupied[slot] = true;
    }
    if (error) *error = LI_OK;
    return core;
storage_error:
    if (error) *error = LI_STORAGE;
    free(core); return NULL;
}
void li_core_destroy(li_core_t *core) { if (core) { memset(core, 0, sizeof(*core)); free(core); } }
bool li_ready(const li_core_t *core) { return core && core->connected && core->ready; }
void li_disconnected(li_core_t *core) { core->connected = false; core->ready = false; core->session[0] = '\0'; memset(core->unreported, 0, sizeof(core->unreported)); }
static li_error_t hello(li_core_t *core) {
    if (!li_new_id(core, core->challenge)) return LI_CAPACITY;
    core->last_hello = core->ports.monotonic_ms(core->ports.context);
    return publish(core, "hello", li_codec_hello(core));
}
li_error_t li_connected(li_core_t *core) { li_disconnected(core); core->connected = true; return hello(core); }
li_error_t li_report_snapshot(li_core_t *core) {
    int64_t now = li_now(core); if (now < 0) return LI_CLOCK;
    li_value_t values[LI_MAX_PROPERTIES];
    for (size_t i = 0; i < core->config.property_count; i++) if (!core->ports.read_property(core->ports.context, core->config.properties[i].path, &values[i]) || !li_value_valid(&core->config.properties[i], values[i])) return LI_DRIVER;
    core->last_snapshot = core->ports.monotonic_ms(core->ports.context);
    return publish(core, "state", li_codec_snapshot(core, now, values));
}
static li_error_t result(li_core_t *core, unsigned slot) {
    li_error_t error = publish(core, "result", li_codec_result(core, &core->receipts[slot]));
    core->unreported[slot] = error != LI_OK;
    return error;
}
static li_error_t command(li_core_t *core, const li_down_t *down) {
    if (!core->ready || strcmp(down->session, core->session) != 0) return LI_SESSION;
    const li_property_t *spec = property(core, down->path);
    if (!spec || !spec->writable || !li_value_valid(spec, down->value)) return LI_INVALID;
    uint8_t hash[32]; char fingerprint[65];
    if (!core->ports.sha256(core->ports.context, (const uint8_t *)down->canonical, strlen(down->canonical), hash)) return LI_INVALID;
    for (unsigned i = 0; i < sizeof(hash); i++) snprintf(fingerprint + 2*i, 3, "%02x", hash[i]);
    int64_t now = li_now(core); if (now < 0) return LI_CLOCK;
    int slot = -1;
    for (unsigned i = 0; i < LI_RECEIPT_SLOTS; i++) {
        if (core->occupied[i] && strcmp(core->receipts[i].command, down->command) == 0) {
            if (strcmp(core->receipts[i].fingerprint, fingerprint) != 0) return LI_CONFLICT;
            return result(core, i);
        }
        if (slot < 0 && (!core->occupied[i] || (core->receipts[i].expires_ms <= now && !core->unreported[i]))) slot = (int)i;
    }
    if (down->expires_ms <= now || down->issued_ms > now + 2000 || down->expires_ms <= down->issued_ms || down->expires_ms - down->issued_ms > 30000) return LI_EXPIRED;
    if (slot < 0) return LI_CAPACITY;
    li_receipt_t receipt = {0};
    memcpy(receipt.command, down->command, sizeof(receipt.command)); memcpy(receipt.fingerprint, fingerprint, sizeof(fingerprint));
    memcpy(receipt.session, down->session, sizeof(receipt.session)); memcpy(receipt.path, down->path, sizeof(receipt.path));
    receipt.expires_ms = down->expires_ms; receipt.observed_ms = now; receipt.value = down->value; receipt.stage = LI_INTENT;
    /* 先保存执行意图。之后任何不确定结果都保留该意图，重启或重发不得再次调用驱动。 */
    if (!store(core, (unsigned)slot, &receipt)) return LI_STORAGE;
    int64_t after_store = li_now(core);
    li_apply_result_t applied = LI_NOT_APPLIED;
    if (after_store >= 0 && after_store < down->expires_ms) applied = core->ports.write_property(core->ports.context, down->path, down->value);
    receipt.stage = applied == LI_APPLIED ? LI_CONFIRMED : applied == LI_NOT_APPLIED ? LI_FAILED : LI_INTENT;
    if (receipt.stage == LI_FAILED) strcpy(receipt.error, after_store < 0 ? "clock_untrusted" : after_store >= down->expires_ms ? "command_expired" : "driver_failed");
    int64_t after_driver = li_now(core);
    if (after_driver >= now) receipt.observed_ms = after_driver;
    else if (applied != LI_NOT_APPLIED) receipt.stage = LI_INTENT;
    if (receipt.stage != LI_INTENT && !store(core, (unsigned)slot, &receipt)) {
        (void)result(core, (unsigned)slot); return LI_STORAGE;
    }
    li_error_t sent = result(core, (unsigned)slot);
    (void)li_report_snapshot(core); return sent;
}
li_error_t li_receive(li_core_t *core, const char *topic, const char *payload, size_t length, bool retained) {
    if (!core->connected || !topic || retained || !payload || length == 0 || length > LI_MAX_PACKET) return LI_INVALID;
    li_down_t down = {0}; li_error_t error = li_codec_decode(payload, length, &down);
    if (error != LI_OK) return error;
    char expected[LI_TOPIC_SIZE];
    snprintf(expected, sizeof(expected), "limeiot/v1/%s/%s/down/%s", core->config.space_id, core->config.device_id, down.kind == LI_DOWN_WELCOME ? "welcome" : "command");
    if (strcmp(topic, expected) != 0 || strcmp(down.device, core->config.device_id) != 0 || strcmp(down.revision, core->config.model_revision) != 0) error = LI_INVALID;
    else if (down.kind == LI_DOWN_WELCOME) {
        if (core->ready) error = LI_IGNORED;
        else if (strcmp(down.challenge, core->challenge) != 0) error = LI_SESSION;
        else { memcpy(core->session, down.session, sizeof(core->session)); core->anchor_unix = down.time_ms; core->anchor_mono = core->ports.monotonic_ms(core->ports.context); core->ready = true; core->snapshot_revision = 0; error = li_report_snapshot(core); }
    } else error = command(core, &down);
    li_codec_down_free(&down); return error;
}
li_error_t li_tick(li_core_t *core) {
    if (!core->connected) return LI_IGNORED;
    int64_t mono = core->ports.monotonic_ms(core->ports.context);
    if (!core->ready) return mono - core->last_hello >= 3000 ? hello(core) : LI_IGNORED;
    if (li_now(core) < 0) { li_disconnected(core); return LI_CLOCK; }
    for (unsigned slot = 0; slot < LI_RECEIPT_SLOTS; slot++) if (core->unreported[slot]) { li_error_t error = result(core, slot); if (error != LI_OK) return error; }
    return mono - core->last_snapshot >= 2000 ? li_report_snapshot(core) : LI_IGNORED;
}
li_error_t li_emit_event(li_core_t *core, const char *path, int64_t value) {
    int64_t now = li_now(core); if (now < 0) return LI_CLOCK;
    for (size_t i = 0; i < core->config.event_count; i++) {
        const li_event_t *spec = &core->config.events[i];
        if (strcmp(spec->path, path) == 0 && value >= spec->minimum && value <= spec->maximum) return publish(core, "event", li_codec_event(core, now, spec, value));
    }
    return LI_INVALID;
}
const char *li_error_code(li_error_t error) {
    static const char *codes[] = {"ok", "ignored", "invalid_message", "session_mismatch", "command_expired", "duplicate_conflict", "storage_unavailable", "transport_unavailable", "capacity_exceeded", "driver_failed", "clock_untrusted"};
    return (unsigned)error < sizeof(codes)/sizeof(codes[0]) ? codes[error] : "unknown_error";
}
