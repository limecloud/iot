#ifndef LIMEIOT_ESPIDF_H
#define LIMEIOT_ESPIDF_H
#include "limeiot.h"
#include "limeiot_ota.h"
#include "limeiot_ota_transfer.h"
#include "limeiot_device_identity.h"

typedef struct li_espidf li_espidf_t;
/* 只初始化nvs/journal；加密档位要求预置且保护的HMAC密钥和设备/空间绑定。
 * 不调用密钥生成/eFuse写入/整区擦除接口，不自动迁移。身份加载后再次核对绑定。 */
li_error_t li_espidf_storage_init_partition(const char *partition);
li_error_t li_espidf_storage_verify_identity(const char *space, const char *device);
typedef struct {
    li_config_t core;
    const char *broker_host, *ca_pem, *certificate_pem, *private_key_pem;
    uint16_t broker_port;
    void *driver_context;
    bool (*trusted_clock)(void *);
    bool (*read_property)(void *, const char *, li_value_t *);
    li_apply_result_t (*write_property)(void *, const char *, li_value_t);
    bool (*read_device_info)(void *, li_device_info_t *);
    const li_ota_key_t *ota_firmware_key;
    const li_ota_policy_t *ota_policy;
    /* 独立传输CA；非空时要求完整策略并接通安装提供方。产品须独立确认本次启动健康。 */
    const char *ota_https_ca_pem;
    bool (*read_observation)(void *, const char *, li_observation_t *);
} li_espidf_options_t;

/* 网络/IP和可信墙钟由产品先准备。证书和配置须在整个运行期有效，不启用任意证书或明文回退。 */
li_error_t li_espidf_start(const li_espidf_options_t *, li_espidf_t **);
bool li_espidf_ready(const li_espidf_t *);
/* 产品驱动、身份、可信时钟及IoT握手健康后调用；核对原生镜像/启动目标，
 * 仅将PENDING_VERIFY确认VALID；未知状态拒绝，不选择启动分区或重启。 */
li_error_t li_espidf_confirm_running_image(void);
li_error_t li_espidf_event(li_espidf_t *, const char *path, int64_t value);
bool li_espidf_ota_crypto(li_ota_crypto_t *);
/* 产品须串行调用；只使用启动时配置的独立策略，禁止每次下行替换撤销/来源范围。 */
li_error_t li_espidf_ota_preflight(li_espidf_t *, const char *, size_t, li_ota_candidate_t *, const char **issue);
/* 低层备用区暂存。必须由耐久installing任务调用并提供绑定当前会话/策略/本机事实的guard。
 * CA为独立HTTPS传输信任，不继承设备身份或签名公钥。成功不激活、切换分区或重启。
 */
li_error_t li_espidf_ota_stage(const li_ota_candidate_t *, const char *https_ca_pem,
                              const li_ota_transfer_guard_t *, li_ota_transfer_result_t *, const char **issue);
#endif
