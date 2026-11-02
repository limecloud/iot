#ifndef LI_ESP_OTA_TRANSFER_INTERNAL_H
#define LI_ESP_OTA_TRANSFER_INTERNAL_H
#include "limeiot_ota_transfer.h"
#include "limeiot_ota_log.h"
/* 仅耐久awaiting_boot后的安装端口调用；选择结果不明不得重新选择或写入。 */
bool li_esp_ota_activate(const li_ota_candidate_t *, const li_ota_transfer_guard_t *, char binding[LI_OTA_LOG_ID_SIZE]);
bool li_esp_ota_observe(const li_ota_log_view_t *, li_ota_stage_t *, li_ota_outcome_t *);
#endif
