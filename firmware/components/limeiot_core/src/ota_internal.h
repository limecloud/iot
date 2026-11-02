#ifndef LI_OTA_INTERNAL_H
#define LI_OTA_INTERNAL_H
#include "cJSON.h"
#include "limeiot_ota.h"
#include "limeiot_ota_log.h"
#include <stddef.h>
/* 内部共享的有界ASCII JSON解析，拒绝重复键、NUL、尾随数据和非法数字词法。 */
cJSON *li_ota_document_parse(const char *, size_t);
cJSON *li_ota_document_parse_limit(const char *, size_t, size_t);
char *li_ota_json_encode(const cJSON *, size_t maximum, size_t *length);
bool li_ota_json_hash(const li_ota_crypto_t *, const cJSON *, size_t maximum, char[72]);
bool li_ota_time_parse(const char *, int64_t *);
bool li_ota_digest_valid(const char *);
bool li_ota_version_valid(const char *);
bool li_ota_object_fields(const cJSON *, const char *const *, size_t);
bool li_ota_uint32(const cJSON *, uint32_t *);
bool li_ota_identifier(const char *);
bool li_ota_deadline(const char *, int64_t *);
/* 返回拥有的严格安装Envelope及元数据，失败为NULL且清空view。 */
cJSON *li_ota_install_parse(const li_config_t *, const li_ota_crypto_t *, const char *, size_t, li_ota_log_view_t *);
#endif
