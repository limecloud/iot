/* ESP适配器宿主端口合同的受测子集；不模拟FreeRTOS调度、Flash或ESP TLS。 */
#ifndef LI_ESP_RUNTIME_API_H
#define LI_ESP_RUNTIME_API_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_NVS_NOT_FOUND 0x1102
#define ESP_EVENT_ANY_ID -1
#define ESP_LOGW(tag, ...) do { fprintf(stderr, "%s: ", tag); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } while (0)
typedef const char *esp_event_base_t;
typedef void (*esp_event_handler_t)(void *, esp_event_base_t, int32_t, void *);
#ifdef LI_ESP_NATIVE_INSTALL_HOST
#include "../esp_native_ota_stubs/esp_ota_ops.h"
#include "../esp_native_ota_stubs/esp_image_format.h"
#else
typedef struct { const char *version; } esp_app_desc_t;
const esp_app_desc_t *esp_app_get_description(void);
#endif
void esp_restart(void);
void esp_fill_random(void *, size_t);
int64_t esp_timer_get_time(void);
#ifndef LI_ESP_NATIVE_INSTALL_HOST
typedef struct {
    uint32_t address, size;
#ifdef LI_ESP_RECOVERY_HOST
    bool encrypted, readonly;
#endif
} esp_partition_t;
typedef struct { uint32_t offset, size; } esp_partition_pos_t;
typedef struct { uint32_t image_len; } esp_image_metadata_t;
#define ESP_IMAGE_VERIFY_SILENT 0
#endif
#ifdef LI_ESP_RECOVERY_HOST
#define ESP_PARTITION_TYPE_DATA 1
#define EFUSE_BLK_KEY0 4
#define ESP_EFUSE_KEY_PURPOSE_HMAC_UP 8
#define NVS_SEC_SCHEME_HMAC 1
typedef int esp_efuse_block_t;
typedef int esp_efuse_purpose_t;
typedef int hmac_key_id_t;
typedef struct { unsigned char eky[32], tky[32]; } nvs_sec_cfg_t;
typedef struct { int scheme_id; } nvs_sec_scheme_t;
esp_efuse_purpose_t esp_efuse_get_key_purpose(esp_efuse_block_t);
bool esp_efuse_get_key_dis_read(esp_efuse_block_t);
bool esp_efuse_get_key_dis_write(esp_efuse_block_t);
bool esp_efuse_get_keypurpose_dis_write(esp_efuse_block_t);
const esp_partition_t *esp_partition_find_first(int, int, const char *);
esp_err_t esp_hmac_calculate(hmac_key_id_t, const void *, size_t, void *);
nvs_sec_scheme_t *nvs_flash_get_default_security_scheme(void);
esp_err_t nvs_flash_read_security_cfg_v2(nvs_sec_scheme_t *, nvs_sec_cfg_t *);
esp_err_t nvs_flash_secure_init_partition(const char *, nvs_sec_cfg_t *);
esp_err_t nvs_flash_init_partition(const char *);
#endif
const esp_partition_t *esp_ota_get_running_partition(void);
#ifndef LI_ESP_NATIVE_INSTALL_HOST
esp_err_t esp_partition_read(const esp_partition_t *, size_t, void *, size_t);
#endif
esp_err_t esp_image_verify(int, const esp_partition_pos_t *, esp_image_metadata_t *);
typedef struct runtime_queue *QueueHandle_t;
typedef unsigned TickType_t;
#define pdTRUE 1
#define pdFALSE 0
#define pdPASS 1
#define pdMS_TO_TICKS(ms) (ms)
QueueHandle_t xQueueCreate(unsigned, unsigned);
int xQueueSend(QueueHandle_t, const void *, TickType_t);
int xQueueReceive(QueueHandle_t, void *, TickType_t);
void vQueueDelete(QueueHandle_t);
int xTaskCreate(void (*)(void *), const char *, unsigned, void *, unsigned, void *);
typedef unsigned nvs_handle_t;
#define NVS_READWRITE 1
esp_err_t nvs_open_from_partition(const char *, const char *, int, nvs_handle_t *);
esp_err_t nvs_get_blob(nvs_handle_t, const char *, void *, size_t *);
esp_err_t nvs_set_blob(nvs_handle_t, const char *, const void *, size_t);
esp_err_t nvs_commit(nvs_handle_t);
void nvs_close(nvs_handle_t);
typedef struct runtime_mqtt *esp_mqtt_client_handle_t;
#define MQTT_TRANSPORT_OVER_SSL 2
#define MQTT_PROTOCOL_V_5 5
typedef struct {
    struct {
        struct { const char *hostname; unsigned port; int transport; } address;
        struct { const char *certificate; bool skip_cert_common_name_check; } verification;
    } broker;
    struct { const char *client_id; struct { const char *certificate, *key; } authentication; } credentials;
    struct { int protocol_ver, keepalive; bool disable_clean_session; } session;
    struct { bool disable_auto_reconnect; int reconnect_timeout_ms, timeout_ms; } network;
    struct { int size, out_size; } buffer;
    struct { int limit; } outbox;
    struct { int stack_size, priority; } task;
} esp_mqtt_client_config_t;
enum { MQTT_EVENT_CONNECTED, MQTT_EVENT_DISCONNECTED, MQTT_EVENT_SUBSCRIBED, MQTT_EVENT_DATA };
typedef struct { int msg_id, data_len, total_data_len, current_data_offset, topic_len; char *topic, *data; bool retain; } esp_mqtt_event_t;
typedef esp_mqtt_event_t *esp_mqtt_event_handle_t;
typedef struct { uint32_t maximum_packet_size, receive_maximum, session_expiry_interval; } esp_mqtt5_connection_property_config_t;
esp_mqtt_client_handle_t esp_mqtt_client_init(const esp_mqtt_client_config_t *);
esp_err_t esp_mqtt5_client_set_connect_property(esp_mqtt_client_handle_t, const esp_mqtt5_connection_property_config_t *);
esp_err_t esp_mqtt_client_register_event(esp_mqtt_client_handle_t, int, esp_event_handler_t, void *);
esp_err_t esp_mqtt_client_start(esp_mqtt_client_handle_t);
esp_err_t esp_mqtt_client_stop(esp_mqtt_client_handle_t);
esp_err_t esp_mqtt_client_reconnect(esp_mqtt_client_handle_t);
esp_err_t esp_mqtt_client_disconnect(esp_mqtt_client_handle_t);
esp_err_t esp_mqtt_client_destroy(esp_mqtt_client_handle_t);
int esp_mqtt_client_subscribe(esp_mqtt_client_handle_t, const char *, int);
int esp_mqtt_client_enqueue(esp_mqtt_client_handle_t, const char *, const char *, int, int, int, bool);
#endif
