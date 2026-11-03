/* 运行实际设备身份/密码/存储适配器。NVS、eFuse和传输为显式宿主夹具。 */
#include "limeiot_espidf.h"
#include "nvs.h"
#include "storage_test_api.h"
#include <openssl/crypto.h>
#include <openssl/hmac.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char *mode, *directory;
static unsigned char root[32], binding[4096], staged[8192];
static size_t staged_size;
static unsigned writes, commits, opens;
static bool committed;
static bool is(const char *value) { return !strcmp(mode, value); }
static bool file_path(char *result, size_t size, const char *name) {
    int length = snprintf(result, size, "%s/%s", directory, name);
    return length > 0 && (size_t)length < size;
}
static size_t load(const char *name, unsigned char *result, size_t capacity) {
    FILE *file = fopen(name, "rb"); if (!file) return 0;
    size_t size = fread(result, 1, capacity, file);
    if (ferror(file) || fgetc(file) != EOF) size = 0;
    fclose(file); return size;
}
esp_efuse_purpose_t esp_efuse_get_key_purpose(esp_efuse_block_t block) { return block == EFUSE_BLK_KEY0 && !is("missing-key") ? ESP_EFUSE_KEY_PURPOSE_HMAC_UP : 0; }
bool esp_efuse_get_key_dis_read(esp_efuse_block_t block) { return block == EFUSE_BLK_KEY0; }
bool esp_efuse_get_key_dis_write(esp_efuse_block_t block) { return block == EFUSE_BLK_KEY0; }
bool esp_efuse_get_keypurpose_dis_write(esp_efuse_block_t block) { return block == EFUSE_BLK_KEY0; }
const esp_partition_t *esp_partition_find_first(int type, int subtype, const char *label) {
    static esp_partition_t partition = {4096, false, true};
    return type == 1 && subtype == 0x40 && !strcmp(label, "li-security") ? &partition : NULL;
}
esp_err_t esp_partition_read(const esp_partition_t *partition, size_t offset, void *output, size_t length) {
    if (!partition || offset || length != 208) return ESP_FAIL;
    memcpy(output, binding, length); return ESP_OK;
}
esp_err_t esp_hmac_calculate(hmac_key_id_t id, const void *data, size_t length, void *output) {
    if (id || is("mac-failed")) return ESP_FAIL;
    unsigned actual = 0;
    return HMAC(EVP_sha256(), root, 32, data, length, output, &actual) && actual == 32 ? ESP_OK : ESP_FAIL;
}
nvs_sec_scheme_t *nvs_flash_get_default_security_scheme(void) { static nvs_sec_scheme_t scheme = {NVS_SEC_SCHEME_HMAC}; return &scheme; }
esp_err_t nvs_flash_read_security_cfg_v2(nvs_sec_scheme_t *scheme, nvs_sec_cfg_t *keys) { if (!scheme) return ESP_FAIL; memset(keys, 0, sizeof(*keys)); return ESP_OK; }
esp_err_t nvs_flash_secure_init_partition(const char *name, nvs_sec_cfg_t *keys) { (void)keys; return !strcmp(name, "journal") ? ESP_OK : ESP_FAIL; }
esp_err_t nvs_flash_init_partition(const char *name) { (void)name; return ESP_FAIL; }
int sodium_memcmp(const void *a, const void *b, size_t length) { return CRYPTO_memcmp(a, b, length); }
esp_err_t nvs_open_from_partition(const char *partition, const char *name, int access, nvs_handle_t *handle) {
    opens++;
    if (strcmp(partition, "journal") || strcmp(name, "li-identity") || access != NVS_READWRITE || (committed && is("reopen-failed"))) return ESP_FAIL;
    *handle = opens; return ESP_OK;
}
esp_err_t nvs_get_blob(nvs_handle_t handle, const char *key, void *output, size_t *capacity) {
    if (!handle || strcmp(key, "identity") || is("read-failed") || (committed && is("readback-failed"))) return ESP_FAIL;
    char path[4096]; if (!file_path(path, sizeof(path), "identity.blob")) return ESP_FAIL;
    FILE *file = fopen(path, "rb"); if (!file) return errno == ENOENT ? ESP_ERR_NVS_NOT_FOUND : ESP_FAIL;
    if (fseek(file, 0, SEEK_END)) { fclose(file); return ESP_FAIL; }
    long size = ftell(file); rewind(file);
    if (size < 0 || (size_t)size > *capacity) { fclose(file); return ESP_ERR_NVS_INVALID_LENGTH; }
    bool valid = fread(output, 1, (size_t)size, file) == (size_t)size && !ferror(file); fclose(file);
    *capacity = (size_t)size;
    if (valid && committed && is("readback-corrupt") && size) ((unsigned char *)output)[0] ^= 1;
    return valid ? ESP_OK : ESP_FAIL;
}
esp_err_t nvs_set_blob(nvs_handle_t handle, const char *key, const void *data, size_t size) {
    if (!handle || strcmp(key, "identity") || size > sizeof(staged)) return ESP_FAIL;
    writes++; memcpy(staged, data, size); staged_size = size; return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t handle) {
    if (!handle || !staged_size) return ESP_FAIL;
    commits++;
    if (is("commit-before")) return ESP_FAIL;
    char path[4096], temporary[4096];
    if (!file_path(path, sizeof(path), "identity.blob") || !file_path(temporary, sizeof(temporary), "identity.next")) return ESP_FAIL;
    FILE *file = fopen(temporary, "wb"); if (!file) return ESP_FAIL;
    bool valid = fwrite(staged, 1, staged_size, file) == staged_size && !fflush(file) && !fsync(fileno(file));
    if (fclose(file)) valid = false;
    if (!valid || rename(temporary, path)) return ESP_FAIL;
    committed = true;
    return is("commit-after") ? ESP_FAIL : ESP_OK;
}
void nvs_close(nvs_handle_t handle) { (void)handle; OPENSSL_cleanse(staged, sizeof(staged)); staged_size = 0; }
static bool trusted(void *context) { (void)context; return !is("clock-untrusted"); }
static const char *code(li_error_t error) {
    switch (error) {
        case LI_OK: return "ok"; case LI_STORAGE: return "storage"; case LI_CLOCK: return "clock";
        case LI_INVALID: return "invalid"; case LI_CONFLICT: return "conflict"; case LI_CAPACITY: return "capacity";
        default: return "driver";
    }
}
static bool tls_mqtt(const char *ca, const char *certificate, const char *key, const char *device, int port) {
    SSL_CTX *context = SSL_CTX_new(TLS_client_method()); SSL *client = NULL;
    BIO *leaf_input = BIO_new_mem_buf(certificate, -1), *key_input = BIO_new_mem_buf(key, -1);
    X509 *leaf = PEM_read_bio_X509(leaf_input, NULL, NULL, NULL);
    EVP_PKEY *private_key = PEM_read_bio_PrivateKey(key_input, NULL, NULL, NULL);
    int descriptor = -1; bool valid = false;
    if (!context || !leaf || !private_key || SSL_CTX_load_verify_locations(context, ca, NULL) != 1
        || SSL_CTX_use_certificate(context, leaf) != 1 || SSL_CTX_use_PrivateKey(context, private_key) != 1
        || SSL_CTX_check_private_key(context) != 1 || SSL_CTX_set_min_proto_version(context, TLS1_2_VERSION) != 1
        || SSL_CTX_set_max_proto_version(context, TLS1_2_VERSION) != 1) goto done;
    SSL_CTX_set_verify(context, SSL_VERIFY_PEER, NULL);
    descriptor = socket(AF_INET, SOCK_STREAM, 0); if (descriptor < 0) goto done;
    struct timeval timeout = {3, 0};
    if (setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout))
        || setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout))) goto done;
    struct sockaddr_in address = {0}; address.sin_family = AF_INET; address.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, "127.0.0.1", &address.sin_addr) != 1 || connect(descriptor, (struct sockaddr *)&address, sizeof(address))) goto done;
    client = SSL_new(context);
    if (!client || SSL_set_fd(client, descriptor) != 1 || X509_VERIFY_PARAM_set1_ip_asc(SSL_get0_param(client), "127.0.0.1") != 1
        || SSL_connect(client) != 1 || SSL_get_verify_result(client) != X509_V_OK) goto done;
    unsigned char packet[100] = {0x10, 0, 0, 4, 'M', 'Q', 'T', 'T', 5, 2, 0, 30, 0, 0, 0};
    size_t length = strlen(device); if (length >= LI_ID_SIZE) goto done;
    packet[1] = (unsigned char)(13 + length); packet[14] = (unsigned char)length; memcpy(packet + 15, device, length);
    if (SSL_write(client, packet, (int)(15 + length)) != (int)(15 + length)) goto done;
    unsigned char response[4]; size_t received = 0;
    while (received < sizeof(response)) {
        int count = SSL_read(client, response + received, (int)(sizeof(response) - received));
        if (count <= 0) goto done;
        received += (size_t)count;
    }
    valid = response[0] == 0x20 && response[3] == 0;
done:
    if (client) SSL_free(client);
    if (descriptor >= 0) close(descriptor);
    if (context) SSL_CTX_free(context);
    X509_free(leaf); EVP_PKEY_free(private_key); BIO_free(leaf_input); BIO_free(key_input);
    return valid;
}
int main(int argc, char **argv) {
    if (argc < 6) return 5;
    signal(SIGPIPE, SIG_IGN); umask(0077);
    directory = argv[1]; const char *ca_file = argv[2], *action = argv[3]; mode = argv[4]; const char *device = argv[5];
    char path[4096], ca[LI_IDENTITY_CERT_PEM_SIZE] = {0};
    if (!file_path(path, sizeof(path), "root.bin") || load(path, root, sizeof(root)) != sizeof(root)
        || !file_path(path, sizeof(path), "binding.bin") || load(path, binding, sizeof(binding)) != sizeof(binding)
        || !load(ca_file, (unsigned char *)ca, sizeof(ca) - 1)) return 5;
    li_espidf_identity_options_t options = {"space-demo", device, ca, NULL, trusted};
    li_espidf_identity_t *identity = NULL;
    li_error_t result = li_espidf_identity_open(&options, &identity), second = LI_IGNORED;
    bool zero_output = true, mqtt = false;
    char csr[LI_IDENTITY_CSR_PEM_SIZE] = {0}, fingerprint[LI_IDENTITY_FINGERPRINT_SIZE] = {0};
    char certificate[LI_IDENTITY_CERT_PEM_SIZE] = {0}, private_key[LI_IDENTITY_KEY_PEM_SIZE] = {0};
    char proof[LI_IDENTITY_PROOF_SIZE] = {0}; li_espidf_identity_status_t status = {0};
    if (result == LI_OK && !strcmp(action, "recover-request")) {
        if ((argc != 7 && argc != 8) || (argc == 8 && !load(argv[7], (unsigned char *)certificate, LI_IDENTITY_CSR_PEM_SIZE - 1))) return 5;
        const char *original = argc == 8 ? certificate : NULL;
        result = li_espidf_identity_recover_request(identity, argv[6], original, csr, sizeof(csr), fingerprint);
        second = li_espidf_identity_recover_request(identity, argv[6], original, csr, sizeof(csr), fingerprint);
        if (result == LI_OK) {
            if (!file_path(path, sizeof(path), "request.csr")) return 5;
            FILE *file = fopen(path, "wb"); if (!file) return 5;
            if (fwrite(csr, 1, strlen(csr), file) != strlen(csr) || fclose(file)) return 5;
        }
    } else if (result == LI_OK && !strcmp(action, "status")) {
        result = li_espidf_identity_status(identity, &status);
    } else if (result == LI_OK && (!strcmp(action, "request") || !strcmp(action, "rotate-request"))) {
        bool rotate = !strcmp(action, "rotate-request"); if (rotate && argc != 7) return 5;
        result = rotate ? li_espidf_identity_rotate_request(identity, argv[6], csr, sizeof(csr), fingerprint)
            : li_espidf_identity_request(identity, csr, sizeof(csr), fingerprint);
        second = rotate ? li_espidf_identity_rotate_request(identity, argv[6], csr, sizeof(csr), fingerprint)
            : li_espidf_identity_request(identity, csr, sizeof(csr), fingerprint);
        if (result == LI_OK) {
            if (!file_path(path, sizeof(path), "request.csr")) return 5;
            FILE *file = fopen(path, "wb"); if (!file) return 5;
            if (fwrite(csr, 1, strlen(csr), file) != strlen(csr) || fclose(file)) return 5;
        }
    } else if (result == LI_OK && !strcmp(action, "import")) {
        if (argc != 7 || !load(argv[6], (unsigned char *)certificate, sizeof(certificate) - 1)) return 5;
        result = li_espidf_identity_import(identity, certificate);
        second = li_espidf_identity_import(identity, certificate);
    } else if (result == LI_OK && !strcmp(action, "rotate-import")) {
        if (argc != 8 || !load(argv[7], (unsigned char *)certificate, sizeof(certificate) - 1)) return 5;
        result = li_espidf_identity_rotate_import(identity, argv[6], certificate);
        second = li_espidf_identity_rotate_import(identity, argv[6], certificate);
    } else if (result == LI_OK && !strcmp(action, "proof")) {
        if (argc != 8) return 5;
        result = li_espidf_identity_rotation_proof(identity, argv[6], argv[7], proof);
    } else if (result == LI_OK && (!strcmp(action, "credentials") || !strcmp(action, "mqtt"))) {
        memset(certificate, 0x5a, sizeof(certificate)); memset(private_key, 0x5a, sizeof(private_key));
        result = li_espidf_identity_credentials(identity, certificate, sizeof(certificate), private_key, sizeof(private_key));
        for (size_t i = 0; i < sizeof(certificate); i++) if (certificate[i]) zero_output = false;
        for (size_t i = 0; i < sizeof(private_key); i++) if (private_key[i]) zero_output = false;
        if (result == LI_OK && !strcmp(action, "mqtt")) {
            if (argc != 7) return 5;
            mqtt = tls_mqtt(ca_file, certificate, private_key, device, atoi(argv[6]));
        }
    }
    if (identity) (void)li_espidf_identity_status(identity, &status);
    printf("{\"code\":\"%s\",\"second\":\"%s\",\"fingerprint\":\"%s\",\"writes\":%u,\"commits\":%u,\"outputs_zero\":%s,\"mqtt\":%s,\"hardware\":false,\"state\":%u,\"generation\":%u,\"rotation_id\":\"%s\",\"certificate_fingerprint\":\"%s\",\"public_key_fingerprint\":\"%s\",\"pending_public_key_fingerprint\":\"%s\",\"proof\":\"%s\",\"certificate_expired\":%s,\"recovery_origin\":%u}\n", code(result), code(second), fingerprint, writes, commits, zero_output ? "true" : "false", mqtt ? "true" : "false", status.state, status.generation, status.rotation_id, status.certificate_fingerprint, status.public_key_fingerprint, status.pending_public_key_fingerprint, proof, status.certificate_expired ? "true" : "false", status.recovery_origin);
    li_espidf_identity_close(identity);
    OPENSSL_cleanse(root, sizeof(root)); OPENSSL_cleanse(private_key, sizeof(private_key));
    OPENSSL_cleanse(staged, sizeof(staged)); return 0;
}
