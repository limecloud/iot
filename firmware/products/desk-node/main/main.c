#include "sdkconfig.h"
#include "limeiot_espidf.h"
#if CONFIG_LIMEIOT_ROLE_LAMP
#include "lamp.h"
#elif CONFIG_LIMEIOT_ROLE_ENVIRONMENT
#include "environment.h"
#include "limeiot_sht3x.h"
#include "driver/i2c_master.h"
#else
#include "button.h"
#endif
#include "driver/gpio.h"
#include "esp_event.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_ota_ops.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "led_strip.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "soc/soc_caps.h"
#include <errno.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#define IP_READY BIT0
static const char *TAG = "desk-node";
static EventGroupHandle_t network;
static atomic_bool application_healthy;
static atomic_bool image_confirmed;
static bool rollback_required;
static void verify_running_image(void *context) {
    (void)context;
    const int64_t deadline = esp_timer_get_time() + INT64_C(90000000);
    while (!rollback_required || esp_timer_get_time() < deadline) {
        if (atomic_load(&application_healthy)) {
            if (li_espidf_confirm_running_image() != LI_OK) abort();
            atomic_store(&image_confirmed, true);
            vTaskDelete(NULL);
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    ESP_LOGE(TAG, "Image did not become healthy within 90 seconds; OTA remains disabled");
    if (rollback_required) {
        ESP_ERROR_CHECK(esp_ota_mark_app_invalid_rollback_and_reboot());
        abort();
    }
    vTaskDelete(NULL);
}
static void begin_image_verification(void) {
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (!running || esp_ota_get_state_partition(running, &state) != ESP_OK
        || (state != ESP_OTA_IMG_VALID && state != ESP_OTA_IMG_PENDING_VERIFY)) abort();
    rollback_required = state == ESP_OTA_IMG_PENDING_VERIFY;
    /* 原生初始VALID也须经过产品健康门禁；等待时钟/配网不能绕过待确认镜像期限。 */
    if (xTaskCreate(verify_running_image, "image-health", 4096, NULL, 5, NULL) != pdPASS) abort();
}
typedef struct {
    char ssid[33], password[65], space[LI_ID_SIZE], device[LI_ID_SIZE], host[254], hardware[65];
    char ca[4096], certificate[4096], private_key[4096], ota_https_ca[4000], bootloader_version[32];
    uint16_t port;
    bool power, clock_bootstrapped, device_local_identity;
    int64_t brightness, clock_unix, clock_mono;
    led_strip_handle_t strip;
#if CONFIG_LIMEIOT_ROLE_ENVIRONMENT
    i2c_master_bus_handle_t sensor_bus;
    i2c_master_dev_handle_t sensor_device;
    li_sht3x_t sensor;
    atomic_bool sensor_healthy;
#endif
    li_espidf_t *iot;
    li_ota_key_t firmware_key;
    li_ota_trust_t *firmware_trust;
    bool has_firmware_key;
    bool has_ota_transport;
} product_t;
static bool read_device_info(void *context, li_device_info_t *info) {
    product_t *product = context;
    const esp_partition_t *running = esp_ota_get_running_partition();
    const esp_partition_t *next = esp_ota_get_next_update_partition(running);
    esp_bootloader_desc_t bootloader; esp_app_desc_t application; esp_ota_img_states_t state;
    if (!running || !next || next->address == running->address || esp_ota_get_bootloader_description(NULL, &bootloader) != ESP_OK || esp_ota_get_partition_description(running, &application) != ESP_OK) return false;
    int count = snprintf(product->bootloader_version, sizeof(product->bootloader_version), "0.0.%lu", (unsigned long)bootloader.version);
    if (count <= 0 || (size_t)count >= sizeof(product->bootloader_version)) return false;
    const esp_partition_t *chosen = esp_ota_get_boot_partition();
    bool pending = !atomic_load(&image_confirmed) || esp_ota_get_state_partition(running, &state) != ESP_OK
        || state != ESP_OTA_IMG_VALID || !chosen || chosen->address != running->address;
    *info = (li_device_info_t){
#if CONFIG_LIMEIOT_ROLE_LAMP
        .product_id = "desk-node-lamp",
#elif CONFIG_LIMEIOT_ROLE_ENVIRONMENT
        .product_id = "desk-node-environment",
#else
        .product_id = "desk-node-button",
#endif
        .architecture = "riscv32", .chip = "esp32c3", .board = CONFIG_LIMEIOT_BOARD_ID,
        .bootloader_version = product->bootloader_version,
        .security_epoch = application.secure_version, .ota_capacity_bytes = next->size,
        .external_power = true, .has_battery = false,
        .safe_to_update = !pending && product->has_ota_transport && product->firmware_trust,
        .pending_update = pending,
    };
    return true;
}
static bool trusted_clock(void *context) {
    product_t *product = context;
    int64_t mono = esp_timer_get_time()/1000000, wall = (int64_t)time(NULL);
    return product->clock_bootstrapped && mono >= product->clock_mono && llabs(wall - product->clock_unix - mono + product->clock_mono) <= 2;
}
static bool load_string(nvs_handle_t storage, const char *key, char *value, size_t capacity) { size_t size = capacity; return nvs_get_str(storage, key, value, &size) == ESP_OK && size > 1 && size <= capacity; }
static void load_configuration(product_t *product) {
    /* 身份区损坏时停止，不自动擦除设备凭据或所有权。 */
    if (li_espidf_storage_init_partition("nvs") != LI_OK) { ESP_LOGE(TAG, "identity storage is unavailable"); abort(); }
    nvs_handle_t storage; ESP_ERROR_CHECK(nvs_open("li-config", NVS_READONLY, &storage));
    bool valid = load_string(storage, "ssid", product->ssid, sizeof(product->ssid)) && load_string(storage, "wifi_password", product->password, sizeof(product->password)) && load_string(storage, "space_id", product->space, sizeof(product->space)) && load_string(storage, "device_id", product->device, sizeof(product->device)) && load_string(storage, "broker_host", product->host, sizeof(product->host)) && load_string(storage, "hardware_rev", product->hardware, sizeof(product->hardware)) && load_string(storage, "ca", product->ca, sizeof(product->ca)) && nvs_get_u16(storage, "broker_port", &product->port) == ESP_OK && product->port > 0 && strlen(product->password) >= 8;
    uint8_t identity_mode = 0, identity_version = 0;
    esp_err_t mode_error = nvs_get_u8(storage, "identity_mode", &identity_mode);
    esp_err_t identity_version_error = nvs_get_u8(storage, "identity_ver", &identity_version);
    if (mode_error == ESP_ERR_NVS_NOT_FOUND && identity_version_error == ESP_ERR_NVS_NOT_FOUND) {
        valid = valid && load_string(storage, "certificate", product->certificate, sizeof(product->certificate))
            && load_string(storage, "private_key", product->private_key, sizeof(product->private_key));
    } else {
        size_t ignored = 0;
        product->device_local_identity = mode_error == ESP_OK && identity_mode == 2
            && identity_version_error == ESP_OK && identity_version == 1
            && nvs_get_str(storage, "certificate", NULL, &ignored) == ESP_ERR_NVS_NOT_FOUND
            && nvs_get_str(storage, "private_key", NULL, &ignored) == ESP_ERR_NVS_NOT_FOUND;
#if !CONFIG_LIMEIOT_DEVICE_LOCAL_IDENTITY
        product->device_local_identity = false;
#endif
        valid = valid && product->device_local_identity;
    }
    uint8_t storage_version = 0, storage_key_id = 0;
    esp_err_t storage_marker = nvs_get_u8(storage, "storage_ver", &storage_version);
    esp_err_t storage_key_marker = nvs_get_u8(storage, "storage_key_id", &storage_key_id);
#if CONFIG_LIMEIOT_NVS_HMAC_PROTECTED
    valid = valid && storage_marker == ESP_OK && storage_version == 1 && storage_key_marker == ESP_OK
        && storage_key_id == CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID
        && li_espidf_storage_verify_identity(product->space, product->device) == LI_OK;
#else
    valid = valid && storage_marker == ESP_ERR_NVS_NOT_FOUND && storage_key_marker == ESP_ERR_NVS_NOT_FOUND;
#endif
    size_t key_size = 0, id_size = 0;
    esp_err_t key_error = nvs_get_str(storage, "ota_public_key", NULL, &key_size);
    esp_err_t id_error = nvs_get_str(storage, "ota_key_id", NULL, &id_size);
    if (key_error != ESP_ERR_NVS_NOT_FOUND || id_error != ESP_ERR_NVS_NOT_FOUND) {
        char public_key[45], key_id[72]; li_ota_crypto_t crypto;
        product->has_firmware_key = key_error == ESP_OK && id_error == ESP_OK
            && load_string(storage, "ota_public_key", public_key, sizeof(public_key))
            && load_string(storage, "ota_key_id", key_id, sizeof(key_id))
            && li_espidf_ota_crypto(&crypto)
            && li_ota_key_decode(&crypto, public_key, key_id, &product->firmware_key) == LI_OK;
        valid = valid && product->has_firmware_key;
    }
    size_t policy_size = 0; uint8_t policy_version = 0;
    esp_err_t policy_error = nvs_get_blob(storage, "ota_policy", NULL, &policy_size);
    esp_err_t version_error = nvs_get_u8(storage, "ota_policy_ver", &policy_version);
    if (policy_error != ESP_ERR_NVS_NOT_FOUND || version_error != ESP_ERR_NVS_NOT_FOUND) {
        /* 标记/策略缺一、未知版本、坏JSON或与独立公钥不符均停止，不能回退到宽松策略。 */
        li_ota_crypto_t crypto; char *raw = NULL;
        bool configured = policy_error == ESP_OK && version_error == ESP_OK && policy_version == 1
            && policy_size > 0 && policy_size <= LI_MAX_PACKET && product->has_firmware_key;
        if (configured) {
            raw = malloc(policy_size);
            configured = raw && nvs_get_blob(storage, "ota_policy", raw, &policy_size) == ESP_OK
                && li_espidf_ota_crypto(&crypto)
                && li_ota_trust_decode(&crypto, raw, policy_size, &product->firmware_trust) == LI_OK;
        }
        free(raw);
        const li_ota_policy_t *policy = li_ota_trust_policy(product->firmware_trust);
        configured = configured && policy && !memcmp(policy->key, &product->firmware_key, sizeof(product->firmware_key));
        valid = valid && configured;
    }
    size_t ca_size = 0; uint8_t ca_version = 0;
    esp_err_t ca_error = nvs_get_str(storage, "ota_https_ca", NULL, &ca_size);
    esp_err_t ca_version_error = nvs_get_u8(storage, "ota_ca_ver", &ca_version);
    if (ca_error != ESP_ERR_NVS_NOT_FOUND || ca_version_error != ESP_ERR_NVS_NOT_FOUND) {
        product->has_ota_transport = ca_error == ESP_OK && ca_version_error == ESP_OK && ca_version == 1
            && product->firmware_trust && load_string(storage, "ota_https_ca", product->ota_https_ca, sizeof(product->ota_https_ca));
        valid = valid && product->has_ota_transport;
    }
    nvs_close(storage);
    if (!valid) { ESP_LOGE(TAG, "commissioning configuration is missing or invalid"); abort(); }
}
static void bootstrap_clock(product_t *product) {
#if CONFIG_LIMEIOT_DEVELOPMENT_USB_CLOCK
    ESP_LOGW(TAG, "Development clock: enter time <Unix seconds> through the physical USB console");
    char line[80];
    for (;;) {
        if (!fgets(line, sizeof(line), stdin)) { clearerr(stdin); vTaskDelay(pdMS_TO_TICKS(100)); continue; }
        if (strncmp(line, "time ", 5) != 0) continue;
        char *end; errno = 0; long long value = strtoll(line + 5, &end, 10);
        while (*end == '\r' || *end == '\n' || *end == ' ') end++;
        if (errno || *end || value < INT64_C(1577836800) || value > INT64_C(4102444800)) continue;
        struct timeval now = {.tv_sec = (time_t)value, .tv_usec = 0};
        if (settimeofday(&now, NULL) != 0) continue;
        product->clock_unix = value; product->clock_mono = esp_timer_get_time()/1000000; product->clock_bootstrapped = true;
        return;
    }
#else
    (void)product;
    ESP_LOGE(TAG, "A protected trusted-clock adapter is required for this product"); abort();
#endif
}
static bool read_property(void *context, const char *path, li_value_t *value) {
    product_t *product = context; memset(value, 0, sizeof(*value));
    if (strcmp(path, "light.power") == 0) { value->type = LI_BOOLEAN; value->boolean = product->power; return true; }
    if (strcmp(path, "light.brightness") == 0) { value->type = LI_INTEGER; value->integer = product->brightness; return true; }
    return false;
}
#if CONFIG_LIMEIOT_ROLE_ENVIRONMENT
static bool sensor_write(void *context, const uint8_t *data, size_t size) {
    product_t *product = context;
    return i2c_master_transmit(product->sensor_device, data, size, 100) == ESP_OK;
}
static bool sensor_read(void *context, uint8_t *data, size_t size) {
    product_t *product = context;
    return i2c_master_receive(product->sensor_device, data, size, 100) == ESP_OK;
}
static bool sensor_wait(void *context, uint32_t milliseconds) {
    (void)context;
    /* 向上取整并多等一个tick，保证不早于芯片最大转换时间。 */
    vTaskDelay(pdMS_TO_TICKS(milliseconds + portTICK_PERIOD_MS - 1) + 1); return true;
}
static int64_t sensor_clock(void *context) { (void)context; return esp_timer_get_time()/1000; }
static bool read_observation(void *context, const char *path, li_observation_t *value) {
    product_t *product = context; li_sht3x_sample_t sample;
    if (strcmp(path, "environment.temperature") && strcmp(path, "environment.humidity")) return false;
    bool valid = li_sht3x_read(&product->sensor, &sample);
    atomic_store(&product->sensor_healthy, valid);
    if (!valid) return false;
    *value = (li_observation_t){.value = {.type = LI_INTEGER, .integer = !strcmp(path, "environment.temperature") ? sample.temperature : sample.humidity}, .sampled_mono_ms = sample.sampled_mono_ms};
    return true;
}
#endif
static li_apply_result_t write_property(void *context, const char *path, li_value_t value) {
    product_t *product = context;
#if CONFIG_LIMEIOT_ROLE_LAMP
    bool power = product->power; int64_t brightness = product->brightness;
    if (strcmp(path, "light.power") == 0) power = value.boolean;
    else if (strcmp(path, "light.brightness") == 0) brightness = value.integer;
    else return LI_NOT_APPLIED;
    /* 样机亮度上限为驱动满量程的20%，模型的100%表示该产品允许的最大亮度。 */
    unsigned red = power ? (unsigned)(brightness * 51 / 100) : 0;
    unsigned green = power ? (unsigned)(brightness * 32 / 100) : 0;
    unsigned blue = power ? (unsigned)(brightness * 13 / 100) : 0;
    for (unsigned pixel = 0; pixel < CONFIG_LIMEIOT_LED_COUNT; pixel++) if (led_strip_set_pixel(product->strip, pixel, red, green, blue) != ESP_OK) return LI_NOT_APPLIED;
    if (led_strip_refresh(product->strip) != ESP_OK) return LI_EXECUTION_UNKNOWN;
    product->power = power; product->brightness = brightness; return LI_APPLIED;
#else
    (void)product; (void)path; (void)value; return LI_NOT_APPLIED;
#endif
}
static bool permitted_gpio(int gpio) { return GPIO_IS_VALID_GPIO(gpio) && gpio != 2 && gpio != 8 && gpio != 9 && gpio != 18 && gpio != 19; }
static void initialize_driver(product_t *product) {
#if CONFIG_LIMEIOT_ROLE_LAMP
    if (!permitted_gpio(CONFIG_LIMEIOT_LED_GPIO)) abort();
    led_strip_config_t strip = {.strip_gpio_num = CONFIG_LIMEIOT_LED_GPIO, .max_leds = CONFIG_LIMEIOT_LED_COUNT, .led_model = LED_MODEL_WS2812, .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB};
    led_strip_rmt_config_t rmt = {.clk_src = RMT_CLK_SRC_DEFAULT, .resolution_hz = 10000000, .mem_block_symbols = SOC_RMT_MEM_WORDS_PER_CHANNEL, .flags.with_dma = false};
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&strip, &rmt, &product->strip));
    ESP_ERROR_CHECK(led_strip_clear(product->strip)); product->brightness = 20;
#elif CONFIG_LIMEIOT_ROLE_BUTTON
    (void)product;
    if (!permitted_gpio(CONFIG_LIMEIOT_BUTTON_GPIO)) abort();
    gpio_config_t button = {.pin_bit_mask = UINT64_C(1) << CONFIG_LIMEIOT_BUTTON_GPIO, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE, .pull_down_en = GPIO_PULLDOWN_DISABLE, .intr_type = GPIO_INTR_DISABLE};
    ESP_ERROR_CHECK(gpio_config(&button));
#else
    if (!permitted_gpio(CONFIG_LIMEIOT_SHT30_SDA_GPIO) || !permitted_gpio(CONFIG_LIMEIOT_SHT30_SCL_GPIO)
        || CONFIG_LIMEIOT_SHT30_SDA_GPIO == CONFIG_LIMEIOT_SHT30_SCL_GPIO) abort();
    i2c_master_bus_config_t bus = {.i2c_port = -1, .sda_io_num = CONFIG_LIMEIOT_SHT30_SDA_GPIO,
        .scl_io_num = CONFIG_LIMEIOT_SHT30_SCL_GPIO, .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7};
    ESP_ERROR_CHECK(i2c_new_master_bus(&bus, &product->sensor_bus));
    i2c_device_config_t device = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = CONFIG_LIMEIOT_SHT30_ADDRESS, .scl_speed_hz = 100000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(product->sensor_bus, &device, &product->sensor_device));
    li_sht3x_ports_t ports = {product, sensor_write, sensor_read, sensor_wait, sensor_clock};
    if (!li_sht3x_init(&product->sensor, &ports)) abort();
#endif
}
static void wifi_event(void *context, esp_event_base_t base, int32_t event, void *data) {
    (void)context; (void)data;
    if (base == IP_EVENT && event == IP_EVENT_STA_GOT_IP) xEventGroupSetBits(network, IP_READY);
    else if (base == WIFI_EVENT && event == WIFI_EVENT_STA_DISCONNECTED) xEventGroupClearBits(network, IP_READY);
}
static void wifi_retry(void *context) {
    (void)context;
    for (;;) {
        if (!(xEventGroupGetBits(network) & IP_READY)) (void)esp_wifi_connect();
        vTaskDelay(pdMS_TO_TICKS(5000 + esp_random()%1000));
    }
}
static void connect_wifi(product_t *product) {
    network = xEventGroupCreate(); if (!network) abort();
    ESP_ERROR_CHECK(esp_netif_init()); ESP_ERROR_CHECK(esp_event_loop_create_default());
    if (!esp_netif_create_default_wifi_sta()) abort();
    wifi_init_config_t initialize = WIFI_INIT_CONFIG_DEFAULT(); ESP_ERROR_CHECK(esp_wifi_init(&initialize));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL)); ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    wifi_config_t config = {0}; memcpy(config.sta.ssid, product->ssid, strlen(product->ssid)); memcpy(config.sta.password, product->password, strlen(product->password));
    config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA)); ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &config)); memset(&config, 0, sizeof(config));
    ESP_ERROR_CHECK(esp_wifi_start());
    if (xTaskCreate(wifi_retry, "wifi-retry", 3072, NULL, 3, NULL) != pdPASS) abort();
    (void)xEventGroupWaitBits(network, IP_READY, pdFALSE, pdTRUE, portMAX_DELAY);
}
static bool usb_line(char *line, size_t capacity) {
    if (!fgets(line, capacity, stdin)) { clearerr(stdin); return false; }
    size_t length = strlen(line);
    if (!length || line[length - 1] != '\n') {
        int c; while ((c = getchar()) != '\n' && c != EOF) { }
        line[0] = 0; return false;
    }
    while (length && (line[length - 1] == '\r' || line[length - 1] == '\n')) line[--length] = 0;
    return true;
}
static bool usb_pem(char *certificate, size_t capacity, const char *footer) {
    memset(certificate, 0, capacity);
    char line[256]; size_t used = 0;
    while (usb_line(line, sizeof(line))) {
        size_t length = strlen(line);
        if (used + length + 2 > capacity) return false;
        memcpy(certificate + used, line, length); used += length; certificate[used++] = '\n';
        if (!strcmp(line, footer)) return true;
    }
    return false;
}
static void initialize_device_identity(product_t *product) {
    if (!product->device_local_identity) return;
    li_espidf_identity_options_t options = {product->space, product->device, product->ca, product, trusted_clock};
    li_espidf_identity_t *identity = NULL;
    if (li_espidf_identity_open(&options, &identity) != LI_OK) abort();
    li_error_t status = li_espidf_identity_credentials(identity, product->certificate, sizeof(product->certificate), product->private_key, sizeof(product->private_key));
#if CONFIG_LIMEIOT_DEVELOPMENT_IDENTITY_MAINTENANCE
    bool maintenance = true;
#else
    bool maintenance = false;
#endif
    if (status != LI_OK && status != LI_CONFLICT && !maintenance) abort();
    if (status == LI_CONFLICT) ESP_LOGW(TAG, "Local identity setup: identity csr; identity import followed by the public certificate");
    if (maintenance) ESP_LOGW(TAG, "Identity maintenance: status; rotate ID; recover ID; recover-pending ID + original CSR; rotate-import ID; proof ID CHALLENGE; continue (prefix each with identity)");
    char *certificate = calloc(1, LI_IDENTITY_CERT_PEM_SIZE);
    char *csr = calloc(1, LI_IDENTITY_CSR_PEM_SIZE);
    if (!certificate || !csr) abort();
    while (status != LI_OK || maintenance) {
        char line[256], fingerprint[LI_IDENTITY_FINGERPRINT_SIZE];
        if (!usb_line(line, sizeof(line))) { vTaskDelay(pdMS_TO_TICKS(100)); continue; }
        if (maintenance && !strcmp(line, "identity continue")) {
            status = li_espidf_identity_credentials(identity, product->certificate, sizeof(product->certificate), product->private_key, sizeof(product->private_key));
            if (status == LI_OK) break;
            ESP_LOGW(TAG, "Valid credentials required to continue");
        } else if (!strcmp(line, "identity status")) {
            li_espidf_identity_status_t current;
            if (li_espidf_identity_status(identity, &current) != LI_OK) abort();
            printf("{\"state\":%u,\"generation\":%" PRIu32 ",\"rotation_id\":\"%s\",\"certificate_fingerprint\":\"%s\",\"public_key_fingerprint\":\"%s\",\"pending_public_key_fingerprint\":\"%s\",\"certificate_expired\":%s,\"recovery_origin\":%u}\n",
                current.state, current.generation, current.rotation_id, current.certificate_fingerprint, current.public_key_fingerprint, current.pending_public_key_fingerprint, current.certificate_expired ? "true" : "false", current.recovery_origin); fflush(stdout);
        } else if (maintenance && !strncmp(line, "identity proof ", 15)) {
            char *challenge = strchr(line + 15, ' '), proof[LI_IDENTITY_PROOF_SIZE];
            if (!challenge) { ESP_LOGW(TAG, "Rotation ID and challenge required"); continue; }
            *challenge++ = 0;
            li_error_t result = li_espidf_identity_rotation_proof(identity, line + 15, challenge, proof);
            if (result == LI_STORAGE || result == LI_CLOCK) abort();
            if (result == LI_OK) { printf("%s\n", proof); fflush(stdout); }
            else ESP_LOGW(TAG, "Activation proof rejected");
        } else if (maintenance && (!strncmp(line, "identity recover ", 17) || !strncmp(line, "identity recover-pending ", 25))) {
            bool pending = !strncmp(line, "identity recover-pending ", 25);
            bool complete = !pending || usb_pem(certificate, LI_IDENTITY_CSR_PEM_SIZE, "-----END CERTIFICATE REQUEST-----");
            li_error_t result = !complete ? LI_INVALID : li_espidf_identity_recover_request(identity,
                line + (pending ? 25 : 17), pending ? certificate : NULL, csr, LI_IDENTITY_CSR_PEM_SIZE, fingerprint);
            memset(certificate, 0, LI_IDENTITY_CERT_PEM_SIZE);
            if (result == LI_STORAGE || result == LI_CLOCK) abort();
            if (result != LI_OK) { ESP_LOGW(TAG, "Expired identity recovery rejected: %s", li_error_code(result)); continue; }
            printf("%s\n%s", fingerprint, csr); fflush(stdout);
        } else if (!strcmp(line, "identity csr") || (maintenance && !strncmp(line, "identity rotate ", 16))) {
            bool rotate = strncmp(line, "identity csr", 12) != 0;
            li_error_t result = rotate ? li_espidf_identity_rotate_request(identity, line + 16, csr, LI_IDENTITY_CSR_PEM_SIZE, fingerprint)
                : li_espidf_identity_request(identity, csr, LI_IDENTITY_CSR_PEM_SIZE, fingerprint);
            if (result == LI_STORAGE || result == LI_CLOCK) abort();
            if (result != LI_OK) { ESP_LOGW(TAG, "Identity request rejected: %s", li_error_code(result)); continue; }
            printf("%s\n%s", fingerprint, csr); fflush(stdout);
        } else if (!strcmp(line, "identity import") || (maintenance && !strncmp(line, "identity rotate-import ", 23))) {
            bool rotate = strncmp(line, "identity import", 15) != 0;
            bool complete = usb_pem(certificate, LI_IDENTITY_CERT_PEM_SIZE, "-----END CERTIFICATE-----");
            li_error_t result = !complete ? LI_INVALID : rotate ? li_espidf_identity_rotate_import(identity, line + 23, certificate)
                : li_espidf_identity_import(identity, certificate);
            memset(certificate, 0, LI_IDENTITY_CERT_PEM_SIZE);
            if (result == LI_STORAGE || result == LI_CLOCK) { ESP_LOGE(TAG, "Identity setup requires reopening: %s", li_error_code(result)); abort(); }
            if (result != LI_OK) { ESP_LOGW(TAG, "Identity certificate rejected"); continue; }
            status = li_espidf_identity_credentials(identity, product->certificate, sizeof(product->certificate), product->private_key, sizeof(product->private_key));
            if (status != LI_OK) abort();
        }
    }
    free(certificate); free(csr); li_espidf_identity_close(identity);
}
void app_main(void) {
    begin_image_verification();
    product_t *product = calloc(1, sizeof(*product)); if (!product) abort();
    initialize_driver(product); load_configuration(product); bootstrap_clock(product); connect_wifi(product); initialize_device_identity(product);
#if CONFIG_LIMEIOT_ROLE_LAMP
    li_config_t model = {product->space, product->device, LI_LAMP_REVISION, esp_app_get_description()->version, product->hardware, LI_LAMP_PROPERTIES, LI_LAMP_PROPERTY_COUNT, NULL, 0, "driver.applied"};
#elif CONFIG_LIMEIOT_ROLE_ENVIRONMENT
    li_config_t model = {product->space, product->device, LI_ENVIRONMENT_REVISION, esp_app_get_description()->version, product->hardware, LI_ENVIRONMENT_PROPERTIES, LI_ENVIRONMENT_PROPERTY_COUNT, NULL, 0, "sensor.readback"};
#else
    li_config_t model = {product->space, product->device, LI_BUTTON_REVISION, esp_app_get_description()->version, product->hardware, NULL, 0, LI_BUTTON_EVENTS, LI_BUTTON_EVENT_COUNT, "driver.applied"};
#endif
    li_espidf_options_t options = {model, product->host, product->ca, product->certificate, product->private_key, product->port, product, trusted_clock, read_property, write_property, read_device_info, product->has_firmware_key ? &product->firmware_key : NULL, li_ota_trust_policy(product->firmware_trust), product->has_ota_transport ? product->ota_https_ca : NULL,
#if CONFIG_LIMEIOT_ROLE_ENVIRONMENT
        read_observation
#else
        NULL
#endif
    };
    li_error_t error = li_espidf_start(&options, &product->iot);
    if (error != LI_OK) { ESP_LOGE(TAG, "IoT Core start failed: %s", li_error_code(error)); abort(); }
#if CONFIG_LIMEIOT_ROLE_BUTTON
    int raw = 1, stable = 1; int64_t changed = esp_timer_get_time();
#endif
    for (;;) {
        bool healthy = li_espidf_ready(product->iot) && trusted_clock(product);
#if CONFIG_LIMEIOT_ROLE_ENVIRONMENT
        healthy = healthy && atomic_load(&product->sensor_healthy);
#endif
        atomic_store(&application_healthy, healthy);
#if CONFIG_LIMEIOT_ROLE_BUTTON
        int current = gpio_get_level(CONFIG_LIMEIOT_BUTTON_GPIO); int64_t now = esp_timer_get_time();
        if (current != raw) { raw = current; changed = now; }
        if (stable != raw && now - changed >= 40000) { stable = raw; if (stable == 0 && li_espidf_ready(product->iot)) (void)li_espidf_event(product->iot, "button.pressed", 1); }
#endif
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
