#ifndef LI_CREDENTIAL_WINDOW_H
#define LI_CREDENTIAL_WINDOW_H
#include "mbedtls/x509.h"
#include <stdatomic.h>
#include <stdbool.h>

/* 启动时验证完整身份并冻结公开日期；运行期只读日期，失败后当前实例不恢复。 */
typedef struct {
    mbedtls_x509_time leaf_from, leaf_to, ca_from, ca_to;
    atomic_bool blocked;
} li_credential_window_t;
bool li_credential_window_open(li_credential_window_t *, const char *key, const char *certificate,
                               const char *ca, const char *device);
bool li_credential_window_current(const li_credential_window_t *, bool trusted_clock);
bool li_credential_window_check(li_credential_window_t *, bool trusted_clock);
#endif
