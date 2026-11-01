#include "sdkconfig.h"
#include "limeiot_espidf.h"
#if CONFIG_LIMEIOT_ROLE_LAMP
#include "lamp.h"
#else
#include "button.h"
#endif
#include "driver/gpio.h"
#include "esp_event.h"
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
static void verify_pending_image(void *context) {
    (void)context;
    const int64_t deadline = esp_timer_get_time() + INT64_C(90000000);
    while (esp_timer_get_time() < deadline) {
        if (atomic_load(&application_healthy)) {
            ESP_ERROR_CHECK(esp_ota_mark_app_valid_cancel_rollback());
            vTaskDelete(NULL);
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    ESP_LOGE(TAG, "Pending image did not become healthy within 90 seconds");
    ESP_ERROR_CHECK(esp_ota_mark_app_invalid_rollback_and_reboot());
    abort();
}
static void begin_image_verification(void) {
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) {
        /* 从启动开始计时，配网或等待开发时钟不能绕过回滚期限。 */
        if (xTaskCreate(verify_pending_image, "image-health", 3072, NULL, 5, NULL) != pdPASS) abort();
    }
}
typedef struct {
    char ssid[33], password[65], space[LI_ID_SIZE], device[LI_ID_SIZE], host[254], hardware[65];
    char ca[4096], certificate[4096], private_key[4096];
    uint16_t port;
    bool power, clock_bootstrapped;
    int64_t brightness, clock_unix, clock_mono;
    led_strip_handle_t strip;
    li_espidf_t *iot;
} product_t;
static bool trusted_clock(void *context) {
    product_t *product = context;
    int64_t mono = esp_timer_get_time()/1000000, wall = (int64_t)time(NULL);
    return product->clock_bootstrapped && mono >= product->clock_mono && llabs(wall - product->clock_unix - mono + product->clock_mono) <= 2;
}
static bool load_string(nvs_handle_t storage, const char *key, char *value, size_t capacity) { size_t size = capacity; return nvs_get_str(storage, key, value, &size) == ESP_OK && size > 1 && size <= capacity; }
static void load_configuration(product_t *product) {
    /* 身份区损坏时停止，不自动擦除设备凭据或所有权。 */
    ESP_ERROR_CHECK(nvs_flash_init());
    nvs_handle_t storage; ESP_ERROR_CHECK(nvs_open("li-config", NVS_READONLY, &storage));
    bool valid = load_string(storage, "ssid", product->ssid, sizeof(product->ssid)) && load_string(storage, "wifi_password", product->password, sizeof(product->password)) && load_string(storage, "space_id", product->space, sizeof(product->space)) && load_string(storage, "device_id", product->device, sizeof(product->device)) && load_string(storage, "broker_host", product->host, sizeof(product->host)) && load_string(storage, "hardware_rev", product->hardware, sizeof(product->hardware)) && load_string(storage, "ca", product->ca, sizeof(product->ca)) && load_string(storage, "certificate", product->certificate, sizeof(product->certificate)) && load_string(storage, "private_key", product->private_key, sizeof(product->private_key)) && nvs_get_u16(storage, "broker_port", &product->port) == ESP_OK && product->port > 0 && strlen(product->password) >= 8;
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
#else
    (void)product;
    if (!permitted_gpio(CONFIG_LIMEIOT_BUTTON_GPIO)) abort();
    gpio_config_t button = {.pin_bit_mask = UINT64_C(1) << CONFIG_LIMEIOT_BUTTON_GPIO, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE, .pull_down_en = GPIO_PULLDOWN_DISABLE, .intr_type = GPIO_INTR_DISABLE};
    ESP_ERROR_CHECK(gpio_config(&button));
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
void app_main(void) {
    begin_image_verification();
    product_t *product = calloc(1, sizeof(*product)); if (!product) abort();
    initialize_driver(product); load_configuration(product); bootstrap_clock(product); connect_wifi(product);
#if CONFIG_LIMEIOT_ROLE_LAMP
    li_config_t model = {product->space, product->device, LI_LAMP_REVISION, "0.1.0", product->hardware, LI_LAMP_PROPERTIES, LI_LAMP_PROPERTY_COUNT, NULL, 0, "driver.applied"};
#else
    li_config_t model = {product->space, product->device, LI_BUTTON_REVISION, "0.1.0", product->hardware, NULL, 0, LI_BUTTON_EVENTS, LI_BUTTON_EVENT_COUNT, "driver.applied"};
#endif
    li_espidf_options_t options = {model, product->host, product->ca, product->certificate, product->private_key, product->port, product, trusted_clock, read_property, write_property};
    li_error_t error = li_espidf_start(&options, &product->iot);
    if (error != LI_OK) { ESP_LOGE(TAG, "IoT Core start failed: %s", li_error_code(error)); abort(); }
#if CONFIG_LIMEIOT_ROLE_BUTTON
    int raw = 1, stable = 1; int64_t changed = esp_timer_get_time();
#endif
    for (;;) {
        if (li_espidf_ready(product->iot)) atomic_store(&application_healthy, true);
#if CONFIG_LIMEIOT_ROLE_BUTTON
        int current = gpio_get_level(CONFIG_LIMEIOT_BUTTON_GPIO); int64_t now = esp_timer_get_time();
        if (current != raw) { raw = current; changed = now; }
        if (stable != raw && now - changed >= 40000) { stable = raw; if (stable == 0 && li_espidf_ready(product->iot)) (void)li_espidf_event(product->iot, "button.pressed", 1); }
#endif
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
