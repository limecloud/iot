#ifndef LIMEIOT_OTA_LOG_H
#define LIMEIOT_OTA_LOG_H
#include "limeiot_ota.h"

#ifdef __cplusplus
extern "C" {
#endif
#define LI_OTA_LOG_SLOTS 4
#define LI_OTA_LOG_BYTES 32768
#define LI_OTA_LOG_ID_SIZE 129
typedef enum { LI_OTA_INTENT, LI_OTA_INSTALLING, LI_OTA_AWAITING_BOOT, LI_OTA_SUCCEEDED,
               LI_OTA_REJECTED, LI_OTA_FAILED, LI_OTA_ROLLED_BACK } li_ota_stage_t;
typedef struct { char firmware_version[33], image_sha256[72]; uint32_t security_epoch; } li_ota_baseline_t;
typedef struct {
    char boot_id[LI_OTA_LOG_ID_SIZE], firmware_version[33], image_sha256[72], error[65];
    uint32_t security_epoch;
    bool pending_update;
} li_ota_outcome_t;
typedef struct {
    char task_id[LI_OTA_LOG_ID_SIZE], execution_id[LI_OTA_LOG_ID_SIZE], request_digest[72], manifest_digest[72];
    char boot_id[LI_OTA_LOG_ID_SIZE], session_id[LI_OTA_LOG_ID_SIZE], target_version[33], target_image_sha256[72];
    uint32_t target_security_epoch, target_size_bytes;
    char boot_binding[LI_OTA_LOG_ID_SIZE];
    int64_t expires_ms;
    li_ota_baseline_t baseline;
    li_ota_outcome_t outcome;
    li_ota_stage_t stage;
    bool recovered;
} li_ota_log_view_t;
typedef struct {
    void *context;
    bool (*read)(void *, char *, size_t, size_t *, bool *found);
    /* true必须表示整个快照已原子耐久提交；false允许已写入，日志会进入故障状态。 */
    bool (*write)(void *, const char *, size_t);
    bool (*trusted_unix_ms)(void *, int64_t *);
} li_ota_log_ports_t;
typedef struct li_ota_log li_ota_log_t;

/* 日志不授予安装权限。prepare前和实际副作用前须独立校验会话、策略与本机事实。
 * 所有调用须由设备任务串行执行，端口不得重入；配置字符串与端口context须覆盖日志生命周期。
 * 原Envelope、基线与结果同快照保存；重启不会重发或恢复安装。
 * 同一设备只允许一个未决任务；终态且期限已过的记录可在新prepare时回收。
 * 保留至多4条、32KiB；空间不足拒绝，不借用或清除控制回执。
 */
li_ota_log_t *li_ota_log_open(const li_config_t *, const li_ota_crypto_t *, const li_ota_log_ports_t *, li_error_t *);
void li_ota_log_close(li_ota_log_t *);
li_error_t li_ota_log_prepare(li_ota_log_t *, const char *install_envelope, size_t, const li_ota_baseline_t *);
li_error_t li_ota_log_advance(li_ota_log_t *, const char *execution_id, li_ota_stage_t);
/* 启动选择成功后提交本机启动凭据；仅本次运行的awaiting_boot可首次绑定。 */
li_error_t li_ota_log_bind_boot(li_ota_log_t *, const char *execution_id, const char *binding);
/* 终态须由独立本机证据提供；成功/回滚要求新boot，版本/代次/完整镜像与原目标或基线匹配。 */
li_error_t li_ota_log_finish(li_ota_log_t *, const char *execution_id, li_ota_stage_t, const li_ota_outcome_t *);
/* 查询不读时钟、不写盘，不重检已撤销的安装信任；不提供重新安装能力。
 * 视图/原文指针在close或下一次成功修改后可能失效，调用方不得修改。
 */
li_error_t li_ota_log_get(const li_ota_log_t *, const char *execution_id, const li_ota_log_view_t **, const char **original_envelope);
li_error_t li_ota_log_pending(const li_ota_log_t *, const li_ota_log_view_t **);
const char *li_ota_stage_name(li_ota_stage_t);
bool li_ota_log_blocked(const li_ota_log_t *);

#ifdef __cplusplus
}
#endif
#endif
