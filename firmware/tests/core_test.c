#include "limeiot.h"
#include "lamp.h"
#include "button.h"
#include "cJSON.h"
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(expression) do { if (!(expression)) { fprintf(stderr, "failed at %s:%d: %s\n", __FILE__, __LINE__, #expression); exit(1); } } while (0)
typedef struct {
    char storage[LI_RECEIPT_SLOTS][1024];
    char messages[256][2048];
    int sent, writes, store_calls, fail_store, drop_results;
    int64_t mono, storage_delay;
    li_apply_result_t outcome;
    bool power;
    int64_t brightness;
    li_device_info_t device_info;
    bool fail_info;
} fixture_t;
static bool random_bytes(void *context, uint8_t *bytes, size_t length) { (void)context; return RAND_bytes(bytes, (int)length) == 1; }
static int64_t monotonic(void *context) { return ((fixture_t *)context)->mono; }
static bool sha256(void *context, const uint8_t *data, size_t length, uint8_t result[32]) { (void)context; unsigned size = 0; return EVP_Digest(data, length, result, &size, EVP_sha256(), NULL) == 1 && size == 32; }
static bool load(void *context, unsigned slot, char *data, size_t capacity, size_t *length, bool *found) {
    fixture_t *fixture = context; *length = strlen(fixture->storage[slot]); *found = *length != 0;
    if (*length >= capacity) return false;
    memcpy(data, fixture->storage[slot], *length); return true;
}
static bool save(void *context, unsigned slot, const char *data, size_t length) {
    fixture_t *fixture = context; fixture->store_calls++; fixture->mono += fixture->storage_delay;
    if (fixture->store_calls == fixture->fail_store || length >= sizeof(fixture->storage[slot])) return false;
    memcpy(fixture->storage[slot], data, length); fixture->storage[slot][length] = '\0'; return true;
}
static bool publish(void *context, const char *topic, const char *data, size_t length) {
    fixture_t *fixture = context;
    if (strstr(topic, "/up/result") && fixture->drop_results > 0) { fixture->drop_results--; return false; }
    CHECK(fixture->sent < 256 && length < sizeof(fixture->messages[0]));
    memcpy(fixture->messages[fixture->sent], data, length); fixture->messages[fixture->sent++][length] = '\0'; return true;
}
static bool read_property(void *context, const char *path, li_value_t *value) {
    fixture_t *fixture = context; memset(value, 0, sizeof(*value));
    if (strcmp(path, "light.power") == 0) { value->type = LI_BOOLEAN; value->boolean = fixture->power; return true; }
    if (strcmp(path, "light.brightness") == 0) { value->type = LI_INTEGER; value->integer = fixture->brightness; return true; }
    return false;
}
static li_apply_result_t write_property(void *context, const char *path, li_value_t value) {
    fixture_t *fixture = context; fixture->writes++;
    if (fixture->outcome != LI_NOT_APPLIED) {
        if (strcmp(path, "light.power") == 0) fixture->power = value.boolean; else fixture->brightness = value.integer;
    }
    return fixture->outcome;
}
static const li_config_t lamp_config = {"space-demo", "device-lamp", LI_LAMP_REVISION, "0.1.0", "host-test", LI_LAMP_PROPERTIES, LI_LAMP_PROPERTY_COUNT, NULL, 0, "host-fixture"};
static bool read_device_info(void *context, li_device_info_t *info) {
    fixture_t *f = context; *info = f->device_info; return !f->fail_info;
}
static fixture_t *fixture(void) { fixture_t *result = calloc(1, sizeof(*result)); CHECK(result); result->mono = 1000; return result; }
static li_core_t *create(fixture_t *fixture, const li_config_t *config) {
    li_ports_t ports = {fixture, random_bytes, monotonic, sha256, load, save, publish, read_property, write_property, fixture->device_info.product_id ? read_device_info : NULL};
    li_error_t error; li_core_t *core = li_core_create(config, &ports, &error); CHECK(core && error == LI_OK); return core;
}
static cJSON *last(fixture_t *fixture, const char *kind) {
    for (int i = fixture->sent - 1; i >= 0; i--) { cJSON *message = cJSON_Parse(fixture->messages[i]); CHECK(message); cJSON *type = cJSON_GetObjectItemCaseSensitive(message, "kind"); if (cJSON_IsString(type) && strcmp(type->valuestring, kind) == 0) return message; cJSON_Delete(message); }
    CHECK(false); return NULL;
}
static void handshake(li_core_t *core, fixture_t *fixture, const li_config_t *config, const char *session, const char *time) {
    CHECK(li_connected(core) == LI_OK);
    cJSON *hello = last(fixture, "hello"); const char *challenge = cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(hello, "body"), "challenge")->valuestring;
    char welcome[1024], topic[256];
    snprintf(welcome, sizeof(welcome), "{\"v\":1,\"kind\":\"welcome\",\"message_id\":\"welcome-test\",\"device_id\":\"%s\",\"model_revision\":\"%s\",\"session_id\":\"%s\",\"body\":{\"challenge\":\"%s\",\"time\":\"%s\",\"max_packet_bytes\":16384}}", config->device_id, config->model_revision, session, challenge, time);
    snprintf(topic, sizeof(topic), "limeiot/v1/%s/%s/down/welcome", config->space_id, config->device_id);
    CHECK(li_receive(core, topic, welcome, strlen(welcome), false) == LI_OK); CHECK(li_ready(core)); cJSON_Delete(hello);
}
static void make_command(char *buffer, size_t capacity, const char *id, const char *session, const char *value, bool reordered) {
    const char *normal = "{\"v\":1,\"kind\":\"command\",\"message_id\":\"message-%s\",\"device_id\":\"device-lamp\",\"model_revision\":\"%s\",\"session_id\":\"%s\",\"body\":{\"command_id\":\"%s\",\"issued_at\":\"2026-11-01T00:00:00.000Z\",\"expires_at\":\"2026-11-01T00:00:05.000Z\",\"operation\":{\"type\":\"property.set\",\"path\":\"light.power\",\"value\":%s}}}";
    snprintf(buffer, capacity, normal, id, LI_LAMP_REVISION, session, id, value);
    if (reordered) {
        cJSON *root = cJSON_Parse(buffer); CHECK(root);
        cJSON *version = cJSON_DetachItemFromObjectCaseSensitive(root, "v"); cJSON_AddItemToObject(root, "v", version);
        char *formatted = cJSON_Print(root); CHECK(strlen(formatted) < capacity); strcpy(buffer, formatted); cJSON_free(formatted); cJSON_Delete(root);
    }
}
static li_error_t receive(li_core_t *core, const char *payload) { return li_receive(core, "limeiot/v1/space-demo/device-lamp/down/command", payload, strlen(payload), false); }
static void status(fixture_t *fixture, const char *expected) {
    cJSON *message = last(fixture, "result"); const char *actual = cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(message, "body"), "status")->valuestring;
    CHECK(strcmp(actual, expected) == 0); cJSON_Delete(message);
}
static void duplicate_and_conflict(void) {
    fixture_t *f = fixture(); li_core_t *core = create(f, &lamp_config); handshake(core, f, &lamp_config, "session-test", "2026-11-01T00:00:00.000Z");
    char packet[2048]; make_command(packet, sizeof(packet), "command-one", "session-test", "true", false);
    CHECK(receive(core, packet) == LI_OK); CHECK(f->writes == 1 && f->power); status(f, "confirmed");
    make_command(packet, sizeof(packet), "command-one", "session-test", "true", true);
    CHECK(receive(core, packet) == LI_OK); CHECK(f->writes == 1); status(f, "confirmed");
    make_command(packet, sizeof(packet), "command-one", "session-test", "false", false);
    CHECK(receive(core, packet) == LI_CONFLICT); CHECK(f->writes == 1);
    li_core_destroy(core); free(f);
}
static void durable_intent_and_power_loss(void) {
    fixture_t *f = fixture(); li_core_t *core = create(f, &lamp_config); handshake(core, f, &lamp_config, "session-test", "2026-11-01T00:00:00.000Z");
    char packet[2048]; make_command(packet, sizeof(packet), "command-unknown", "session-test", "true", false);
    f->fail_store = 2;
    CHECK(receive(core, packet) == LI_STORAGE); CHECK(f->writes == 1 && f->power); status(f, "unknown");
    CHECK(receive(core, packet) == LI_OK); CHECK(f->writes == 1); status(f, "unknown");
    li_core_destroy(core); core = create(f, &lamp_config);
    handshake(core, f, &lamp_config, "session-next", "2026-11-01T00:00:00.000Z");
    CHECK(receive(core, packet) == LI_SESSION);
    make_command(packet, sizeof(packet), "command-unknown", "session-next", "true", false);
    CHECK(receive(core, packet) == LI_CONFLICT); CHECK(f->writes == 1);
    li_core_destroy(core); free(f);
}
static void storage_failure_before_side_effect(void) {
    fixture_t *f = fixture(); li_core_t *core = create(f, &lamp_config); handshake(core, f, &lamp_config, "session-test", "2026-11-01T00:00:00Z");
    char packet[2048]; make_command(packet, sizeof(packet), "command-no-write", "session-test", "true", false);
    f->fail_store = 1; CHECK(receive(core, packet) == LI_STORAGE); CHECK(f->writes == 0 && !f->power);
    li_core_destroy(core); strcpy(f->storage[0], "{broken");
    li_ports_t ports = {f, random_bytes, monotonic, sha256, load, save, publish, read_property, write_property, NULL}; li_error_t error;
    CHECK(li_core_create(&lamp_config, &ports, &error) == NULL && error == LI_STORAGE); free(f);
}
static void session_expiry_and_clock(void) {
    fixture_t *f = fixture(); li_core_t *core = create(f, &lamp_config); handshake(core, f, &lamp_config, "session-test", "2026-11-01T00:00:00.000000123Z");
    char packet[2048]; make_command(packet, sizeof(packet), "command-expired", "old-session", "true", false);
    CHECK(receive(core, packet) == LI_SESSION);
    make_command(packet, sizeof(packet), "command-expired", "session-test", "true", false); f->mono += 5000;
    CHECK(receive(core, packet) == LI_EXPIRED && f->writes == 0);
    f->mono = 999; CHECK(receive(core, packet) == LI_CLOCK && f->writes == 0);
    CHECK(li_tick(core) == LI_CLOCK && !li_ready(core)); li_core_destroy(core); free(f);
}
static void bounded_journal_does_not_replay_evicted_commands(void) {
    fixture_t *f = fixture(); li_core_t *core = create(f, &lamp_config); handshake(core, f, &lamp_config, "session-test", "2026-11-01T00:00:00Z");
    char packet[2048], id[40];
    for (unsigned i = 0; i < LI_RECEIPT_SLOTS; i++) { snprintf(id, sizeof(id), "command-%u", i); make_command(packet, sizeof(packet), id, "session-test", "true", false); CHECK(receive(core, packet) == LI_OK); }
    make_command(packet, sizeof(packet), "command-overflow", "session-test", "true", false); CHECK(receive(core, packet) == LI_CAPACITY); CHECK(f->writes == LI_RECEIPT_SLOTS);
    li_disconnected(core); handshake(core, f, &lamp_config, "session-next", "2026-11-01T00:00:10Z");
    make_command(packet, sizeof(packet), "command-overflow", "session-next", "true", false);
    char *issued = strstr(packet, "00:00:00.000Z"), *expires = strstr(packet, "00:00:05.000Z"); CHECK(issued && expires); issued[6] = '1'; expires[6] = '1';
    CHECK(receive(core, packet) == LI_OK); CHECK(f->writes == LI_RECEIPT_SLOTS + 1);
    make_command(packet, sizeof(packet), "command-0", "session-next", "true", false); CHECK(receive(core, packet) == LI_EXPIRED); CHECK(f->writes == LI_RECEIPT_SLOTS + 1);
    li_core_destroy(core); free(f);
}
static void malformed_packets_never_execute(void) {
    fixture_t *f = fixture(); li_core_t *core = create(f, &lamp_config); handshake(core, f, &lamp_config, "session-test", "2026-11-01T00:00:00Z");
    char packet[2048]; make_command(packet, sizeof(packet), "command-malformed", "session-test", "true", false);
    CHECK(li_receive(core, "limeiot/v1/space-other/device-lamp/down/command", packet, strlen(packet), false) == LI_INVALID);
    CHECK(li_receive(core, "limeiot/v1/space-demo/device-lamp/down/command", packet, strlen(packet), true) == LI_INVALID);
    size_t size = strlen(packet); packet[size-1] = ','; strcpy(packet + size, "\"v\":1}"); CHECK(receive(core, packet) == LI_INVALID);
    CHECK(receive(core, "{\"v\":1}\nfalse") == LI_INVALID);
    CHECK(receive(core, "{\"name\":\"a\\u0000b\"}") == LI_INVALID);
    CHECK(receive(core, "[[[[[[[[[[[[[[[[[0]]]]]]]]]]]]]]]]]") == LI_INVALID);
    make_command(packet, sizeof(packet), "command-type", "session-test", "1", false); CHECK(receive(core, packet) == LI_INVALID); CHECK(f->writes == 0);
    make_command(packet, sizeof(packet), "command-decimal", "session-test", "true", false);
    memmove(packet + 8, packet + 6, strlen(packet + 6) + 1); packet[6] = '.'; packet[7] = '0';
    CHECK(receive(core, packet) == LI_INVALID && f->writes == 0);
    li_core_destroy(core); free(f);
}
static void unknown_driver_and_transport_result_retry(void) {
    fixture_t *f = fixture(); li_core_t *core = create(f, &lamp_config); handshake(core, f, &lamp_config, "session-test", "2026-11-01T00:00:00Z");
    char packet[2048]; make_command(packet, sizeof(packet), "command-uncertain", "session-test", "true", false);
    f->outcome = LI_EXECUTION_UNKNOWN; CHECK(receive(core, packet) == LI_OK); status(f, "unknown");
    CHECK(receive(core, packet) == LI_OK && f->writes == 1);
    f->outcome = LI_APPLIED; f->drop_results = 1;
    make_command(packet, sizeof(packet), "command-lost-result", "session-test", "false", false);
    CHECK(receive(core, packet) == LI_TRANSPORT && f->writes == 2); CHECK(li_tick(core) == LI_IGNORED); status(f, "confirmed"); CHECK(f->writes == 2);
    li_core_destroy(core); free(f);
}
static void button_event_binding_and_snapshot(void) {
    fixture_t *f = fixture(); const li_config_t config = {"space-demo", "device-button", LI_BUTTON_REVISION, "0.1.0", "host-test", NULL, 0, LI_BUTTON_EVENTS, LI_BUTTON_EVENT_COUNT, "host-fixture"};
    li_core_t *core = create(f, &config); CHECK(li_emit_event(core, "button.pressed", 1) == LI_CLOCK);
    handshake(core, f, &config, "button-session", "2026-11-01T00:00:00Z");
    CHECK(li_emit_event(core, "button.pressed", 1) == LI_OK); CHECK(li_emit_event(core, "button.pressed", 4) == LI_INVALID);
    cJSON *message = last(f, "event"); cJSON *body = cJSON_GetObjectItemCaseSensitive(message, "body"); CHECK(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(body, "historical"))); CHECK(cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(body, "data"), "count")->valueint == 1); cJSON_Delete(message);
    li_core_destroy(core); free(f);
}
static void expiry_during_storage_never_reaches_driver(void) {
    fixture_t *f = fixture(); li_core_t *core = create(f, &lamp_config); handshake(core, f, &lamp_config, "session-test", "2026-11-01T00:00:00Z");
    char packet[2048]; make_command(packet, sizeof(packet), "command-slow-storage", "session-test", "true", false);
    f->storage_delay = 5000;
    CHECK(receive(core, packet) == LI_OK && f->writes == 0); status(f, "failed");
    li_core_destroy(core); free(f);
}
static void utc_observations_preserve_milliseconds_and_calendar_boundaries(void) {
    static const struct { const char *anchor, *expected; int64_t elapsed; } cases[] = {
        {"2020-02-29T23:59:59.999Z", "2020-03-01T00:00:00.000Z", 1},
        {"2038-01-19T03:14:07.001Z", "2038-01-19T03:14:08.001Z", 1000},
        {"2099-12-31T23:59:59.987Z", "2100-01-01T00:00:00.001Z", 14},
        {"2100-02-28T23:59:59.999Z", "2100-03-01T00:00:00.000Z", 1},
    };
    for (size_t i = 0; i < sizeof(cases)/sizeof(cases[0]); i++) {
        fixture_t *f = fixture(); li_core_t *core = create(f, &lamp_config);
        handshake(core, f, &lamp_config, "calendar-session", cases[i].anchor);
        f->mono += cases[i].elapsed; CHECK(li_report_snapshot(core) == LI_OK);
        cJSON *message = last(f, "state");
        cJSON *properties = cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(message, "body"), "properties");
        CHECK(cJSON_GetArraySize(properties) == LI_LAMP_PROPERTY_COUNT);
        for (const cJSON *entry = properties->child; entry; entry = entry->next) {
            const cJSON *observed = cJSON_GetObjectItemCaseSensitive(entry, "observed_at");
            CHECK(cJSON_IsString(observed) && strcmp(observed->valuestring, cases[i].expected) == 0);
        }
        cJSON_Delete(message); li_core_destroy(core); free(f);
    }
}
static void device_information_uses_current_session_and_rejects_invalid_ports(void) {
    fixture_t *f = fixture();
    f->device_info = (li_device_info_t){.product_id="desk-node-lamp-host", .architecture="native", .chip="host", .board="host-fixture", .bootloader_version="0.0.1", .ota_capacity_bytes=1966080, .external_power=true};
    li_core_t *core = create(f, &lamp_config);
    handshake(core, f, &lamp_config, "info-session", "2026-11-01T00:00:00Z");
    cJSON *message = last(f, "device_info"); cJSON *body = cJSON_GetObjectItemCaseSensitive(message, "body");
    CHECK(strcmp(cJSON_GetObjectItemCaseSensitive(message, "session_id")->valuestring, "info-session") == 0);
    CHECK(strcmp(cJSON_GetObjectItemCaseSensitive(body, "device_id")->valuestring, lamp_config.device_id) == 0);
    CHECK(strcmp(cJSON_GetObjectItemCaseSensitive(body, "model_revision")->valuestring, LI_LAMP_REVISION) == 0);
    CHECK(strcmp(cJSON_GetObjectItemCaseSensitive(body, "firmware_version")->valuestring, "0.1.0") == 0);
    CHECK(cJSON_IsNull(cJSON_GetObjectItemCaseSensitive(body, "battery_percent")));
    CHECK(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(body, "safe_to_update")));
    cJSON_Delete(message);
    f->device_info.has_battery = true; f->device_info.battery_percent = 75; f->device_info.pending_update = true;
    f->device_info.bootloader_version = "0.0.4294967295";
    f->mono += 2000; CHECK(li_tick(core) == LI_OK);
    message = last(f, "device_info"); body = cJSON_GetObjectItemCaseSensitive(message, "body");
    CHECK(cJSON_GetObjectItemCaseSensitive(body, "battery_percent")->valueint == 75);
    CHECK(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(body, "pending_update")));
    double previous = cJSON_GetObjectItemCaseSensitive(message, "seq")->valuedouble; cJSON_Delete(message);
    f->device_info.battery_percent = 101; CHECK(li_report_snapshot(core) == LI_INVALID);
    f->device_info.battery_percent = 75; f->device_info.bootloader_version = "0.0.4294967296"; CHECK(li_report_snapshot(core) == LI_INVALID);
    f->device_info.bootloader_version = "0.0.1"; f->device_info.board = NULL; CHECK(li_report_snapshot(core) == LI_INVALID);
    f->device_info.board = "host-fixture"; f->device_info.ota_capacity_bytes = 0; CHECK(li_report_snapshot(core) == LI_INVALID);
    f->device_info.ota_capacity_bytes = 33554433; CHECK(li_report_snapshot(core) == LI_INVALID);
    f->device_info.ota_capacity_bytes = 1966080; f->fail_info = true; CHECK(li_report_snapshot(core) == LI_DRIVER);
    message = last(f, "device_info"); CHECK(cJSON_GetObjectItemCaseSensitive(message, "seq")->valuedouble == previous); cJSON_Delete(message);
    f->fail_info = false; li_disconnected(core); CHECK(li_tick(core) == LI_IGNORED);
    handshake(core, f, &lamp_config, "next-info-session", "2026-11-01T00:00:03Z");
    message = last(f, "device_info");
    CHECK(strcmp(cJSON_GetObjectItemCaseSensitive(message, "session_id")->valuestring, "next-info-session") == 0);
    CHECK(cJSON_GetObjectItemCaseSensitive(message, "seq")->valuedouble > previous);
    cJSON_Delete(message); li_core_destroy(core); free(f);
}
int main(void) {
    duplicate_and_conflict(); durable_intent_and_power_loss(); storage_failure_before_side_effect(); session_expiry_and_clock(); bounded_journal_does_not_replay_evicted_commands(); malformed_packets_never_execute(); unknown_driver_and_transport_result_retry(); button_event_binding_and_snapshot(); expiry_during_storage_never_reaches_driver();
    utc_observations_preserve_milliseconds_and_calendar_boundaries();
    device_information_uses_current_session_and_rejects_invalid_ports();
    puts("{\"firmware_core_checks\":11,\"physical_hardware\":false}"); return 0;
}
