#include "limeiot_espidf.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "mqtt_client.h"
#include "mqtt5_client.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "psa/crypto.h"
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef enum { WORK_CONNECTED, WORK_MESSAGE, WORK_EVENT } work_kind_t;
typedef struct {
    work_kind_t kind;
    unsigned generation;
    char topic[256], path[LI_PATH_SIZE];
    char *payload;
    size_t length;
    bool retained;
    int64_t value;
} work_t;
struct li_espidf {
    li_espidf_options_t options;
    li_core_t *core;
    esp_mqtt_client_handle_t mqtt;
    nvs_handle_t journal;
    QueueHandle_t queue;
    atomic_bool connected, ready, reconnect;
    atomic_uint generation;
    unsigned executing_generation;
    work_t incoming;
    size_t received;
    int subscription;
};
static const char *TAG = "limeiot";

static bool random_bytes(void *context, uint8_t *data, size_t length) { (void)context; esp_fill_random(data, length); return true; }
static int64_t monotonic_ms(void *context) { (void)context; return esp_timer_get_time()/1000; }
static bool sha256(void *context, const uint8_t *data, size_t length, uint8_t result[32]) {
    (void)context; size_t actual;
    return psa_hash_compute(PSA_ALG_SHA_256, data, length, result, 32, &actual) == PSA_SUCCESS && actual == 32;
}
static bool storage_read(void *context, unsigned slot, char *data, size_t capacity, size_t *length, bool *found) {
    li_espidf_t *adapter = context; char key[8]; snprintf(key, sizeof(key), "r%02u", slot);
    size_t size = 0; esp_err_t error = nvs_get_blob(adapter->journal, key, NULL, &size);
    if (error == ESP_ERR_NVS_NOT_FOUND) { *found = false; *length = 0; return true; }
    if (error != ESP_OK || size >= capacity) return false;
    if (nvs_get_blob(adapter->journal, key, data, &size) != ESP_OK) return false;
    *found = true; *length = size; return true;
}
static bool storage_write(void *context, unsigned slot, const char *data, size_t length) {
    li_espidf_t *adapter = context; char key[8]; snprintf(key, sizeof(key), "r%02u", slot);
    return nvs_set_blob(adapter->journal, key, data, length) == ESP_OK && nvs_commit(adapter->journal) == ESP_OK;
}
static bool publish(void *context, const char *topic, const char *data, size_t length) {
    li_espidf_t *adapter = context;
    if (!atomic_load(&adapter->connected) || adapter->executing_generation != atomic_load(&adapter->generation)) return false;
    return esp_mqtt_client_enqueue(adapter->mqtt, topic, data, (int)length, 1, false, true) >= 0;
}
static bool read_property(void *context, const char *path, li_value_t *value) {
    li_espidf_t *adapter = context;
    return adapter->options.read_property(adapter->options.driver_context, path, value);
}
static li_apply_result_t write_property(void *context, const char *path, li_value_t value) {
    li_espidf_t *adapter = context;
    if (!atomic_load(&adapter->connected) || adapter->executing_generation != atomic_load(&adapter->generation) || !adapter->options.trusted_clock(adapter->options.driver_context)) return LI_NOT_APPLIED;
    return adapter->options.write_property(adapter->options.driver_context, path, value);
}
static void reset_incoming(li_espidf_t *adapter) { free(adapter->incoming.payload); memset(&adapter->incoming, 0, sizeof(adapter->incoming)); adapter->received = 0; }
static void mqtt_event(void *context, esp_event_base_t base, int32_t event_id, void *event_data) {
    (void)base; li_espidf_t *adapter = context; esp_mqtt_event_handle_t event = event_data;
    if (event_id == MQTT_EVENT_CONNECTED) {
        reset_incoming(adapter); atomic_fetch_add(&adapter->generation, 1); atomic_store(&adapter->connected, true);
        char topic[256]; snprintf(topic, sizeof(topic), "limeiot/v1/%s/%s/down/+", adapter->options.core.space_id, adapter->options.core.device_id);
        adapter->subscription = esp_mqtt_client_subscribe(adapter->mqtt, topic, 1);
        if (adapter->subscription < 0) atomic_store(&adapter->reconnect, true);
    } else if (event_id == MQTT_EVENT_DISCONNECTED) {
        atomic_store(&adapter->connected, false); atomic_store(&adapter->ready, false); atomic_fetch_add(&adapter->generation, 1); reset_incoming(adapter);
    } else if (event_id == MQTT_EVENT_SUBSCRIBED && event->msg_id == adapter->subscription) {
        if (event->data_len != 1 || !event->data || (unsigned char)event->data[0] > 2) { atomic_store(&adapter->reconnect, true); return; }
        work_t work = {.kind = WORK_CONNECTED, .generation = atomic_load(&adapter->generation)};
        if (xQueueSend(adapter->queue, &work, 0) != pdTRUE) atomic_store(&adapter->reconnect, true);
    } else if (event_id == MQTT_EVENT_DATA) {
        if (event->total_data_len < 1 || event->total_data_len > LI_MAX_PACKET || event->data_len < 1 || event->current_data_offset < 0 || event->data_len > event->total_data_len - event->current_data_offset) goto malformed;
        if (event->current_data_offset == 0) {
            if (adapter->incoming.payload || event->topic_len <= 0 || event->topic_len >= (int)sizeof(adapter->incoming.topic)) goto malformed;
            adapter->incoming = (work_t){.kind = WORK_MESSAGE, .generation = atomic_load(&adapter->generation), .length = (size_t)event->total_data_len, .retained = event->retain};
            memcpy(adapter->incoming.topic, event->topic, (size_t)event->topic_len); adapter->incoming.topic[event->topic_len] = '\0';
            adapter->incoming.payload = malloc(adapter->incoming.length + 1); if (!adapter->incoming.payload) goto malformed;
            adapter->incoming.payload[adapter->incoming.length] = '\0';
        }
        if (!adapter->incoming.payload || adapter->received != (size_t)event->current_data_offset || adapter->incoming.length != (size_t)event->total_data_len) goto malformed;
        memcpy(adapter->incoming.payload + adapter->received, event->data, (size_t)event->data_len); adapter->received += (size_t)event->data_len;
        if (adapter->received == adapter->incoming.length) {
            if (xQueueSend(adapter->queue, &adapter->incoming, 0) != pdTRUE) goto malformed;
            memset(&adapter->incoming, 0, sizeof(adapter->incoming)); adapter->received = 0;
        }
    }
    return;
malformed:
    reset_incoming(adapter); atomic_store(&adapter->ready, false); atomic_store(&adapter->connected, false); atomic_store(&adapter->reconnect, true);
}
static void worker(void *context) {
    li_espidf_t *adapter = context;
    for (;;) {
        if (atomic_exchange(&adapter->reconnect, false)) { li_disconnected(adapter->core); atomic_store(&adapter->ready, false); (void)esp_mqtt_client_reconnect(adapter->mqtt); }
        work_t work = {0};
        if (xQueueReceive(adapter->queue, &work, pdMS_TO_TICKS(100)) == pdTRUE) {
            li_error_t error = LI_IGNORED;
            if (atomic_load(&adapter->connected) && work.generation == atomic_load(&adapter->generation)) {
                adapter->executing_generation = work.generation;
                if (work.kind == WORK_CONNECTED) error = li_connected(adapter->core);
                else if (work.kind == WORK_MESSAGE) error = li_receive(adapter->core, work.topic, work.payload, work.length, work.retained);
                else error = li_emit_event(adapter->core, work.path, work.value);
            }
            free(work.payload);
            if (error != LI_OK && error != LI_IGNORED) ESP_LOGW(TAG, "device operation: %s", li_error_code(error));
        }
        if (!atomic_load(&adapter->connected) || adapter->executing_generation != atomic_load(&adapter->generation)) li_disconnected(adapter->core);
        else {
            li_error_t error = li_tick(adapter->core);
            if (error == LI_CLOCK) atomic_store(&adapter->reconnect, true);
        }
        atomic_store(&adapter->ready, li_ready(adapter->core) && atomic_load(&adapter->connected) && adapter->executing_generation == atomic_load(&adapter->generation));
    }
}
li_error_t li_espidf_start(const li_espidf_options_t *options, li_espidf_t **result) {
    if (!options || !result || !options->broker_host || !options->broker_port || !options->ca_pem || !options->certificate_pem || !options->private_key_pem || !options->trusted_clock || !options->read_property || !options->write_property) return LI_INVALID;
    if (!options->trusted_clock(options->driver_context)) return LI_CLOCK;
    if (psa_crypto_init() != PSA_SUCCESS) return LI_INVALID;
    li_espidf_t *adapter = calloc(1, sizeof(*adapter)); if (!adapter) return LI_CAPACITY;
    adapter->options = *options;
    if (nvs_flash_init_partition("journal") != ESP_OK || nvs_open_from_partition("journal", "receipts", NVS_READWRITE, &adapter->journal) != ESP_OK) { free(adapter); return LI_STORAGE; }
    li_ports_t ports = {adapter, random_bytes, monotonic_ms, sha256, storage_read, storage_write, publish, read_property, write_property}; li_error_t error;
    adapter->core = li_core_create(&options->core, &ports, &error);
    if (!adapter->core) { nvs_close(adapter->journal); free(adapter); return error; }
    adapter->queue = xQueueCreate(4, sizeof(work_t));
    if (!adapter->queue) { li_core_destroy(adapter->core); nvs_close(adapter->journal); free(adapter); return LI_CAPACITY; }
    esp_mqtt_client_config_t config = {
        .broker.address = {.hostname = options->broker_host, .port = options->broker_port, .transport = MQTT_TRANSPORT_OVER_SSL},
        .broker.verification = {.certificate = options->ca_pem, .skip_cert_common_name_check = false},
        .credentials.client_id = options->core.device_id,
        .credentials.authentication = {.certificate = options->certificate_pem, .key = options->private_key_pem},
        .session = {.protocol_ver = MQTT_PROTOCOL_V_5, .keepalive = 10, .disable_clean_session = false},
        .network = {.reconnect_timeout_ms = 5000, .timeout_ms = 8000},
        .buffer = {.size = 4096, .out_size = 4096}, .outbox.limit = 32768, .task = {.stack_size = 6144, .priority = 5},
    };
    adapter->mqtt = esp_mqtt_client_init(&config);
    if (!adapter->mqtt) goto capacity_error;
    esp_mqtt5_connection_property_config_t properties = {.maximum_packet_size = LI_MAX_PACKET + 512, .receive_maximum = 4, .session_expiry_interval = 0};
    if (esp_mqtt5_client_set_connect_property(adapter->mqtt, &properties) != ESP_OK || esp_mqtt_client_register_event(adapter->mqtt, ESP_EVENT_ANY_ID, mqtt_event, adapter) != ESP_OK) goto capacity_error;
    if (esp_mqtt_client_start(adapter->mqtt) != ESP_OK) goto capacity_error;
    if (xTaskCreate(worker, "limeiot-core", 8192, adapter, 5, NULL) != pdPASS) { (void)esp_mqtt_client_stop(adapter->mqtt); goto capacity_error; }
    *result = adapter; return LI_OK;
capacity_error:
    if (adapter->mqtt) esp_mqtt_client_destroy(adapter->mqtt);
    work_t queued;
    while (xQueueReceive(adapter->queue, &queued, 0) == pdTRUE) free(queued.payload);
    reset_incoming(adapter);
    vQueueDelete(adapter->queue); li_core_destroy(adapter->core); nvs_close(adapter->journal); free(adapter); return LI_CAPACITY;
}
bool li_espidf_ready(const li_espidf_t *adapter) { return adapter && atomic_load(&adapter->ready); }
li_error_t li_espidf_event(li_espidf_t *adapter, const char *path, int64_t value) {
    if (!adapter || !path || strlen(path) >= LI_PATH_SIZE || !li_espidf_ready(adapter)) return LI_SESSION;
    work_t work = {.kind = WORK_EVENT, .generation = atomic_load(&adapter->generation), .value = value}; strcpy(work.path, path);
    return xQueueSend(adapter->queue, &work, 0) == pdTRUE ? LI_OK : LI_CAPACITY;
}
