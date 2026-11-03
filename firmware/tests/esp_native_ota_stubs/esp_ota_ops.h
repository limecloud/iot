/* SDK提供真实app描述/otadata布局；分区及OTA调用是显式文件端口。 */
#pragma once
#include "esp_app_desc.h"
#include "esp_flash_partitions.h"
#define ESP_PARTITION_TYPE_APP 0
#define ESP_PARTITION_TYPE_DATA 1
#define ESP_PARTITION_SUBTYPE_APP_OTA_MIN 0x10
#define ESP_PARTITION_SUBTYPE_DATA_OTA 0
typedef struct { unsigned type, subtype; uint32_t address, size, erase_size; } esp_partition_t;
typedef unsigned esp_ota_handle_t;
const esp_partition_t *esp_ota_get_running_partition(void);
const esp_partition_t *esp_ota_get_next_update_partition(const esp_partition_t *);
const esp_partition_t *esp_ota_get_boot_partition(void);
const esp_partition_t *esp_partition_find_first(unsigned, unsigned, const char *);
unsigned esp_ota_get_app_partition_count(void);
esp_err_t esp_partition_read(const esp_partition_t *, uint32_t, void *, size_t);
esp_err_t esp_ota_begin(const esp_partition_t *, size_t, esp_ota_handle_t *);
esp_err_t esp_ota_write(esp_ota_handle_t, const void *, size_t);
esp_err_t esp_ota_end(esp_ota_handle_t);
esp_err_t esp_ota_abort(esp_ota_handle_t);
esp_err_t esp_ota_set_boot_partition(const esp_partition_t *);
esp_err_t esp_ota_get_partition_description(const esp_partition_t *, esp_app_desc_t *);
esp_err_t esp_ota_get_state_partition(const esp_partition_t *, esp_ota_img_states_t *);
