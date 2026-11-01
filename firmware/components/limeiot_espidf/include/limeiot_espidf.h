#ifndef LIMEIOT_ESPIDF_H
#define LIMEIOT_ESPIDF_H
#include "limeiot.h"

typedef struct li_espidf li_espidf_t;
typedef struct {
    li_config_t core;
    const char *broker_host, *ca_pem, *certificate_pem, *private_key_pem;
    uint16_t broker_port;
    void *driver_context;
    bool (*trusted_clock)(void *);
    bool (*read_property)(void *, const char *, li_value_t *);
    li_apply_result_t (*write_property)(void *, const char *, li_value_t);
} li_espidf_options_t;

/* 网络/IP和可信墙钟由产品先准备。证书和配置须在整个运行期有效，不启用任意证书或明文回退。 */
li_error_t li_espidf_start(const li_espidf_options_t *, li_espidf_t **);
bool li_espidf_ready(const li_espidf_t *);
li_error_t li_espidf_event(li_espidf_t *, const char *path, int64_t value);
#endif
