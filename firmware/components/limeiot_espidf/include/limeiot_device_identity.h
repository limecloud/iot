#ifndef LIMEIOT_DEVICE_IDENTITY_H
#define LIMEIOT_DEVICE_IDENTITY_H
#include "limeiot.h"

#define LI_IDENTITY_KEY_PEM_SIZE 512
#define LI_IDENTITY_CERT_PEM_SIZE 4000
#define LI_IDENTITY_CSR_PEM_SIZE 1024
#define LI_IDENTITY_FINGERPRINT_SIZE 72
#define LI_IDENTITY_PROOF_SIZE 145

typedef struct {
    unsigned state; /* 0 empty、1 pending、2 ready、3 rotating */
    uint32_t generation;
    char rotation_id[LI_ID_SIZE];
    char public_key_fingerprint[LI_IDENTITY_FINGERPRINT_SIZE];
    char certificate_fingerprint[LI_IDENTITY_FINGERPRINT_SIZE];
    char pending_public_key_fingerprint[LI_IDENTITY_FINGERPRINT_SIZE];
    bool certificate_expired;
    unsigned recovery_origin; /* 0 ordinary、1 expired_identity、2 pending_rotation */
} li_espidf_identity_status_t;

typedef struct li_espidf_identity li_espidf_identity_t;
typedef struct {
    const char *space_id, *device_id, *ca_pem;
    void *clock_context;
    bool (*trusted_clock)(void *);
} li_espidf_identity_options_t;

/* 仅加密档位可用；不接受或生成硬件根密钥。坏记录拒绝，不擦除或自动换钥。
 * 调用者串行使用本对象，配置/可信时钟回调在整个生命周期有效。 */
li_error_t li_espidf_identity_open(const li_espidf_identity_options_t *, li_espidf_identity_t **);
void li_espidf_identity_close(li_espidf_identity_t *);
/* 必须由产品明确的初始化操作调用；首次生成后先耐久保存并重开回读，才导出CSR。
 * 未签发时再次调用只复用原密钥；已导入证书后不自动轮换。 */
li_error_t li_espidf_identity_request(li_espidf_identity_t *, char *csr, size_t,
                                      char fingerprint[LI_IDENTITY_FINGERPRINT_SIZE]);
/* 仅导入与本机密钥、固定CA、精确设备CN和clientAuth用途匹配的当前有效单份证书。
 * 原证书重复导入只读；不同新证书不作为隐式续期。 */
li_error_t li_espidf_identity_import(li_espidf_identity_t *, const char *certificate_pem);
/* 内部产品启动端口。输出私钥只供同进程TLS适配，不发送到USB、网络、工具或日志。 */
li_error_t li_espidf_identity_credentials(li_espidf_identity_t *, char *certificate, size_t,
                                          char *private_key, size_t);
/* 轮换保留旧身份；只有明确导入匹配新键的有效证书才原子切换。原ID恢复，不自动取消或换键。 */
li_error_t li_espidf_identity_rotate_request(li_espidf_identity_t *, const char *rotation_id,
    char *csr, size_t, char fingerprint[LI_IDENTITY_FINGERPRINT_SIZE]);
/* 明确批准过期维护；新请求或原候选均保留原ID/键，绝不授予旧证书TLS能力。
 * 旧v2候选须提供已保存的原CSR；v3恢复只读返回耐久原字节，不能用新CSR替换。 */
li_error_t li_espidf_identity_recover_request(li_espidf_identity_t *, const char *rotation_id,
    const char *original_csr, char *csr, size_t, char fingerprint[LI_IDENTITY_FINGERPRINT_SIZE]);
li_error_t li_espidf_identity_rotate_import(li_espidf_identity_t *, const char *rotation_id, const char *certificate);
li_error_t li_espidf_identity_status(li_espidf_identity_t *, li_espidf_identity_status_t *);
/* 激活证明只由已切换的新键签名；challenge为管理端原意图内的64位小写十六进制随机数。
 * 输出为P-256/SHA-256的ASN.1 DER ECDSA签名十六进制，不含私钥。 */
li_error_t li_espidf_identity_rotation_proof(li_espidf_identity_t *, const char *rotation_id,
    const char *challenge, char proof[LI_IDENTITY_PROOF_SIZE]);
#endif
