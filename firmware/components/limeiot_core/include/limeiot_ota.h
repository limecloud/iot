#ifndef LIMEIOT_OTA_H
#define LIMEIOT_OTA_H
#include "limeiot.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    void *context;
    bool (*sha256)(void *, const uint8_t *, size_t, uint8_t[32]);
    bool (*ed25519_verify)(void *, const uint8_t[32], const uint8_t *, size_t, const uint8_t[64]);
} li_ota_crypto_t;
typedef struct {
    uint8_t public_key[32];
    char signing_key_id[72];
} li_ota_key_t;
typedef struct {
    char signing_key_id[72];
    char manifest_digest[72];
} li_ota_authentication_t;

/* 公钥来自独立初始化配置，不能从升级报文建立信任。这里只验证真实性，不批准安装。 */
li_error_t li_ota_key_decode(const li_ota_crypto_t *, const char *public_key_base64, const char *confirmed_key_id, li_ota_key_t *);
li_error_t li_ota_key_validate(const li_ota_crypto_t *, const li_ota_key_t *);
/* 固件合同只含ASCII字符串和安全整数；规范化递归覆盖对象及数组，不支持通用JSON数值。 */
li_error_t li_ota_authenticate(const li_ota_crypto_t *, const li_ota_key_t *, const char *manifest_json, size_t, li_ota_authentication_t *);

/* 由产品从独立本地配置提供；不能从ota_install报文填充。时间单位为UTC整秒。 */
typedef struct {
    const li_ota_key_t *key;
    const char *const *product_ids;
    size_t product_count;
    const char *const *download_origins;
    size_t origin_count;
    const char *const *revoked_artifact_ids;
    size_t revoked_count;
    uint32_t minimum_security_epoch;
    uint8_t minimum_battery_percent;
    int64_t not_before, expires_at;
} li_ota_policy_t;
/* 静态策略与公钥检查，不读取时间或设备；过期检查由preflight执行。 */
li_error_t li_ota_policy_validate(const li_ota_crypto_t *, const li_ota_policy_t *);
typedef struct li_ota_trust li_ota_trust_t;
/* 只用于独立本地配置。解码复制并拥有全部内容；输出失败为NULL，销毁后policy指针失效。
 * 严格读取limeiot.ota-trust，不读取当前时间；过期策略不能通过后续preflight。
 */
li_error_t li_ota_trust_decode(const li_ota_crypto_t *, const char *, size_t, li_ota_trust_t **);
const li_ota_policy_t *li_ota_trust_policy(const li_ota_trust_t *);
void li_ota_trust_destroy(li_ota_trust_t *);
typedef struct {
    void *context;
    const li_config_t *identity;
    bool (*read_device_info)(void *, li_device_info_t *);
    bool (*trusted_unix_seconds)(void *, int64_t *);
} li_ota_environment_t;
typedef struct {
    li_ota_authentication_t authentication;
    char artifact_id[74], version[33], image_sha256[72], download_url[1025];
    uint32_t size_bytes, security_epoch;
    int64_t issued_at, expires_at;
} li_ota_candidate_t;

/* 只读的当前安装前校验，不下载/写日志/写分区；实际执行前及耗时步骤后须重新校验。
 * identity和read_device_info来自本机；时钟必须独立认证。issue为静态错误码，无须释放。
 * URL接受规范HTTPS的DNS、IPv4/IPv6与非默认端口，拒绝凭据、查询、片段和点路径。
 * 失败清空整个candidate，成功也不证明镜像已下载或可启动。
 */
li_error_t li_ota_preflight(const li_ota_crypto_t *, const li_ota_policy_t *, const li_ota_environment_t *,
                          const char *manifest_json, size_t, li_ota_candidate_t *, const char **issue);

#ifdef __cplusplus
}
#endif
#endif
