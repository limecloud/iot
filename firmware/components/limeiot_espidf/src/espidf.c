#include "limeiot_espidf.h"
#include "credential_window.h"
#include "crypto.h"
#include "limeiot_ota_log.h"
#include "limeiot_ota_device.h"
#include "ota_transfer.h"
#include "esp_system.h"
#include "esp_app_desc.h"
#include "esp_ota_ops.h"
#include "esp_image_format.h"
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
#include "mbedtls/x509_crt.h"
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/time.h>

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
    nvs_handle_t ota_storage;
    li_ota_log_t *ota_log;
    QueueHandle_t queue;
    atomic_bool connected, ready, reconnect;
    atomic_uint generation;
    unsigned executing_generation;
    li_credential_window_t credential_window;
    work_t incoming;
    size_t received;
    int subscription;
};
static const char *TAG = "limeiot";
static bool credentials_current(li_espidf_t *adapter) {
    bool trusted = adapter->options.trusted_clock(adapter->options.driver_context);
    bool valid = li_credential_window_check(&adapter->credential_window, trusted)
        && li_credential_window_check(&adapter->credential_window, adapter->options.trusted_clock(adapter->options.driver_context));
    if (!valid) {
        atomic_store(&adapter->ready, false);
        if (atomic_exchange(&adapter->connected, false)) atomic_fetch_add(&adapter->generation, 1);
    }
    return valid;
}
static bool ota_time(void *, int64_t *);
static bool ota_current(void *context) {
    li_espidf_t *adapter=context;
    return credentials_current(adapter)&&atomic_load(&adapter->connected)&&adapter->executing_generation==atomic_load(&adapter->generation)
        &&adapter->options.trusted_clock(adapter->options.driver_context);
}
static li_error_t ota_stage(void *context, const li_ota_candidate_t *candidate, const li_ota_transfer_guard_t *guard,
                            li_ota_transfer_result_t *result, const char **issue) {
    li_espidf_t *adapter=context;
    return li_espidf_ota_stage(candidate,adapter->options.ota_https_ca_pem,guard,result,issue);
}
static bool ota_activate(void *context, const li_ota_candidate_t *candidate, const li_ota_transfer_guard_t *guard, char binding[LI_OTA_LOG_ID_SIZE]) {
    (void)context; return li_esp_ota_activate(candidate,guard,binding);
}
static bool ota_observe(void *context, const li_ota_log_view_t *view, li_ota_stage_t *stage, li_ota_outcome_t *outcome) {
    (void)context; return li_esp_ota_observe(view,stage,outcome);
}
static void ota_restart(void *context) { (void)context; esp_restart(); }
static bool ota_running(void *context, li_ota_baseline_t *out, bool *pending) {
    li_espidf_t *adapter=context; li_device_info_t info={0};
    const esp_partition_t *partition=esp_ota_get_running_partition(); esp_image_metadata_t metadata={0};
    if (!partition || !adapter->options.read_device_info) return false;
    esp_partition_pos_t position={.offset=partition->address,.size=partition->size};
    if (!adapter->options.read_device_info(adapter->options.driver_context,&info)
        || esp_image_verify(ESP_IMAGE_VERIFY_SILENT,&position,&metadata)!=ESP_OK || !metadata.image_len || metadata.image_len>partition->size) return false;
    const char *version=esp_app_get_description()->version; if (strlen(version)>=sizeof(out->firmware_version)) return false;
    psa_hash_operation_t operation=PSA_HASH_OPERATION_INIT; uint8_t buffer[1024], digest[32]; size_t actual=0;
    bool ok=psa_hash_setup(&operation,PSA_ALG_SHA_256)==PSA_SUCCESS;
    for (uint32_t offset=0;ok&&offset<metadata.image_len;) {
        size_t size=metadata.image_len-offset; if (size>sizeof(buffer)) size=sizeof(buffer);
        ok=esp_partition_read(partition,offset,buffer,size)==ESP_OK&&psa_hash_update(&operation,buffer,size)==PSA_SUCCESS; offset+=(uint32_t)size;
    }
    if (ok) ok=psa_hash_finish(&operation,digest,sizeof(digest),&actual)==PSA_SUCCESS&&actual==32;
    (void)psa_hash_abort(&operation); if (!ok) return false;
    memset(out,0,sizeof(*out)); strcpy(out->firmware_version,version); out->security_epoch=info.security_epoch;
    strcpy(out->image_sha256,"sha256:");
    for (size_t i=0;i<32;i++) snprintf(out->image_sha256+7+2*i,3,"%02x",digest[i]);
    *pending=info.pending_update; return true;
}
static bool ota_clock_ms(void *context, int64_t *milliseconds) {
    li_espidf_t *adapter=context; struct timeval now;
    if (!adapter->options.trusted_clock(adapter->options.driver_context) || gettimeofday(&now,NULL)!=0 || now.tv_sec<0
        || !adapter->options.trusted_clock(adapter->options.driver_context)) return false;
    *milliseconds=(int64_t)now.tv_sec*1000+now.tv_usec/1000; return true;
}
static bool ota_log_read(void *context, char *data, size_t capacity, size_t *length, bool *found) {
    li_espidf_t *adapter=context; size_t size=0;
    esp_err_t error=nvs_get_blob(adapter->ota_storage,"state",NULL,&size);
    if (error==ESP_ERR_NVS_NOT_FOUND) { *found=false; *length=0; return true; }
    if (error!=ESP_OK || size>capacity || nvs_get_blob(adapter->ota_storage,"state",data,&size)!=ESP_OK) return false;
    *found=true; *length=size; return true;
}
static bool ota_log_write(void *context, const char *data, size_t length) {
    li_espidf_t *adapter=context;
    return nvs_set_blob(adapter->ota_storage,"state",data,length)==ESP_OK && nvs_commit(adapter->ota_storage)==ESP_OK;
}
static void close_ota_log(li_espidf_t *adapter) { li_ota_log_close(adapter->ota_log); nvs_close(adapter->ota_storage); }

static bool random_bytes(void *context, uint8_t *data, size_t length) { (void)context; esp_fill_random(data, length); return true; }
static int64_t monotonic_ms(void *context) { (void)context; return esp_timer_get_time()/1000; }
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
    if (!credentials_current(adapter) || !atomic_load(&adapter->connected) || adapter->executing_generation != atomic_load(&adapter->generation)) return false;
    return esp_mqtt_client_enqueue(adapter->mqtt, topic, data, (int)length, 1, false, true) >= 0;
}
static bool read_property(void *context, const char *path, li_value_t *value) {
    li_espidf_t *adapter = context;
    return adapter->options.read_property(adapter->options.driver_context, path, value);
}
static bool read_observation(void *context, const char *path, li_observation_t *value) {
    li_espidf_t *adapter = context;
    return adapter->options.read_observation(adapter->options.driver_context, path, value);
}
static bool read_device_info(void *context, li_device_info_t *info) {
    li_espidf_t *adapter = context;
    return adapter->options.read_device_info(adapter->options.driver_context, info);
}
static li_apply_result_t write_property(void *context, const char *path, li_value_t value) {
    li_espidf_t *adapter = context;
    if (!credentials_current(adapter) || !atomic_load(&adapter->connected) || adapter->executing_generation != atomic_load(&adapter->generation) || !adapter->options.trusted_clock(adapter->options.driver_context)
        || li_ota_log_blocked(adapter->ota_log)) return LI_NOT_APPLIED;
    return adapter->options.write_property(adapter->options.driver_context, path, value);
}
static void reset_incoming(li_espidf_t *adapter) { free(adapter->incoming.payload); memset(&adapter->incoming, 0, sizeof(adapter->incoming)); adapter->received = 0; }
static void mqtt_event(void *context, esp_event_base_t base, int32_t event_id, void *event_data) {
    (void)base; li_espidf_t *adapter = context; esp_mqtt_event_handle_t event = event_data;
    if (event_id != MQTT_EVENT_DISCONNECTED && !credentials_current(adapter)) { reset_incoming(adapter); return; }
    if (event_id == MQTT_EVENT_CONNECTED) {
        reset_incoming(adapter); atomic_fetch_add(&adapter->generation, 1); atomic_store(&adapter->connected, true);
        char topic[256]; snprintf(topic, sizeof(topic), "limeiot/v1/%s/%s/down/+", adapter->options.core.space_id, adapter->options.core.device_id);
        adapter->subscription = esp_mqtt_client_subscribe(adapter->mqtt, topic, 1);
        if (adapter->subscription < 0) atomic_store(&adapter->reconnect, true);
    } else if (event_id == MQTT_EVENT_DISCONNECTED) {
        atomic_store(&adapter->connected, false); atomic_store(&adapter->ready, false); atomic_fetch_add(&adapter->generation, 1); reset_incoming(adapter);
        atomic_store(&adapter->reconnect, true);
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
    bool transport_stopped = false;
    int64_t next_reconnect = 0;
    for (;;) {
        if (!credentials_current(adapter)) {
            li_disconnected(adapter->core);
            if (!transport_stopped) transport_stopped = esp_mqtt_client_stop(adapter->mqtt) == ESP_OK;
        } else if (atomic_exchange(&adapter->reconnect, false)) {
            li_disconnected(adapter->core); atomic_store(&adapter->ready, false);
            if (atomic_exchange(&adapter->connected, false)) atomic_fetch_add(&adapter->generation, 1);
            int64_t now = monotonic_ms(adapter);
            if (now >= next_reconnect) {
                next_reconnect = now + 5000;
                if (esp_mqtt_client_reconnect(adapter->mqtt) != ESP_OK) {
                    (void)esp_mqtt_client_disconnect(adapter->mqtt);
                    atomic_store(&adapter->reconnect, true);
                }
            } else atomic_store(&adapter->reconnect, true);
        }
        work_t work = {0};
        if (xQueueReceive(adapter->queue, &work, pdMS_TO_TICKS(100)) == pdTRUE) {
            li_error_t error = LI_IGNORED;
            if (credentials_current(adapter) && atomic_load(&adapter->connected) && work.generation == atomic_load(&adapter->generation)) {
                adapter->executing_generation = work.generation;
                if (work.kind == WORK_CONNECTED) error = li_connected(adapter->core);
                else if (work.kind == WORK_MESSAGE) error = li_receive(adapter->core, work.topic, work.payload, work.length, work.retained);
                else error = li_emit_event(adapter->core, work.path, work.value);
            }
            free(work.payload);
            if (error != LI_OK && error != LI_IGNORED) ESP_LOGW(TAG, "device operation: %s", li_error_code(error));
        }
        if (!credentials_current(adapter) || !atomic_load(&adapter->connected) || adapter->executing_generation != atomic_load(&adapter->generation)) li_disconnected(adapter->core);
        else {
            li_error_t error = li_tick(adapter->core);
            if (error == LI_CLOCK) atomic_store(&adapter->reconnect, true);
        }
        atomic_store(&adapter->ready, credentials_current(adapter) && li_ready(adapter->core) && atomic_load(&adapter->connected) && adapter->executing_generation == atomic_load(&adapter->generation));
    }
}
li_error_t li_espidf_start(const li_espidf_options_t *options, li_espidf_t **result) {
    if (!options || !result || !options->broker_host || !options->broker_port || !options->ca_pem || !options->certificate_pem || !options->private_key_pem || !options->trusted_clock || !options->read_property || !options->write_property) return LI_INVALID;
    if (!options->trusted_clock(options->driver_context)) return LI_CLOCK;
    if (options->ota_https_ca_pem && (!*options->ota_https_ca_pem || strnlen(options->ota_https_ca_pem,65537)>65536)) return LI_INVALID;
    if (psa_crypto_init() != PSA_SUCCESS) return LI_INVALID;
    if (options->ota_firmware_key) {
        li_ota_crypto_t crypto;
        if (!li_espidf_ota_crypto(&crypto) || li_ota_key_validate(&crypto, options->ota_firmware_key) != LI_OK) return LI_INVALID;
    }
    if (options->ota_policy) {
        li_ota_crypto_t crypto;
        if (!options->ota_firmware_key || !li_espidf_ota_crypto(&crypto) || li_ota_policy_validate(&crypto, options->ota_policy) != LI_OK
            || memcmp(options->ota_policy->key, options->ota_firmware_key, sizeof(*options->ota_firmware_key))) return LI_INVALID;
    }
    if (options->ota_https_ca_pem) {
        if (!options->ota_policy || !options->read_device_info) return LI_INVALID;
        mbedtls_x509_crt certificates; mbedtls_x509_crt_init(&certificates);
        bool valid = mbedtls_x509_crt_parse(&certificates, (const unsigned char *)options->ota_https_ca_pem, strlen(options->ota_https_ca_pem) + 1) == 0;
        for (const mbedtls_x509_crt *certificate = &certificates; valid && certificate; certificate = certificate->next)
            valid = mbedtls_x509_crt_get_ca_istrue(certificate) != 0;
        mbedtls_x509_crt_free(&certificates);
        if (!valid) return LI_INVALID;
    }
    li_espidf_t *adapter = calloc(1, sizeof(*adapter)); if (!adapter) return LI_CAPACITY;
    adapter->options = *options;
    if (!li_credential_window_open(&adapter->credential_window, options->private_key_pem, options->certificate_pem,
            options->ca_pem, options->core.device_id)
        || !credentials_current(adapter)) { free(adapter); return LI_INVALID; }
    if (li_espidf_storage_init_partition("journal") != LI_OK || nvs_open_from_partition("journal", "receipts", NVS_READWRITE, &adapter->journal) != ESP_OK) { free(adapter); return LI_STORAGE; }
    if (nvs_open_from_partition("journal","ota",NVS_READWRITE,&adapter->ota_storage)!=ESP_OK) { nvs_close(adapter->journal); free(adapter); return LI_STORAGE; }
    li_ota_crypto_t ota_crypto; li_error_t log_error=LI_INVALID;
    li_ota_log_ports_t log_ports={adapter,ota_log_read,ota_log_write,ota_clock_ms};
    if (li_espidf_ota_crypto(&ota_crypto)) adapter->ota_log=li_ota_log_open(&options->core,&ota_crypto,&log_ports,&log_error);
    if (!adapter->ota_log) { close_ota_log(adapter); nvs_close(adapter->journal); free(adapter); return log_error; }
    li_ports_t ports = {adapter, random_bytes, monotonic_ms, li_esp_sha256, storage_read, storage_write, publish, read_property, write_property, options->read_device_info ? read_device_info : NULL, options->read_observation ? read_observation : NULL}; li_error_t error;
    adapter->core = li_core_create(&options->core, &ports, &error);
    if (!adapter->core) { close_ota_log(adapter); nvs_close(adapter->journal); free(adapter); return error; }
    li_ota_device_ports_t device_ports={adapter,ota_running,ota_time};
    error=li_ota_device_attach(adapter->core,adapter->ota_log,&ota_crypto,options->ota_policy,&device_ports);
    if (error!=LI_OK) { li_core_destroy(adapter->core); close_ota_log(adapter); nvs_close(adapter->journal); free(adapter); return error; }
    li_ota_boot_observer_t observer={adapter,ota_observe};
    error=li_ota_device_set_boot_observer(adapter->core,&observer);
    if (error!=LI_OK) { li_core_destroy(adapter->core); close_ota_log(adapter); nvs_close(adapter->journal); free(adapter); return error; }
    if (options->ota_https_ca_pem) {
        li_ota_installer_t installer={adapter,ota_current,ota_stage,ota_activate,ota_restart};
        error=li_ota_device_set_installer(adapter->core,&installer);
        if (error!=LI_OK) { li_core_destroy(adapter->core); close_ota_log(adapter); nvs_close(adapter->journal); free(adapter); return error; }
    }
    adapter->queue = xQueueCreate(4, sizeof(work_t));
    if (!adapter->queue) { li_core_destroy(adapter->core); close_ota_log(adapter); nvs_close(adapter->journal); free(adapter); return LI_CAPACITY; }
    esp_mqtt_client_config_t config = {
        .broker.address = {.hostname = options->broker_host, .port = options->broker_port, .transport = MQTT_TRANSPORT_OVER_SSL},
        .broker.verification = {.certificate = options->ca_pem, .skip_cert_common_name_check = false},
        .credentials.client_id = options->core.device_id,
        .credentials.authentication = {.certificate = options->certificate_pem, .key = options->private_key_pem},
        .session = {.protocol_ver = MQTT_PROTOCOL_V_5, .keepalive = 10, .disable_clean_session = false},
        .network = {.disable_auto_reconnect = true, .reconnect_timeout_ms = 5000, .timeout_ms = 8000},
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
    vQueueDelete(adapter->queue); li_core_destroy(adapter->core); close_ota_log(adapter); nvs_close(adapter->journal); free(adapter); return LI_CAPACITY;
}
bool li_espidf_ready(const li_espidf_t *adapter) {
    return adapter && atomic_load(&adapter->ready)
        && li_credential_window_current(&adapter->credential_window, adapter->options.trusted_clock(adapter->options.driver_context));
}
static bool ota_time(void *context, int64_t *seconds) {
    li_espidf_t *adapter = context;
    if (!adapter->options.trusted_clock(adapter->options.driver_context)) return false;
    time_t now = time(NULL);
    if (now < 0 || !adapter->options.trusted_clock(adapter->options.driver_context)) return false;
    *seconds = (int64_t)now; return true;
}
li_error_t li_espidf_ota_preflight(li_espidf_t *adapter, const char *json, size_t length,
                                li_ota_candidate_t *result, const char **issue) {
    if (result) memset(result, 0, sizeof(*result));
    if (issue) *issue = "invalid_ota_policy";
    const li_ota_policy_t *policy = adapter ? adapter->options.ota_policy : NULL;
    if (!adapter || !policy || !policy->key || !adapter->options.ota_firmware_key || !adapter->options.read_device_info
        || memcmp(policy->key, adapter->options.ota_firmware_key, sizeof(*policy->key))) return LI_INVALID;
    if (!li_espidf_ready(adapter)) { if (issue) *issue = "ota_device_unavailable"; return LI_SESSION; }
    li_ota_crypto_t crypto;
    if (!li_espidf_ota_crypto(&crypto)) return LI_INVALID;
    li_ota_environment_t environment = {adapter, &adapter->options.core, read_device_info, ota_time};
    return li_ota_preflight(&crypto, policy, &environment, json, length, result, issue);
}
li_error_t li_espidf_event(li_espidf_t *adapter, const char *path, int64_t value) {
    if (!adapter || !path || strlen(path) >= LI_PATH_SIZE || !li_espidf_ready(adapter)) return LI_SESSION;
    work_t work = {.kind = WORK_EVENT, .generation = atomic_load(&adapter->generation), .value = value}; strcpy(work.path, path);
    return xQueueSend(adapter->queue, &work, 0) == pdTRUE ? LI_OK : LI_CAPACITY;
}
