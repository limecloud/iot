/* 运行生产worker的确定性边界；MQTT事件、队列与NVS为宿主夹具。
 * 密码库、证书日期及单调时间保持真实，不代表FreeRTOS或ESP TLS运行。 */
#include "../components/limeiot_espidf/src/espidf.c"
#include "ota_host_crypto.h"
#include "lamp.h"
#include <openssl/crypto.h>
#include <openssl/rand.h>
#include <assert.h>
#include <errno.h>
#include <limits.h>
#include <setjmp.h>

struct runtime_queue { unsigned count, head, capacity; size_t item_size; unsigned char *items; };
struct runtime_mqtt { esp_event_handler_t callback; void *context; };
static struct {
    li_espidf_t *adapter;
    void (*task)(void *);
    void *task_context;
    const char *mode;
    bool trusted, finishing;
    unsigned received, published, driven, reconnects, stops, stale_guards;
    int64_t reconnect_at[3];
} fixture;
static jmp_buf finish;
static void pause_ms(unsigned ms) {
    struct timespec delay = { ms / 1000, (long)(ms % 1000) * 1000000 };
    while (nanosleep(&delay, &delay) && errno == EINTR) {}
}
static char *read_pem(const char *directory, const char *name) {
    char path[PATH_MAX]; assert(snprintf(path, sizeof(path), "%s/%s", directory, name) < (int)sizeof(path));
    FILE *file = fopen(path, "rb"); assert(file);
    char *data = calloc(65537, 1); assert(data);
    size_t size = fread(data, 1, 65536, file); assert(size && !ferror(file) && fgetc(file) == EOF);
    assert(fclose(file) == 0); return data;
}
int sodium_memcmp(const void *a, const void *b, size_t size) { return CRYPTO_memcmp(a, b, size); }
bool li_esp_sha256(void *context, const uint8_t *data, size_t size, uint8_t digest[32]) { return hash(context, data, size, digest); }
bool li_espidf_ota_crypto(li_ota_crypto_t *out) { *out = (li_ota_crypto_t){ NULL, hash, verify }; return true; }
const esp_partition_t *esp_ota_get_running_partition(void) { return NULL; }
esp_err_t esp_partition_read(const esp_partition_t *p, size_t o, void *d, size_t s) { (void)p; (void)o; (void)d; (void)s; abort(); }
esp_err_t esp_image_verify(int m, const esp_partition_pos_t *p, esp_image_metadata_t *d) { (void)m; (void)p; (void)d; abort(); }
const esp_app_desc_t *esp_app_get_description(void) { static const esp_app_desc_t app = { "0.2.0" }; return &app; }
void esp_restart(void) { abort(); }
li_error_t li_espidf_ota_stage(const li_ota_candidate_t *c, const char *ca, const li_ota_transfer_guard_t *g, li_ota_transfer_result_t *r, const char **issue) {
    (void)c; (void)ca; (void)g; (void)r; (void)issue; abort();
}
bool li_esp_ota_activate(const li_ota_candidate_t *c, const li_ota_transfer_guard_t *g, char b[LI_OTA_LOG_ID_SIZE]) { (void)c; (void)g; (void)b; abort(); }
bool li_esp_ota_observe(const li_ota_log_view_t *v, li_ota_stage_t *s, li_ota_outcome_t *o) { (void)v; (void)s; (void)o; abort(); }
void esp_fill_random(void *data, size_t size) { assert(size <= INT_MAX && RAND_bytes(data, (int)size) == 1); }
int64_t esp_timer_get_time(void) {
    struct timespec now; assert(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
    return (int64_t)now.tv_sec * 1000000 + now.tv_nsec / 1000;
}
li_error_t li_espidf_storage_init_partition(const char *partition) { assert(!strcmp(partition, "journal")); return LI_OK; }
esp_err_t nvs_open_from_partition(const char *partition, const char *name, int mode, nvs_handle_t *handle) {
    assert(!strcmp(partition, "journal") && mode == NVS_READWRITE);
    if (!strcmp(name, "receipts")) *handle = 1;
    else { assert(!strcmp(name, "ota")); *handle = 2; }
    return ESP_OK;
}
esp_err_t nvs_get_blob(nvs_handle_t handle, const char *key, void *data, size_t *size) { (void)handle; (void)key; (void)data; (void)size; return ESP_ERR_NVS_NOT_FOUND; }
esp_err_t nvs_set_blob(nvs_handle_t h, const char *k, const void *d, size_t n) { (void)h; (void)k; (void)d; (void)n; abort(); }
esp_err_t nvs_commit(nvs_handle_t handle) { (void)handle; abort(); }
void nvs_close(nvs_handle_t handle) { assert(handle == 1 || handle == 2); }
static void emit(int id, esp_mqtt_event_t *event) { fixture.adapter->mqtt->callback(fixture.adapter->mqtt->context, "MQTT", id, event); }
static void connected(void) {
    esp_mqtt_event_t event = {0}; emit(MQTT_EVENT_CONNECTED, &event);
    char qos = 1; event = (esp_mqtt_event_t){ .msg_id = 7, .data = &qos, .data_len = 1 }; emit(MQTT_EVENT_SUBSCRIBED, &event);
}
esp_mqtt_client_handle_t esp_mqtt_client_init(const esp_mqtt_client_config_t *config) {
    assert(config->network.disable_auto_reconnect && config->network.reconnect_timeout_ms == 5000);
    assert(!config->broker.verification.skip_cert_common_name_check && config->broker.address.transport == MQTT_TRANSPORT_OVER_SSL);
    return calloc(1, sizeof(struct runtime_mqtt));
}
esp_err_t esp_mqtt5_client_set_connect_property(esp_mqtt_client_handle_t m, const esp_mqtt5_connection_property_config_t *p) { (void)m; assert(p->receive_maximum == 4); return ESP_OK; }
esp_err_t esp_mqtt_client_register_event(esp_mqtt_client_handle_t m, int id, esp_event_handler_t callback, void *context) { assert(id == ESP_EVENT_ANY_ID); m->callback = callback; m->context = context; return ESP_OK; }
esp_err_t esp_mqtt_client_start(esp_mqtt_client_handle_t m) { (void)m; return ESP_OK; }
esp_err_t esp_mqtt_client_reconnect(esp_mqtt_client_handle_t m) {
    (void)m; assert(fixture.reconnects < 3); fixture.reconnect_at[fixture.reconnects++] = esp_timer_get_time();
    if (!strcmp(fixture.mode, "reconnect") && fixture.reconnects < 3) return ESP_FAIL;
    connected();
    /* 新连接已建立，但旧工作代次尚未执行：三个生产提交端口仍须拒绝。 */
    assert(!ota_current(fixture.adapter));
    assert(!publish(fixture.adapter, "test", "{}", 2));
    assert(write_property(fixture.adapter, "light.power", (li_value_t){ .type = LI_BOOLEAN, .boolean = true }) == LI_NOT_APPLIED);
    fixture.stale_guards++; return ESP_OK;
}
esp_err_t esp_mqtt_client_disconnect(esp_mqtt_client_handle_t m) { (void)m; esp_mqtt_event_t event = {0}; emit(MQTT_EVENT_DISCONNECTED, &event); return ESP_OK; }
esp_err_t esp_mqtt_client_stop(esp_mqtt_client_handle_t m) {
    (void)m; fixture.stops++;
    return !strcmp(fixture.mode, "clock") && fixture.stops < 3 ? ESP_FAIL : ESP_OK;
}
esp_err_t esp_mqtt_client_destroy(esp_mqtt_client_handle_t m) { free(m); return ESP_OK; }
int esp_mqtt_client_subscribe(esp_mqtt_client_handle_t m, const char *topic, int qos) { (void)m; assert(strstr(topic, "/down/+") && qos == 1); return 7; }
int esp_mqtt_client_enqueue(esp_mqtt_client_handle_t m, const char *topic, const char *data, int length, int qos, int retain, bool store) {
    (void)m; assert(topic && data && length > 0 && qos == 1 && !retain && store); fixture.published++; return 8;
}
QueueHandle_t xQueueCreate(unsigned count, unsigned size) {
    QueueHandle_t queue = calloc(1, sizeof(*queue)); assert(queue);
    queue->capacity = count; queue->item_size = size; queue->items = calloc(count, size); assert(queue->items); return queue;
}
int xQueueSend(QueueHandle_t queue, const void *item, TickType_t ticks) {
    assert(!ticks); if (queue->count == queue->capacity) return pdFALSE;
    memcpy(queue->items + ((queue->head + queue->count) % queue->capacity) * queue->item_size, item, queue->item_size);
    queue->count++; return pdTRUE;
}
int xQueueReceive(QueueHandle_t queue, void *item, TickType_t ticks) {
    if (ticks && !fixture.finishing) {
        fixture.received++;
        if ((!strcmp(fixture.mode, "generation") && fixture.received == 3)
            || (!strcmp(fixture.mode, "clock") && fixture.received == 7)
            || (!strcmp(fixture.mode, "expiry") && fixture.received == 5)
            || (!strcmp(fixture.mode, "reconnect") && fixture.published)) longjmp(finish, 1);
        if (!strcmp(fixture.mode, "expiry") && fixture.received == 1) {
            int64_t limit = esp_timer_get_time() + 10000000;
            while (li_credential_window_current(&fixture.adapter->credential_window, fixture.trusted)) {
                assert(esp_timer_get_time() < limit); pause_ms(10);
            }
        }
    }
    if (queue->count) {
        memcpy(item, queue->items + queue->head * queue->item_size, queue->item_size);
        queue->head = (queue->head + 1) % queue->capacity; queue->count--; return pdTRUE;
    }
    if (ticks) pause_ms(ticks); return pdFALSE;
}
void vQueueDelete(QueueHandle_t queue) { free(queue->items); free(queue); }
int xTaskCreate(void (*task)(void *), const char *name, unsigned stack, void *context, unsigned priority, void *handle) {
    (void)name; (void)stack; (void)priority; (void)handle; fixture.task = task; fixture.task_context = context; return pdPASS;
}
static bool trusted(void *context) { (void)context; return fixture.trusted; }
static bool read_value(void *context, const char *path, li_value_t *value) {
    (void)context;
    if (!strcmp(path, "light.power")) *value = (li_value_t){ .type = LI_BOOLEAN };
    else if (!strcmp(path, "light.brightness")) *value = (li_value_t){ .type = LI_INTEGER };
    else return false;
    return true;
}
static li_apply_result_t write_value(void *context, const char *path, li_value_t value) { (void)context; (void)path; (void)value; fixture.driven++; return LI_APPLIED; }
int main(int argc, char **argv) {
    if (argc != 3 || (strcmp(argv[2], "generation") && strcmp(argv[2], "reconnect") && strcmp(argv[2], "clock") && strcmp(argv[2], "expiry"))) return 5;
    fixture.mode = argv[2]; fixture.trusted = true;
    char *ca = read_pem(argv[1], "ca.pem"), *certificate = read_pem(argv[1], "leaf.pem"), *key = read_pem(argv[1], "key.pem");
    li_espidf_options_t options = { .core = { .space_id = "space-demo", .device_id = "device-lamp", .model_revision = LI_LAMP_REVISION,
        .firmware_version = "0.2.0", .hardware_revision = "host-fixture", .properties = LI_LAMP_PROPERTIES, .property_count = LI_LAMP_PROPERTY_COUNT },
        .broker_host = "fixture", .broker_port = 8883, .ca_pem = ca, .certificate_pem = certificate, .private_key_pem = key,
        .trusted_clock = trusted, .read_property = read_value, .write_property = write_value };
    assert(li_espidf_start(&options, &fixture.adapter) == LI_OK && fixture.task);
    connected(); assert(fixture.adapter->queue->count == 1);
    unsigned original_generation = atomic_load(&fixture.adapter->generation);
    if (!strcmp(fixture.mode, "clock")) fixture.trusted = false;
    if (!strcmp(fixture.mode, "generation") || !strcmp(fixture.mode, "reconnect")) {
        assert(esp_mqtt_client_disconnect(fixture.adapter->mqtt) == ESP_OK);
    }
    if (!setjmp(finish)) fixture.task(fixture.task_context);
    fixture.finishing = true;
    bool locked = atomic_load(&fixture.adapter->credential_window.blocked);
    if (!strcmp(fixture.mode, "generation") || !strcmp(fixture.mode, "reconnect")) {
        assert(!locked && fixture.published == 1 && fixture.driven == 0 && fixture.stale_guards == 1);
        assert(fixture.adapter->executing_generation == atomic_load(&fixture.adapter->generation));
        assert(atomic_load(&fixture.adapter->generation) > original_generation && ota_current(fixture.adapter));
        if (!strcmp(fixture.mode, "reconnect")) {
            assert(fixture.reconnects == 3);
            for (unsigned i = 1; i < 3; i++) assert(fixture.reconnect_at[i] - fixture.reconnect_at[i - 1] >= 5000000);
        } else assert(fixture.reconnects == 1);
    } else {
        assert(locked && !fixture.published && !fixture.driven && !fixture.reconnects && !li_espidf_ready(fixture.adapter));
        assert(fixture.stops == (!strcmp(fixture.mode, "clock") ? 3u : 1u));
        assert(atomic_load(&fixture.adapter->generation) > original_generation);
        fixture.trusted = true; assert(!credentials_current(fixture.adapter) && !ota_current(fixture.adapter));
        connected(); char payload[] = "{}", topic[] = "limeiot/v1/space-demo/device-lamp/down/command";
        esp_mqtt_event_t event = { .data = payload, .data_len = 2, .total_data_len = 2, .topic = topic, .topic_len = (int)strlen(topic) };
        emit(MQTT_EVENT_DATA, &event);
        assert(fixture.adapter->queue->count == 0 && !fixture.adapter->incoming.payload);
        assert(!publish(fixture.adapter, "test", "{}", 2));
        assert(write_property(fixture.adapter, "light.power", (li_value_t){ .type = LI_BOOLEAN }) == LI_NOT_APPLIED);
        assert(li_espidf_event(fixture.adapter, "button.pressed", 1) == LI_SESSION);
    }
    printf("{\"mode\":\"%s\",\"published\":%u,\"driver_calls\":%u,\"reconnects\":%u,\"stops\":%u,\"stale_submission_rejections\":%u,\"locked\":%s,\"real_monotonic_clock\":true,\"production_worker\":true,\"transport_fixture\":true,\"hardware\":false}\n",
        fixture.mode, fixture.published, fixture.driven, fixture.reconnects, fixture.stops, fixture.stale_guards, locked ? "true" : "false");
    work_t work; while (xQueueReceive(fixture.adapter->queue, &work, 0) == pdTRUE) free(work.payload);
    reset_incoming(fixture.adapter); esp_mqtt_client_destroy(fixture.adapter->mqtt); vQueueDelete(fixture.adapter->queue);
    li_core_destroy(fixture.adapter->core); close_ota_log(fixture.adapter); nvs_close(fixture.adapter->journal); free(fixture.adapter);
    OPENSSL_cleanse(key, strlen(key)); free(key); free(certificate); free(ca); return 0;
}
