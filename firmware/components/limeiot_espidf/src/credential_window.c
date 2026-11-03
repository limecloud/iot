/* TLS握手不能替代长连接期间的凭据检查；不改变证书时间校验或系统时间。 */
#include "credential_window.h"
#include "identity_crypto.h"
#include "mbedtls/x509_crt.h"
#include <string.h>

bool li_credential_window_current(const li_credential_window_t *window, bool trusted_clock) {
#if !defined(MBEDTLS_HAVE_TIME_DATE)
    (void)window; (void)trusted_clock; return false;
#else
    return window && trusted_clock && !atomic_load(&window->blocked)
        && !mbedtls_x509_time_is_future(&window->leaf_from) && !mbedtls_x509_time_is_past(&window->leaf_to)
        && !mbedtls_x509_time_is_future(&window->ca_from) && !mbedtls_x509_time_is_past(&window->ca_to);
#endif
}
bool li_credential_window_check(li_credential_window_t *window, bool trusted_clock) {
    if (!window) return false;
    if (li_credential_window_current(window, trusted_clock)) return true;
    atomic_store(&window->blocked, true); return false;
}
bool li_credential_window_open(li_credential_window_t *window, const char *key, const char *certificate,
    const char *ca, const char *device) {
    if (!window) return false;
    memset(window, 0, sizeof(*window)); atomic_init(&window->blocked, true);
    if (!li_identity_certificate(key, certificate, ca, device)) return false;
    mbedtls_x509_crt leaf, authority; mbedtls_x509_crt_init(&leaf); mbedtls_x509_crt_init(&authority);
    bool valid = mbedtls_x509_crt_parse(&leaf, (const unsigned char *)certificate, strlen(certificate) + 1) == 0
        && mbedtls_x509_crt_parse(&authority, (const unsigned char *)ca, strlen(ca) + 1) == 0;
    if (valid) {
        window->leaf_from = leaf.valid_from; window->leaf_to = leaf.valid_to;
        window->ca_from = authority.valid_from; window->ca_to = authority.valid_to;
        atomic_store(&window->blocked, false); valid = li_credential_window_check(window, true);
    }
    mbedtls_x509_crt_free(&leaf); mbedtls_x509_crt_free(&authority); return valid;
}
