/* 安装前策略只消费独立本地信任与本机事实，不接受网关提供的设备快照。 */
#include "limeiot_ota.h"
#include "cJSON.h"
#include "ota_internal.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_IMAGE_BYTES UINT32_C(33554432)
#define MAX_UNIX_SECONDS INT64_C(253402300799)
static bool token(const char *value) {
    if (!value || !*value || strlen(value) > 128) return false;
    for (const char *p = value; *p; p++)
        if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') || strchr("-_.", *p))) return false;
    return true;
}
static bool hex_id(const char *value, const char *prefix) {
    size_t n = strlen(prefix);
    if (!value || strlen(value) != n + 64 || memcmp(value, prefix, n)) return false;
    for (size_t i = n; i < n + 64; i++)
        if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return false;
    return true;
}
bool li_ota_digest_valid(const char *value) { return hex_id(value, "sha256:"); }
static bool artifact(const char *value) { return hex_id(value, "artifact-"); }
static bool version_parts(const char *value, uint32_t parts[3]) {
    if (!value || !*value || strlen(value) > 32) return false;
    for (size_t i = 0; i < 3; i++) {
        const char *start = value; uint64_t part = 0;
        while (*value >= '0' && *value <= '9') {
            part = part * 10 + (unsigned)(*value++ - '0');
            if (part > UINT32_MAX) return false;
        }
        if (start == value || (value - start > 1 && *start == '0')) return false;
        parts[i] = (uint32_t)part;
        if (i < 2) { if (*value++ != '.') return false; }
        else if (*value) return false;
    }
    return true;
}
bool li_ota_version_valid(const char *value) { uint32_t parts[3]; return version_parts(value, parts); }
static int compare_version(const char *a, const char *b) {
    uint32_t left[3], right[3];
    if (!version_parts(a, left) || !version_parts(b, right)) return 0;
    for (size_t i = 0; i < 3; i++) if (left[i] != right[i]) return left[i] > right[i] ? 1 : -1;
    return 0;
}
static unsigned decimal(const char *p, size_t n) {
    unsigned value = 0;
    for (size_t i = 0; i < n; i++) { if (p[i] < '0' || p[i] > '9') return UINT32_MAX; value = value * 10 + (unsigned)(p[i] - '0'); }
    return value;
}
bool li_ota_time_parse(const char *value, int64_t *result) {
    if (!value || strlen(value) != 20 || value[4] != '-' || value[7] != '-' || value[10] != 'T'
        || value[13] != ':' || value[16] != ':' || value[19] != 'Z') return false;
    unsigned y = decimal(value, 4), m = decimal(value+5, 2), d = decimal(value+8, 2);
    unsigned h = decimal(value+11, 2), min = decimal(value+14, 2), s = decimal(value+17, 2);
    if (y < 1970 || y > 9999 || m < 1 || m > 12 || h > 23 || min > 59 || s > 59) return false;
    static const unsigned days[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    bool leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    if (!d || d > days[m-1] + (m == 2 && leap ? 1U : 0U)) return false;
    unsigned prior = y-1;
    int64_t total = INT64_C(365)*(y-1970) + prior/4-prior/100+prior/400 - (1969/4-1969/100+1969/400);
    for (unsigned i = 1; i < m; i++) total += days[i-1] + (i == 2 && leap ? 1U : 0U);
    *result = ((total+d-1)*24+h)*3600+min*60+s; return true;
}
/* 规范IPv6只接受WHATWG/RFC5952的最左最长零段压缩、小写十六进制形式。 */
static bool ipv6(const char *text, size_t length) {
    uint16_t words[8] = {0}; size_t count = 0, i = 0; int gap = -1;
    if (!length || length > 39) return false;
    if (text[0] == ':') {
        if (length < 2 || text[1] != ':') return false;
        gap = 0; i = 2;
    }
    while (i < length) {
        if (count == 8) return false;
        size_t start = i; unsigned word = 0;
        while (i < length && text[i] != ':') {
            unsigned char ch = (unsigned char)text[i++]; unsigned digit;
            if (ch >= '0' && ch <= '9') digit = ch-'0';
            else if (ch >= 'a' && ch <= 'f') digit = ch-'a'+10;
            else return false;
            if (i-start > 4) return false;
            word = word*16+digit;
        }
        if (i == start) return false;
        words[count++] = (uint16_t)word;
        if (i < length) {
            i++;
            if (i < length && text[i] == ':') {
                if (gap >= 0) return false;
                gap = (int)count; i++;
            } else if (i == length) return false;
        }
    }
    if (gap >= 0) {
        if (count >= 8) return false;
        size_t zeros = 8-count;
        memmove(words+gap+zeros, words+gap, (count-(size_t)gap)*sizeof(words[0]));
        memset(words+gap, 0, zeros*sizeof(words[0]));
    } else if (count != 8) return false;
    size_t best = 8, best_size = 1;
    for (size_t p = 0; p < 8;) {
        if (words[p]) { p++; continue; }
        size_t start = p; while (p < 8 && !words[p]) p++;
        if (p-start > best_size) { best = start; best_size = p-start; }
    }
    char canonical[40] = {0}; size_t used = 0;
    for (size_t p = 0; p < 8;) {
        if (p == best) { canonical[used++] = ':'; canonical[used++] = ':'; p += best_size; }
        else {
            if (used && canonical[used-1] != ':') canonical[used++] = ':';
            int n = snprintf(canonical+used, sizeof(canonical)-used, "%x", (unsigned)words[p++]);
            if (n < 1 || (size_t)n >= sizeof(canonical)-used) return false;
            used += (size_t)n;
        }
    }
    return used == length && memcmp(canonical, text, length) == 0;
}
static bool host(const char *text, size_t length) {
    if (!length || length > 253) return false;
    if (text[0] == '[') return length > 2 && text[length-1] == ']' && ipv6(text+1, length-2);
    size_t last = 0;
    for (size_t i = 0; i < length; i++) {
        char c = text[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.')) return false;
        if (c == '.') last = i+1;
    }
    /* URL解析器会将末段数字的主机当IPv4，禁止八进制/十六进制/缩写形式。 */
    size_t end = length; if (text[end-1] == '.') end--;
    if (!end) return false;
    last = end; while (last && text[last-1] != '.') last--;
    bool numeric = last < end;
    for (size_t i = last; i < end; i++) if (text[i] < '0' || text[i] > '9') numeric = false;
    if (end-last >= 2 && text[last] == '0' && text[last+1] == 'x') return false;
    if (!numeric) return true;
    if (end != length) return false;
    size_t start = 0, parts = 0;
    while (start < end) {
        size_t stop = start; while (stop < end && text[stop] != '.') stop++;
        if (stop == start || stop-start > 3 || (stop-start > 1 && text[start] == '0') || decimal(text+start, stop-start) > 255) return false;
        parts++; start = stop+1;
    }
    return parts == 4;
}
static bool origin(const char *value) {
    if (!value || strlen(value) > 1023 || strncmp(value, "https://", 8)) return false;
    const char *authority = value+8, *port = NULL; size_t length = strlen(authority), host_length = length;
    if (!length) return false;
    if (*authority == '[') {
        const char *end = strchr(authority, ']'); if (!end) return false;
        host_length = (size_t)(end-authority)+1;
        if (end[1]) { if (end[1] != ':') return false; port = end+2; }
    } else {
        port = strchr(authority, ':');
        if (port) { host_length = (size_t)(port-authority); port++; }
    }
    if (!host(authority, host_length)) return false;
    if (port) {
        size_t n = strlen(port); unsigned number = n && n <= 5 ? decimal(port, n) : UINT32_MAX;
        if (!n || (n > 1 && *port == '0') || number > 65535 || number == 443) return false;
    }
    return true;
}
static bool download(const char *url, const li_ota_policy_t *policy) {
    if (!url || strlen(url) > 1024) return false;
    const char *path = NULL;
    for (size_t i = 0; i < policy->origin_count; i++) {
        size_t n = strlen(policy->download_origins[i]);
        if (strlen(url) > n && !memcmp(url, policy->download_origins[i], n) && url[n] == '/') { path = url+n; break; }
    }
    if (!path || !path[1]) return false;
    for (const char *p = path; *p; p++)
        if ((unsigned char)*p <= 32 || (unsigned char)*p > 126 || strchr("\\?#\"<>`{}", *p)) return false;
    /* WHATWG会规范化这些点路径；包括百分号编码的点，但不解码斜杠。 */
    for (const char *p = path+1; ; ) {
        const char *end = strchr(p, '/'); if (!end) end = p+strlen(p);
        size_t dots = 0; const char *q = p;
        while (q < end) {
            if (*q == '.') { dots++; q++; }
            else if (end-q >= 3 && q[0] == '%' && q[1] == '2' && (q[2] == 'e' || q[2] == 'E')) { dots++; q += 3; }
            else break;
        }
        if (q == end && (dots == 1 || dots == 2)) return false;
        if (!*end) break;
        p = end+1;
    }
    return true;
}
static bool local_list(const char *const *values, size_t count, size_t minimum, size_t maximum, bool (*check)(const char *)) {
    if (count < minimum || count > maximum || (count && !values)) return false;
    for (size_t i = 0; i < count; i++) {
        if (!check(values[i])) return false;
        for (size_t j = 0; j < i; j++) if (!strcmp(values[i], values[j])) return false;
    }
    return true;
}
static bool local_contains(const char *const *values, size_t count, const char *value) {
    for (size_t i = 0; i < count; i++) if (!strcmp(values[i], value)) return true;
    return false;
}
static const cJSON *field(const cJSON *root, const char *name) { return cJSON_GetObjectItemCaseSensitive(root, name); }
static const char *text(const cJSON *root, const char *name) {
    const cJSON *value = field(root, name); return cJSON_IsString(value) ? value->valuestring : NULL;
}
bool li_ota_object_fields(const cJSON *object, const char *const *names, size_t count) {
    if (!cJSON_IsObject(object) || (size_t)cJSON_GetArraySize(object) != count) return false;
    for (size_t i = 0; i < count; i++) if (!field(object, names[i])) return false;
    return true;
}
bool li_ota_uint32(const cJSON *value, uint32_t *result) {
    if (!cJSON_IsNumber(value) || value->valuedouble < 0 || value->valuedouble > UINT32_MAX || (double)(uint32_t)value->valuedouble != value->valuedouble) return false;
    *result = (uint32_t)value->valuedouble; return true;
}
static bool json_list(const cJSON *values, bool (*check)(const char *)) {
    if (!cJSON_IsArray(values) || cJSON_GetArraySize(values) < 1 || cJSON_GetArraySize(values) > 16) return false;
    for (const cJSON *p = values->child; p; p = p->next) {
        if (!cJSON_IsString(p) || !check(p->valuestring)) return false;
        for (const cJSON *q = p->next; q; q = q->next)
            if (cJSON_IsString(q) && !strcmp(p->valuestring, q->valuestring)) return false;
    }
    return true;
}
static bool json_contains(const cJSON *values, const char *value) {
    for (const cJSON *p = values->child; p; p = p->next) if (!strcmp(p->valuestring, value)) return true;
    return false;
}
static bool policy_valid(const li_ota_policy_t *policy) {
    return policy && local_list(policy->product_ids, policy->product_count, 1, 16, token)
        && local_list(policy->download_origins, policy->origin_count, 1, 8, origin)
        && local_list(policy->revoked_artifact_ids, policy->revoked_count, 0, 128, artifact)
        && policy->minimum_battery_percent <= 100 && policy->not_before >= 0 && policy->not_before < policy->expires_at
        && policy->expires_at <= MAX_UNIX_SECONDS;
}
li_error_t li_ota_policy_validate(const li_ota_crypto_t *crypto, const li_ota_policy_t *policy) {
    return policy_valid(policy) && li_ota_key_validate(crypto, policy->key) == LI_OK ? LI_OK : LI_INVALID;
}
struct li_ota_trust {
    cJSON *document;
    li_ota_key_t key;
    li_ota_policy_t policy;
    const char *products[16], *origins[8], *revoked[128];
};
static bool read_array(const cJSON *root, const char *name, const char **out, size_t maximum, size_t *count) {
    const cJSON *array = field(root, name);
    if (!cJSON_IsArray(array) || (size_t)cJSON_GetArraySize(array) > maximum) return false;
    *count = 0;
    for (const cJSON *p = array->child; p; p = p->next) {
        if (!cJSON_IsString(p)) return false;
        out[(*count)++] = p->valuestring;
    }
    return true;
}
li_error_t li_ota_trust_decode(const li_ota_crypto_t *crypto, const char *json, size_t length, li_ota_trust_t **out) {
    if (!out) return LI_INVALID;
    *out = NULL;
    cJSON *root = li_ota_document_parse(json, length);
    if (!root) return LI_INVALID;
    li_ota_trust_t *trust = calloc(1, sizeof(*trust));
    if (!trust) { cJSON_Delete(root); return LI_CAPACITY; }
    trust->document = root;
    static const char *const fields[] = {"schema","version","purpose","signing_key_id","public_key","product_ids","download_origins",
        "minimum_security_epoch","minimum_battery_percent","revoked_artifact_ids","not_before","expires_at"};
    const char *schema = text(root,"schema"), *purpose = text(root,"purpose");
    uint32_t revision = 0, battery = 0;
    trust->policy.key = &trust->key;
    trust->policy.product_ids = trust->products; trust->policy.download_origins = trust->origins; trust->policy.revoked_artifact_ids = trust->revoked;
    if (!li_ota_object_fields(root, fields, 12) || !schema || strcmp(schema,"limeiot.ota-trust") || !purpose || strcmp(purpose,"device-firmware")
        || !li_ota_uint32(field(root,"version"), &revision) || revision != 1
        || li_ota_key_decode(crypto, text(root,"public_key"), text(root,"signing_key_id"), &trust->key) != LI_OK
        || !li_ota_uint32(field(root,"minimum_security_epoch"), &trust->policy.minimum_security_epoch)
        || !li_ota_uint32(field(root,"minimum_battery_percent"), &battery) || battery > 100
        || !li_ota_time_parse(text(root,"not_before"), &trust->policy.not_before) || !li_ota_time_parse(text(root,"expires_at"), &trust->policy.expires_at)
        || !read_array(root,"product_ids",trust->products,16,&trust->policy.product_count)
        || !read_array(root,"download_origins",trust->origins,8,&trust->policy.origin_count)
        || !read_array(root,"revoked_artifact_ids",trust->revoked,128,&trust->policy.revoked_count)) {
        li_ota_trust_destroy(trust); return LI_INVALID;
    }
    trust->policy.minimum_battery_percent = (uint8_t)battery;
    if (!policy_valid(&trust->policy)) { li_ota_trust_destroy(trust); return LI_INVALID; }
    *out = trust; return LI_OK;
}
const li_ota_policy_t *li_ota_trust_policy(const li_ota_trust_t *trust) { return trust ? &trust->policy : NULL; }
void li_ota_trust_destroy(li_ota_trust_t *trust) { if (trust) { cJSON_Delete(trust->document); free(trust); } }
li_error_t li_ota_preflight(const li_ota_crypto_t *crypto, const li_ota_policy_t *policy, const li_ota_environment_t *environment,
                          const char *json, size_t length, li_ota_candidate_t *result, const char **issue) {
    if (issue) *issue = "invalid_ota_policy";
    if (!result) return LI_INVALID;
    memset(result, 0, sizeof(*result));
    if (!policy_valid(policy) || !environment || !environment->identity || !environment->read_device_info || !environment->trusted_unix_seconds) return LI_INVALID;
    li_ota_candidate_t candidate = {0};
    li_error_t error = li_ota_authenticate(crypto, policy->key, json, length, &candidate.authentication);
    if (error != LI_OK) { if (issue) *issue = "invalid_ota_signature"; return error; }
    cJSON *root = cJSON_ParseWithLength(json, length);
    if (!root) { if (issue) *issue = "invalid_ota_manifest"; return LI_CAPACITY; }
    const char *code = "invalid_ota_manifest"; error = LI_INVALID;
    const cJSON *s = field(root, "statement"), *target = field(s, "target"), *compat = field(s, "compatibility"), *source = field(s, "download");
    static const char *const statement_fields[] = {"artifact_id","kind","target","version","compatibility","size_bytes","sha256","security_epoch","download","issued_at","expires_at"};
    static const char *const target_fields[] = {"product_id","architecture","chip","board","hardware_revisions"};
    static const char *const compatibility_fields[] = {"protocol_version","model_revisions","minimum_bootloader_version","from_versions"};
    static const char *const source_fields[] = {"url","redirects"};
    const char *artifact_id = text(s, "artifact_id"), *kind = text(s, "kind"), *target_version = text(s, "version"), *sha = text(s, "sha256");
    if (!li_ota_object_fields(s, statement_fields, 11) || !artifact(artifact_id) || !kind || strcmp(kind, "device-firmware") || !li_ota_version_valid(target_version)
        || !li_ota_digest_valid(sha) || !li_ota_uint32(field(s, "size_bytes"), &candidate.size_bytes) || !candidate.size_bytes || candidate.size_bytes > MAX_IMAGE_BYTES
        || !li_ota_uint32(field(s, "security_epoch"), &candidate.security_epoch)
        || !li_ota_time_parse(text(s, "issued_at"), &candidate.issued_at) || !li_ota_time_parse(text(s, "expires_at"), &candidate.expires_at)) goto finish;
    code = "invalid_ota_target";
    if (!li_ota_object_fields(target, target_fields, 5) || !token(text(target, "product_id")) || !token(text(target, "architecture"))
        || !token(text(target, "chip")) || !token(text(target, "board")) || !json_list(field(target, "hardware_revisions"), token)) goto finish;
    code = "invalid_ota_compatibility"; uint32_t protocol = 0;
    if (!li_ota_object_fields(compat, compatibility_fields, 4) || !li_ota_uint32(field(compat, "protocol_version"), &protocol) || protocol != 1
        || !li_ota_version_valid(text(compat, "minimum_bootloader_version")) || !json_list(field(compat, "model_revisions"), li_ota_digest_valid)
        || !json_list(field(compat, "from_versions"), li_ota_version_valid)) goto finish;
    for (const cJSON *p = field(compat, "from_versions")->child; p; p = p->next)
        if (compare_version(p->valuestring, target_version) >= 0) goto finish;
    code = "untrusted_ota_download";
    if (!li_ota_object_fields(source, source_fields, 2) || !cJSON_IsFalse(field(source, "redirects")) || !download(text(source, "url"), policy)) goto finish;
    code = "invalid_ota_validity";
    if (policy->not_before > candidate.issued_at || candidate.issued_at >= candidate.expires_at || candidate.expires_at > policy->expires_at) goto finish;
    code = "ota_artifact_revoked";
    if (local_contains(policy->revoked_artifact_ids, policy->revoked_count, artifact_id)) goto finish;
    code = "untrusted_ota_product";
    if (!local_contains(policy->product_ids, policy->product_count, text(target, "product_id"))) goto finish;
    /* 密码学和结构检查后，再读取当前本机事实及认证时间，不复用先前网络快照。 */
    li_device_info_t info = {0}; const li_config_t *identity = environment->identity;
    code = "ota_device_unavailable"; error = LI_DRIVER;
    if (!environment->read_device_info(environment->context, &info)) goto finish;
    code = "invalid_ota_device"; error = LI_INVALID;
    if (!token(identity->device_id) || !token(identity->hardware_revision) || !li_ota_version_valid(identity->firmware_version) || !li_ota_digest_valid(identity->model_revision)
        || !token(info.product_id) || !token(info.architecture) || !token(info.chip) || !token(info.board) || !li_ota_version_valid(info.bootloader_version)
        || !info.ota_capacity_bytes || info.ota_capacity_bytes > MAX_IMAGE_BYTES || (info.has_battery && info.battery_percent > 100)) goto finish;
    int64_t now = -1; code = "clock_untrusted"; error = LI_CLOCK;
    if (!environment->trusted_unix_seconds(environment->context, &now) || now < 0 || now > MAX_UNIX_SECONDS) goto finish;
    error = LI_EXPIRED; code = "ota_outside_validity";
    if (now < candidate.issued_at || now >= candidate.expires_at) goto finish;
    error = LI_INVALID; code = "ota_target_mismatch";
    if (strcmp(text(target, "product_id"), info.product_id) || strcmp(text(target, "architecture"), info.architecture)
        || strcmp(text(target, "chip"), info.chip) || strcmp(text(target, "board"), info.board)
        || !json_contains(field(target, "hardware_revisions"), identity->hardware_revision)) goto finish;
    code = "ota_device_incompatible";
    if (!json_contains(field(compat, "model_revisions"), identity->model_revision)
        || !json_contains(field(compat, "from_versions"), identity->firmware_version)
        || compare_version(info.bootloader_version, text(compat, "minimum_bootloader_version")) < 0) goto finish;
    code = "ota_downgrade_forbidden";
    if (candidate.security_epoch < policy->minimum_security_epoch || candidate.security_epoch < info.security_epoch
        || compare_version(target_version, identity->firmware_version) <= 0) goto finish;
    code = "ota_partition_too_small"; error = LI_CAPACITY;
    if (candidate.size_bytes > info.ota_capacity_bytes) goto finish;
    code = "ota_insufficient_power"; error = LI_CONFLICT;
    if (!info.external_power && (!info.has_battery || info.battery_percent < policy->minimum_battery_percent)) goto finish;
    code = "ota_device_busy";
    if (!info.safe_to_update || info.pending_update) goto finish;
    memcpy(candidate.artifact_id, artifact_id, sizeof(candidate.artifact_id));
    strcpy(candidate.version, target_version); memcpy(candidate.image_sha256, sha, sizeof(candidate.image_sha256));
    strcpy(candidate.download_url, text(source, "url"));
    *result = candidate; error = LI_OK; code = "ok";
finish:
    cJSON_Delete(root); if (issue) *issue = code; return error;
}
