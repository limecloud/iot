/* 只确认本次实际运行且已通过产品健康检查的镜像，不补写未知启动元数据。 */
#include "limeiot_espidf.h"
#include "esp_ota_ops.h"
#include "esp_image_format.h"

li_error_t li_espidf_confirm_running_image(void) {
    const esp_partition_t *running = esp_ota_get_running_partition();
    const esp_partition_t *chosen = esp_ota_get_boot_partition();
    esp_ota_img_states_t state;
    if (!running || !chosen || running->type != ESP_PARTITION_TYPE_APP
        || running->subtype < ESP_PARTITION_SUBTYPE_APP_OTA_MIN || running->subtype >= ESP_PARTITION_SUBTYPE_APP_OTA_MAX
        || chosen->address != running->address) return LI_INVALID;
    if (esp_ota_get_state_partition(running, &state) != ESP_OK
        || (state != ESP_OTA_IMG_PENDING_VERIFY && state != ESP_OTA_IMG_VALID)) return LI_DRIVER;
    esp_partition_pos_t position = {.offset = running->address, .size = running->size};
    esp_image_metadata_t metadata = {0};
    if (esp_image_verify(ESP_IMAGE_VERIFY_SILENT, &position, &metadata) != ESP_OK
        || !metadata.image_len || metadata.image_len > running->size) return LI_DRIVER;
    chosen = esp_ota_get_boot_partition();
    if (!chosen || chosen->address != running->address) return LI_DRIVER;
    if (state == ESP_OTA_IMG_PENDING_VERIFY && esp_ota_mark_app_valid_cancel_rollback() != ESP_OK) return LI_DRIVER;
    chosen = esp_ota_get_boot_partition();
    if (!chosen || chosen->address != running->address || esp_ota_get_state_partition(running, &state) != ESP_OK
        || state != ESP_OTA_IMG_VALID) return LI_DRIVER;
    return LI_OK;
}
