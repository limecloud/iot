#ifndef LIMEIOT_H
#define LIMEIOT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LI_MAX_PACKET 16384
#define LI_RECEIPT_SLOTS 32
#define LI_MAX_PROPERTIES 16
#define LI_ID_SIZE 65
#define LI_PATH_SIZE 97

typedef enum { LI_OK, LI_IGNORED, LI_INVALID, LI_SESSION, LI_EXPIRED, LI_CONFLICT,
               LI_STORAGE, LI_TRANSPORT, LI_CAPACITY, LI_DRIVER, LI_CLOCK } li_error_t;
typedef enum { LI_BOOLEAN, LI_INTEGER } li_value_type_t;
typedef struct { li_value_type_t type; int64_t integer; bool boolean; } li_value_t;
typedef struct { li_value_t value; int64_t sampled_mono_ms; } li_observation_t;
typedef struct { const char *path; li_value_type_t type; bool writable; int64_t minimum, maximum; } li_property_t;
typedef struct { const char *path; const char *field; int64_t minimum, maximum; } li_event_t;
typedef enum { LI_APPLIED, LI_NOT_APPLIED, LI_EXECUTION_UNKNOWN } li_apply_result_t;
typedef struct {
    const char *product_id, *architecture, *chip, *board, *bootloader_version;
    uint32_t security_epoch, ota_capacity_bytes;
    bool external_power, has_battery, safe_to_update, pending_update;
    uint8_t battery_percent;
} li_device_info_t;

/* 回调在同一个设备任务中调用。写存储成功必须表示已耐久提交；publish 成功表示已复制入有界发送队列。 */
typedef struct {
    void *context;
    bool (*random_bytes)(void *, uint8_t *, size_t);
    int64_t (*monotonic_ms)(void *);
    bool (*sha256)(void *, const uint8_t *, size_t, uint8_t[32]);
    bool (*storage_read)(void *, unsigned, char *, size_t, size_t *, bool *);
    bool (*storage_write)(void *, unsigned, const char *, size_t);
    bool (*publish)(void *, const char *, const char *, size_t);
    bool (*read_property)(void *, const char *, li_value_t *);
    li_apply_result_t (*write_property)(void *, const char *, li_value_t);
    /* 可选的当前设备信息；缺失或读取失败不得推断为支持升级。 */
    bool (*read_device_info)(void *, li_device_info_t *);
    /* 可选采样端口，替代快照中的read_property；时间来自同一个monotonic_ms时钟。
     * 缓存样本保留原采样时刻，读取失败不得伪造新样本。由设备任务串行调用。 */
    bool (*read_observation)(void *, const char *, li_observation_t *);
} li_ports_t;
typedef struct {
    const char *space_id, *device_id, *model_revision, *firmware_version, *hardware_revision;
    const li_property_t *properties;
    size_t property_count;
    const li_event_t *events;
    size_t event_count;
    const char *observation_source;
} li_config_t;
typedef struct li_core li_core_t;

/* 配置与绑定由产品持有，生命周期须覆盖 core。时钟、传输、存储及驱动均不暴露厂商类型。 */
li_core_t *li_core_create(const li_config_t *, const li_ports_t *, li_error_t *);
void li_core_destroy(li_core_t *);
li_error_t li_connected(li_core_t *);
void li_disconnected(li_core_t *);
li_error_t li_receive(li_core_t *, const char *topic, const char *payload, size_t length, bool retained);
li_error_t li_tick(li_core_t *);
li_error_t li_report_snapshot(li_core_t *);
li_error_t li_emit_event(li_core_t *, const char *path, int64_t value);
bool li_ready(const li_core_t *);
const char *li_error_code(li_error_t);

#ifdef __cplusplus
}
#endif
#endif
