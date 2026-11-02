/* 编译实际SDK健康门禁，原生调用由显式故障夹具提供，不构成实机证据。 */
#include "limeiot_espidf.h"
#include "esp_ota_ops.h"
#include "esp_image_format.h"
#include <stdio.h>
#include <string.h>

static const char *mode;
static esp_partition_t running = {ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_MIN, 0x20000, 0x1e0000};
static const esp_partition_t other = {ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_MIN + 1, 0x200000, 0x1e0000};
static unsigned marks, reads, selections, images;
static esp_ota_img_states_t state = ESP_OTA_IMG_PENDING_VERIFY;
static bool is(const char *value) { return !strcmp(mode, value); }
const esp_partition_t *esp_ota_get_running_partition(void) { return is("missing-running") ? NULL : &running; }
const esp_partition_t *esp_ota_get_boot_partition(void) {
    selections++;
    if (is("missing-chosen")) return NULL;
    return is("selected-other") || (is("selection-changed-before-confirm") && selections > 1)
        || (is("selection-changed-after-confirm") && selections > 2) ? &other : &running;
}
esp_err_t esp_ota_get_state_partition(const esp_partition_t *partition, esp_ota_img_states_t *out) {
    reads++;
    if (partition != &running || is("missing-state") || (is("final-state-read-failed") && reads > 1)) return ESP_FAIL;
    *out = is("valid-final-lost") && reads > 1 ? ESP_OTA_IMG_UNDEFINED : state; return ESP_OK;
}
esp_err_t esp_image_verify(int kind, const esp_partition_pos_t *position, esp_image_metadata_t *metadata) {
    images++;
    if (kind != ESP_IMAGE_VERIFY_SILENT || position->offset != running.address || position->size != running.size || is("image-invalid")) return ESP_FAIL;
    metadata->image_len = is("image-empty") ? 0 : is("image-too-big") ? running.size + 1 : 1024; return ESP_OK;
}
esp_err_t esp_ota_mark_app_valid_cancel_rollback(void) {
    marks++;
    if (is("failed-confirm")) return ESP_FAIL;
    if (!is("confirm-not-valid")) state = ESP_OTA_IMG_VALID;
    return is("committed-error") ? ESP_FAIL : ESP_OK;
}
int main(int argc, char **argv) {
    if (argc != 2) return 5;
    mode = argv[1];
    if (is("valid") || is("valid-final-lost")) state = ESP_OTA_IMG_VALID;
    if (is("new")) state = ESP_OTA_IMG_NEW;
    if (is("invalid")) state = ESP_OTA_IMG_INVALID;
    if (is("aborted")) state = ESP_OTA_IMG_ABORTED;
    if (is("undefined")) state = ESP_OTA_IMG_UNDEFINED;
    if (is("factory")) running.subtype = 0;
    if (is("data")) running.type = 1;
    li_error_t result = li_espidf_confirm_running_image();
    if (is("repeat-confirm") && result == LI_OK) result = li_espidf_confirm_running_image();
    printf("{\"confirmed\":%s,\"mark_calls\":%u,\"image_checks\":%u,\"state_reads\":%u,\"native_valid\":%s,\"hardware\":false}\n",
        result == LI_OK ? "true" : "false", marks, images, reads, state == ESP_OTA_IMG_VALID ? "true" : "false");
    return result == LI_OK ? 0 : 2;
}
