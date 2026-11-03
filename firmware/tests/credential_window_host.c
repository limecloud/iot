/* 固定SDK密码库和真实墙钟；只验证凭据门禁，不模拟ESP MQTT任务或芯片。 */
#include "credential_window.h"
#include <openssl/crypto.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

int sodium_memcmp(const void *a, const void *b, size_t length) { return CRYPTO_memcmp(a, b, length); }
static bool read_pem(const char *path, char *buffer, size_t capacity) {
    FILE *file = fopen(path, "rb"); if (!file) return false;
    size_t length = fread(buffer, 1, capacity - 1, file);
    bool valid = !ferror(file) && fgetc(file) == EOF;
    fclose(file); buffer[length] = 0; return valid;
}
int main(int argc, char **argv) {
    if (argc != 5) return 5;
    char key[512] = {0}, certificate[4000] = {0}, ca[4000] = {0};
    if (!read_pem(argv[1], key, sizeof(key)) || !read_pem(argv[2], certificate, sizeof(certificate)) || !read_pem(argv[3], ca, sizeof(ca))) return 5;
    li_credential_window_t window;
    bool opened = li_credential_window_open(&window, key, certificate, ca, "device-lamp");
    bool initial = li_credential_window_check(&window, true), after = initial, restored = initial, reopened = false;
    if (!strcmp(argv[4], "clock")) {
        after = li_credential_window_check(&window, false);
        restored = li_credential_window_check(&window, true);
        reopened = li_credential_window_open(&window, key, certificate, ca, "device-lamp");
    } else if (!strcmp(argv[4], "expiry") && opened) {
        struct timespec start, now, pause = {.tv_sec = 0, .tv_nsec = 20000000};
        if (clock_gettime(CLOCK_MONOTONIC, &start)) return 5;
        do {
            if (nanosleep(&pause, NULL) || clock_gettime(CLOCK_MONOTONIC, &now)) return 5;
            after = li_credential_window_check(&window, true);
        } while (after && now.tv_sec - start.tv_sec < 10);
        restored = li_credential_window_check(&window, true);
        reopened = li_credential_window_open(&window, key, certificate, ca, "device-lamp");
    } else if (strcmp(argv[4], "check")) return 5;
    printf("{\"opened\":%s,\"initial\":%s,\"after\":%s,\"restored\":%s,\"reopened\":%s,\"window_only\":true,\"hardware\":false}\n",
        opened ? "true" : "false", initial ? "true" : "false", after ? "true" : "false", restored ? "true" : "false", reopened ? "true" : "false");
    OPENSSL_cleanse(key, sizeof(key)); return 0;
}
