/* 固件同一核心的宿主端口。只允许回环 MQTT；虚拟驱动不是硬件验收证据。 */
#include "limeiot.h"
#include "lamp.h"
#include "button.h"
#include "cJSON.h"
#include <mosquitto.h>
#include <mqtt_protocol.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

typedef struct {
    struct mosquitto *mqtt;
    li_core_t *core;
    const li_config_t *config;
    char directory[PATH_MAX];
    bool power, button, connected;
    int64_t brightness;
    unsigned store_calls, fail_store;
} host_t;
static volatile sig_atomic_t stopping;
static void stop_signal(int signal) { (void)signal; stopping = 1; }
static bool random_bytes(void *context, uint8_t *bytes, size_t length) { (void)context; return RAND_bytes(bytes, (int)length) == 1; }
static int64_t monotonic(void *context) { (void)context; struct timespec now; if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1; return (int64_t)now.tv_sec * 1000 + now.tv_nsec/1000000; }
static bool sha256(void *context, const uint8_t *data, size_t length, uint8_t result[32]) { (void)context; unsigned size; return EVP_Digest(data, length, result, &size, EVP_sha256(), NULL) == 1 && size == 32; }
static bool storage_read(void *context, unsigned slot, char *data, size_t capacity, size_t *length, bool *found) {
    host_t *host = context; char path[PATH_MAX];
    if (snprintf(path, sizeof(path), "%s/receipt-%u.json", host->directory, slot) >= (int)sizeof(path)) return false;
    int fd = open(path, O_RDONLY | O_NOFOLLOW);
    if (fd < 0) { *found = false; return errno == ENOENT; }
    struct stat metadata;
    if (fstat(fd, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_size < 0 || (uint64_t)metadata.st_size >= capacity) { close(fd); return false; }
    ssize_t size = read(fd, data, capacity); close(fd);
    if (size < 0 || size != metadata.st_size) return false;
    *length = (size_t)size; *found = true; return true;
}
static bool durable_file(host_t *host, const char *name, const char *data, size_t length) {
    char path[PATH_MAX], temporary[PATH_MAX];
    if (snprintf(path, sizeof(path), "%s/%s", host->directory, name) >= (int)sizeof(path) || snprintf(temporary, sizeof(temporary), "%s/.%s.tmp", host->directory, name) >= (int)sizeof(temporary)) return false;
    int fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600); if (fd < 0) return false;
    bool written = write(fd, data, length) == (ssize_t)length && fsync(fd) == 0;
    if (close(fd) != 0) written = false;
    if (!written || rename(temporary, path) != 0) return false;
    int directory = open(host->directory, O_RDONLY); if (directory < 0) return false;
    written = fsync(directory) == 0; close(directory); return written;
}
static bool storage_write(void *context, unsigned slot, const char *data, size_t length) {
    host_t *host = context; host->store_calls++;
    if (host->store_calls == host->fail_store) return false;
    char name[40]; snprintf(name, sizeof(name), "receipt-%u.json", slot); return durable_file(host, name, data, length);
}
static bool publish(void *context, const char *topic, const char *data, size_t length) {
    host_t *host = context;
    return mosquitto_publish_v5(host->mqtt, NULL, topic, (int)length, data, 1, false, NULL) == MOSQ_ERR_SUCCESS;
}
static bool read_property(void *context, const char *path, li_value_t *value) {
    host_t *host = context; memset(value, 0, sizeof(*value));
    if (strcmp(path, "light.power") == 0) { value->type = LI_BOOLEAN; value->boolean = host->power; return true; }
    if (strcmp(path, "light.brightness") == 0) { value->type = LI_INTEGER; value->integer = host->brightness; return true; }
    return false;
}
static li_apply_result_t write_property(void *context, const char *path, li_value_t value) {
    host_t *host = context; bool power = host->power; int64_t brightness = host->brightness;
    if (strcmp(path, "light.power") == 0) power = value.boolean; else if (strcmp(path, "light.brightness") == 0) brightness = value.integer; else return LI_NOT_APPLIED;
    char state[128]; int size = snprintf(state, sizeof(state), "{\"power\":%s,\"brightness\":%lld}", power ? "true" : "false", (long long)brightness);
    if (size < 0 || !durable_file(host, "hardware.json", state, (size_t)size)) return LI_EXECUTION_UNKNOWN;
    host->power = power; host->brightness = brightness; return LI_APPLIED;
}
static void on_connect(struct mosquitto *mqtt, void *context, int reason, int flags, const mosquitto_property *properties) {
    (void)flags; (void)properties; host_t *host = context;
    if (reason != MQTT_RC_SUCCESS) { stopping = 1; return; }
    char topic[256]; snprintf(topic, sizeof(topic), "limeiot/v1/%s/%s/down/+", host->config->space_id, host->config->device_id);
    if (mosquitto_subscribe_v5(mqtt, NULL, topic, 1, MQTT_SUB_OPT_RETAIN_AS_PUBLISHED, NULL) != MOSQ_ERR_SUCCESS) stopping = 1;
}
static void on_subscribe(struct mosquitto *mqtt, void *context, int mid, int count, const int *granted, const mosquitto_property *properties) {
    (void)mqtt; (void)mid; (void)properties; host_t *host = context;
    if (count != 1 || granted[0] > 2 || li_connected(host->core) != LI_OK) { stopping = 1; return; }
    host->connected = true;
}
static void on_disconnect(struct mosquitto *mqtt, void *context, int reason, const mosquitto_property *properties) {
    (void)mqtt; (void)reason; (void)properties; host_t *host = context;
    host->connected = false; li_disconnected(host->core);
}
static void on_message(struct mosquitto *mqtt, void *context, const struct mosquitto_message *message, const mosquitto_property *properties) {
    (void)mqtt; (void)properties; host_t *host = context;
    li_error_t error = li_receive(host->core, message->topic, message->payload, (size_t)message->payloadlen, message->retain);
    if (error != LI_OK && error != LI_IGNORED) fprintf(stderr, "{\"event\":\"firmware.rejected\",\"code\":\"%s\"}\n", li_error_code(error));
}
int main(int argc, char **argv) {
    if (argc != 4 || (strcmp(argv[2], "lamp") != 0 && strcmp(argv[2], "button") != 0)) return 2;
    const char *broker = getenv("LIMEIOT_MQTT_HOST"), *password = getenv("LIMEIOT_MQTT_PASSWORD"), *port_text = getenv("LIMEIOT_MQTT_PORT");
    if (!broker || strcmp(broker, "127.0.0.1") != 0 || !password || !port_text) return 2;
    char *end; long port = strtol(port_text, &end, 10); if (*end || port < 1 || port > 65535) return 2;
    host_t host = {0}; host.button = strcmp(argv[2], "button") == 0;
    if (strlen(argv[3]) >= sizeof(host.directory)) return 2;
    strcpy(host.directory, argv[3]); if (mkdir(host.directory, 0700) != 0 && errno != EEXIST) return 2;
    struct stat directory; if (lstat(host.directory, &directory) != 0 || !S_ISDIR(directory.st_mode)) return 2;
    li_config_t config = {"space-demo", argv[1], host.button ? LI_BUTTON_REVISION : LI_LAMP_REVISION, "firmware-host-0.1.0", "host-fixture", host.button ? NULL : LI_LAMP_PROPERTIES, host.button ? 0 : LI_LAMP_PROPERTY_COUNT, host.button ? LI_BUTTON_EVENTS : NULL, host.button ? LI_BUTTON_EVENT_COUNT : 0, "host-fixture"};
    host.config = &config;
    char state_path[PATH_MAX]; snprintf(state_path, sizeof(state_path), "%s/hardware.json", host.directory);
    FILE *state = fopen(state_path, "rb");
    if (state) { char data[128]; size_t count = fread(data, 1, sizeof(data)-1, state); fclose(state); data[count] = '\0'; cJSON *json = cJSON_Parse(data); if (!json) return 2; cJSON *power = cJSON_GetObjectItemCaseSensitive(json, "power"), *brightness = cJSON_GetObjectItemCaseSensitive(json, "brightness"); if (!cJSON_IsBool(power) || !cJSON_IsNumber(brightness) || brightness->valuedouble < 0 || brightness->valuedouble > 100) { cJSON_Delete(json); return 2; } host.power = cJSON_IsTrue(power); host.brightness = brightness->valueint; cJSON_Delete(json); }
    const char *failure = getenv("LIMEIOT_FIRMWARE_FAIL_STORE"); if (failure) host.fail_store = (unsigned)strtoul(failure, NULL, 10);
    li_ports_t ports = {&host, random_bytes, monotonic, sha256, storage_read, storage_write, publish, read_property, write_property}; li_error_t error;
    host.core = li_core_create(&config, &ports, &error); if (!host.core) return 2;
    mosquitto_lib_init(); host.mqtt = mosquitto_new(argv[1], true, &host); if (!host.mqtt) return 2;
    mosquitto_int_option(host.mqtt, MOSQ_OPT_PROTOCOL_VERSION, MQTT_PROTOCOL_V5);
    mosquitto_username_pw_set(host.mqtt, argv[1], password);
    mosquitto_connect_v5_callback_set(host.mqtt, on_connect); mosquitto_subscribe_v5_callback_set(host.mqtt, on_subscribe); mosquitto_disconnect_v5_callback_set(host.mqtt, on_disconnect); mosquitto_message_v5_callback_set(host.mqtt, on_message);
    signal(SIGINT, stop_signal); signal(SIGTERM, stop_signal);
    if (mosquitto_connect_bind_v5(host.mqtt, broker, (int)port, 10, NULL, NULL) != MOSQ_ERR_SUCCESS) stopping = 1;
    char input[1024]; size_t used = 0; bool stdin_open = true;
    while (!stopping) {
        int status = mosquitto_loop(host.mqtt, 50, 1);
        if (status != MOSQ_ERR_SUCCESS) { li_disconnected(host.core); host.connected = false; struct timespec delay = {0, 500000000}; nanosleep(&delay, NULL); mosquitto_reconnect(host.mqtt); }
        if (host.connected) (void)li_tick(host.core);
        struct pollfd descriptor = {STDIN_FILENO, POLLIN, 0};
        if (stdin_open && poll(&descriptor, 1, 0) > 0 && (descriptor.revents & (POLLIN | POLLHUP))) {
            char byte; ssize_t count = read(STDIN_FILENO, &byte, 1);
            if (count == 0) stdin_open = false;
            else if (count == 1 && byte == '\n') {
                input[used] = '\0'; used = 0; cJSON *json = cJSON_Parse(input);
                if (json) { cJSON *data = cJSON_GetObjectItemCaseSensitive(json, "data"), *value = cJSON_GetObjectItemCaseSensitive(data, "count"); if (host.button && cJSON_IsNumber(value)) (void)li_emit_event(host.core, "button.pressed", value->valueint); cJSON_Delete(json); }
            } else if (count == 1 && used < sizeof(input)-1) input[used++] = byte;
        }
    }
    mosquitto_disconnect(host.mqtt); mosquitto_destroy(host.mqtt); mosquitto_lib_cleanup(); li_core_destroy(host.core); return 0;
}
