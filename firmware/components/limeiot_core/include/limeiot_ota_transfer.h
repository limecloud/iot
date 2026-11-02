#ifndef LIMEIOT_OTA_TRANSFER_H
#define LIMEIOT_OTA_TRANSFER_H
#include "limeiot_ota.h"
#ifdef __cplusplus
extern "C" {
#endif
#define LI_OTA_TRANSFER_CHUNK 1024
#define LI_OTA_TRANSFER_TIMEOUT_MS 30000
typedef struct {
    unsigned status;
    bool has_length, redirected, encoded;
    uint32_t content_length;
} li_ota_http_response_t;
typedef struct {
    void *context;
    /* 一次HTTPS GET，无认证/代理/重定向/重试；端口须验证证书/主机名并限制阻塞时长。 */
    bool (*open)(void *, const char *, li_ota_http_response_t *);
    bool (*read)(void *, uint8_t *, size_t capacity, size_t *received, bool *complete);
    void (*close)(void *);
} li_ota_source_t;
typedef struct {
    void *context;
    /* 仅备用区；失败允许已写入。finish只完成原生镜像验证，不得选择启动或重启。 */
    bool (*begin)(void *, uint32_t size);
    bool (*write)(void *, uint32_t offset, const uint8_t *, size_t);
    bool (*finish)(void *);
    bool (*read)(void *, uint32_t offset, uint8_t *, size_t);
    void (*abort)(void *);
} li_ota_sink_t;
typedef struct {
    void *context;
    bool (*begin)(void *);
    bool (*update)(void *, const uint8_t *, size_t);
    bool (*finish)(void *, uint8_t[32]);
    void (*abort)(void *);
} li_ota_hash_stream_t;
typedef struct {
    void *context;
    int64_t (*monotonic_ms)(void *);
    /* 在每个IO前后调用；产品须绑定本次耐久installing日志、当前会话/策略与本机事实。 */
    bool (*authorize)(void *);
} li_ota_transfer_guard_t;
typedef struct {
    uint32_t bytes_received, bytes_written, bytes_verified;
    bool image_verified;
    char image_sha256[72];
} li_ota_transfer_result_t;
/* candidate须来自独立本机预检。仅传输及回读验证，不授予安装、激活或重启权限。
 * 任何失败都清空image_verified/摘要；计数仅用于诊断，不证明失败写入未发生。
 * 不重试、不续传，异常须由原日志恢复处理，不得用本接口重新开始未知安装。
 * 30秒预算在IO前后检查；端口须另设阻塞上限，不保证硬实时终止。
 */
li_error_t li_ota_transfer_run(const li_ota_candidate_t *, const li_ota_source_t *, const li_ota_sink_t *,
                               const li_ota_hash_stream_t *, const li_ota_transfer_guard_t *,
                               li_ota_transfer_result_t *, const char **issue);
#ifdef __cplusplus
}
#endif
#endif
