/* 仅声明生产提供方使用的HTTP端口，宿主以OpenSSL回环HTTPS实现。 */
#pragma once
#include "esp_err.h"
#include <stdbool.h>
#include <stdint.h>
typedef struct li_test_http *esp_http_client_handle_t;
enum { HTTP_EVENT_ON_HEADER, HTTP_METHOD_GET, HTTP_TRANSPORT_OVER_SSL };
typedef struct { int event_id; char *header_key, *header_value; void *user_data; } esp_http_client_event_t;
typedef struct {
    const char *url, *cert_pem;
    int method, transport_type, timeout_ms, max_authorization_retries, buffer_size, buffer_size_tx;
    bool disable_auto_redirect, keep_alive_enable;
    esp_err_t (*event_handler)(esp_http_client_event_t *);
    void *user_data;
} esp_http_client_config_t;
esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t *);
esp_err_t esp_http_client_set_header(esp_http_client_handle_t, const char *, const char *);
esp_err_t esp_http_client_open(esp_http_client_handle_t, int);
int64_t esp_http_client_fetch_headers(esp_http_client_handle_t);
int esp_http_client_get_status_code(esp_http_client_handle_t);
int esp_http_client_read(esp_http_client_handle_t, char *, int);
bool esp_http_client_is_complete_data_received(esp_http_client_handle_t);
esp_err_t esp_http_client_close(esp_http_client_handle_t);
esp_err_t esp_http_client_cleanup(esp_http_client_handle_t);
