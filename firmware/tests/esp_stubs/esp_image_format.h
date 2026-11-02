#ifndef LI_TEST_ESP_IMAGE_FORMAT_H
#define LI_TEST_ESP_IMAGE_FORMAT_H
#include "esp_ota_ops.h"
#define ESP_IMAGE_VERIFY_SILENT 0
typedef struct { uint32_t offset, size; } esp_partition_pos_t;
typedef struct { uint32_t image_len; } esp_image_metadata_t;
esp_err_t esp_image_verify(int, const esp_partition_pos_t *, esp_image_metadata_t *);
#endif
