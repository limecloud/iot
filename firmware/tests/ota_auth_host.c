/* OpenSSL只用于宿主适配器，目标固件使用官方libsodium组件。 */
#include "limeiot_ota.h"
#include "ota_host_crypto.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
    if (argc < 4 || argc > 5) return 5;
    FILE *file = fopen(argv[1], "rb"); if (!file) return 5;
    char *raw = malloc(LI_MAX_PACKET + 1); if (!raw) { fclose(file); return 5; }
    size_t length = fread(raw, 1, LI_MAX_PACKET + 1, file);
    bool io = !ferror(file); fclose(file);
    li_ota_crypto_t crypto = {argc == 5 ? argv[4] : NULL, hash, verify};
    li_ota_key_t key; li_ota_authentication_t result = {0};
    li_error_t error = li_ota_key_decode(&crypto, argv[2], argv[3], &key);
    if (io && error == LI_OK) error = li_ota_authenticate(&crypto, &key, raw, length, &result);
    else error = LI_INVALID;
    free(raw);
    bool cleared = true;
    if (error != LI_OK) for (size_t i = 0; i < sizeof(result); i++) if (((const uint8_t *)&result)[i]) cleared = false;
    printf("{\"authenticated\":%s,\"manifest_digest\":\"%s\",\"signing_key_id\":\"%s\",\"proof_cleared\":%s}\n", error == LI_OK ? "true" : "false", result.manifest_digest, result.signing_key_id, cleared ? "true" : "false");
    return error == LI_OK ? 0 : 2;
}
