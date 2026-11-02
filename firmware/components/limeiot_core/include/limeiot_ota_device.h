#ifndef LIMEIOT_OTA_DEVICE_H
#define LIMEIOT_OTA_DEVICE_H
#include "limeiot_ota_log.h"
#include "limeiot_ota_transfer.h"

#ifdef __cplusplus
extern "C" {
#endif
typedef struct {
    void *context;
    /* 读取本机当前运行镜像的完整范围摘要、版本、代次及启动确认状态，禁止使用网络参数。 */
    bool (*read_running)(void *, li_ota_baseline_t *, bool *pending_update);
    bool (*trusted_unix_seconds)(void *, int64_t *);
} li_ota_device_ports_t;
typedef struct {
    void *context;
    /* 长调用期间的实时连接/会话代次检查，不得仅读取尚未处理断线事件的core缓存。 */
    bool (*current)(void *);
    li_error_t (*stage)(void *, const li_ota_candidate_t *, const li_ota_transfer_guard_t *, li_ota_transfer_result_t *, const char **);
    /* 必须在实际选择前再次调用guard；失败也允许已选择，调用方将保留awaiting_boot。 */
    bool (*activate)(void *, const li_ota_candidate_t *, const li_ota_transfer_guard_t *, char binding[LI_OTA_LOG_ID_SIZE]);
    void (*restart)(void *);
} li_ota_installer_t;
typedef struct {
    void *context;
    /* 独立读取当前启动选择凭据、精确原声明长度的实际镜像及已确认健康/回滚事实。
     * 只允许succeeded或rolled_back；不得根据网络参数、旧状态或版本相同推断。 */
    bool (*read)(void *, const li_ota_log_view_t *, li_ota_stage_t *, li_ota_outcome_t *);
} li_ota_boot_observer_t;
/* 在连接前配置一次；log、policy及端口context须覆盖core生命周期。core销毁时不释放它们。
 * 未设置独立安装提供方时只耐久拒绝；声明safe_to_update须由产品满足完整交付条件。
 * 无policy仍可查询原结果，不能接受新安装。所有调用在同一设备任务串行执行。
 */
li_error_t li_ota_device_attach(li_core_t *, li_ota_log_t *, const li_ota_crypto_t *,
                                const li_ota_policy_t *, const li_ota_device_ports_t *);
/* 仅在连接前配置；端口不得重入core。激活结果不明及重启恢复均不得再次安装。 */
li_error_t li_ota_device_set_installer(li_core_t *, const li_ota_installer_t *);
li_error_t li_ota_device_set_boot_observer(li_core_t *, const li_ota_boot_observer_t *);
#ifdef __cplusplus
}
#endif
#endif
