/* 固件同一核心的宿主端口。只允许回环 MQTT；虚拟驱动不是硬件验收证据。 */
#include "limeiot.h"
#include "limeiot_ota_device.h"
#include "ota_host_crypto.h"
#include "ota_transfer_fixture.h"
#include "lamp.h"
#include "button.h"
#include "cJSON.h"
#include <mosquitto.h>
#include <mqtt_protocol.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

typedef struct {
    struct mosquitto *mqtt;
    li_core_t *core;
    li_ota_log_t *ota_log;
    li_ota_trust_t *ota_trust;
    const char *running_fault;
    cJSON *installer_plan;
    bool installer_current, installer_power_lost, installer_clock_lost, ota_fail_after;
    li_ota_policy_t installer_policy;
    const char *installer_revoked[1];
    char installer_revoked_id[74], current_version[33];
    const char *boot_mode;
    uint32_t current_epoch;
    const li_config_t *config;
    char directory[PATH_MAX];
    bool power, button, connected, ota_eligible;
    int64_t brightness;
    unsigned store_calls, fail_store;
    unsigned ota_store_calls, ota_fail_store, drop_ota_results;
} host_t;
static volatile sig_atomic_t stopping;
static void stop_signal(int signal) { (void)signal; stopping = 1; }
static bool random_bytes(void *context, uint8_t *bytes, size_t length) { (void)context; return RAND_bytes(bytes, (int)length) == 1; }
static int64_t monotonic(void *context) { (void)context; struct timespec now; if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1; return (int64_t)now.tv_sec * 1000 + now.tv_nsec/1000000; }
static bool sha256(void *context, const uint8_t *data, size_t length, uint8_t result[32]) { (void)context; unsigned size; return EVP_Digest(data, length, result, &size, EVP_sha256(), NULL) == 1 && size == 32; }
static bool storage_read(void *context, unsigned slot, char *data, size_t capacity, size_t *length, bool *found) {
    host_t *host = context; char path[PATH_MAX];
    if (snprintf(path, sizeof(path), "%s/receipt-%u.json", host->directory, slot) >= (int)sizeof(path)) return false;
    int fd = open(path, O_RDONLY | O_NOFOLLOW);
    if (fd < 0) { *found = false; return errno == ENOENT; }
    struct stat metadata;
    if (fstat(fd, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_size < 0 || (uint64_t)metadata.st_size >= capacity) { close(fd); return false; }
    ssize_t size = read(fd, data, capacity); close(fd);
    if (size < 0 || size != metadata.st_size) return false;
    *length = (size_t)size; *found = true; return true;
}
static bool durable_file(host_t *host, const char *name, const char *data, size_t length) {
    char path[PATH_MAX], temporary[PATH_MAX];
    if (snprintf(path, sizeof(path), "%s/%s", host->directory, name) >= (int)sizeof(path) || snprintf(temporary, sizeof(temporary), "%s/.%s.tmp", host->directory, name) >= (int)sizeof(temporary)) return false;
    int fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600); if (fd < 0) return false;
    bool written = write(fd, data, length) == (ssize_t)length && fsync(fd) == 0;
    if (close(fd) != 0) written = false;
    if (!written || rename(temporary, path) != 0) return false;
    int directory = open(host->directory, O_RDONLY); if (directory < 0) return false;
    written = fsync(directory) == 0; close(directory); return written;
}
static bool storage_write(void *context, unsigned slot, const char *data, size_t length) {
    host_t *host = context; host->store_calls++;
    if (host->store_calls == host->fail_store) return false;
    char name[40]; snprintf(name, sizeof(name), "receipt-%u.json", slot); return durable_file(host, name, data, length);
}
static bool ota_read(void *context, char *data, size_t capacity, size_t *length, bool *found) {
    host_t *host=context; char path[PATH_MAX];
    if (snprintf(path,sizeof(path),"%s/ota.json",host->directory)>=(int)sizeof(path)) return false;
    FILE *file=fopen(path,"rb"); if (!file) { *found=false; *length=0; return errno==ENOENT; }
    *found=true; *length=fread(data,1,capacity,file); bool ok=!ferror(file)&&fgetc(file)==EOF; fclose(file); return ok;
}
static bool ota_write(void *context, const char *data, size_t length) {
    host_t *host=context; host->ota_store_calls++;
    if (!host->ota_fail_after&&host->ota_fail_store&&host->ota_store_calls==host->ota_fail_store) return false;
    bool saved=durable_file(context,"ota.json",data,length);
    return saved&&!(host->ota_fail_after&&host->ota_fail_store&&host->ota_store_calls==host->ota_fail_store);
}
static bool ota_seconds(void *context, int64_t *now) { host_t *host=context; *now=(int64_t)time(NULL); return !host->installer_clock_lost&&*now>=0; }
static bool ota_milliseconds(void *context, int64_t *now) { struct timespec time; (void)context; if (clock_gettime(CLOCK_REALTIME,&time)) return false; *now=(int64_t)time.tv_sec*1000+time.tv_nsec/1000000; return true; }
static cJSON *host_json(host_t *host, const char *name) {
    char path[PATH_MAX], raw[8192]; if (snprintf(path,sizeof(path),"%s/%s",host->directory,name)>=(int)sizeof(path)) return NULL;
    FILE *file=fopen(path,"rb"); if (!file) return NULL;
    size_t size=fread(raw,1,sizeof(raw),file); bool ok=!ferror(file)&&fgetc(file)==EOF; fclose(file);
    return ok?cJSON_ParseWithLength(raw,size):NULL;
}
static bool staged_hash(host_t *host, uint32_t size, char output[72]) {
    char path[PATH_MAX]; if (snprintf(path,sizeof(path),"%s/staged.bin",host->directory)>=(int)sizeof(path)) return false;
    FILE *file=fopen(path,"rb"); if (!file) return false;
    EVP_MD_CTX *hash_context=EVP_MD_CTX_new(); bool ok=hash_context&&EVP_DigestInit_ex(hash_context,EVP_sha256(),NULL)==1;
    uint8_t buffer[1024], digest[32]; uint32_t total=0; unsigned digest_size=0;
    while (ok&&total<size) {
        size_t bytes=size-total; if (bytes>sizeof(buffer)) bytes=sizeof(buffer);
        ok=fread(buffer,1,bytes,file)==bytes&&EVP_DigestUpdate(hash_context,buffer,bytes)==1; total+=(uint32_t)bytes;
    }
    ok=ok&&fgetc(file)==EOF&&!ferror(file)&&EVP_DigestFinal_ex(hash_context,digest,&digest_size)==1&&digest_size==32;
    EVP_MD_CTX_free(hash_context); fclose(file); if (!ok) return false;
    strcpy(output,"sha256:"); for (size_t i=0;i<32;i++) snprintf(output+7+2*i,3,"%02x",digest[i]); return true;
}
static bool ota_running(void *context, li_ota_baseline_t *out, bool *pending) {
    host_t *host=context; uint8_t digest[32];
    if (host->running_fault&&!strcmp(host->running_fault,"unavailable")) return false;
    /* 仅代表宿主夹具的固定运行字节，不冒充ESP固件镜像。 */
    static const char image[]="LimeIoT host running image fixture\n";
    if (!sha256(NULL,(const uint8_t *)image,sizeof(image)-1,digest)) return false;
    if (host->running_fault&&!strcmp(host->running_fault,"changed")) digest[0]^=1;
    memset(out,0,sizeof(*out)); strcpy(out->firmware_version,host->config->firmware_version); out->security_epoch=host->current_epoch; strcpy(out->image_sha256,"sha256:");
    for (size_t i=0;i<32;i++) snprintf(out->image_sha256+7+2*i,3,"%02x",digest[i]);
    if (host->boot_mode&&!strcmp(host->boot_mode,"target")) {
        cJSON *selection=host_json(host,"boot-selection.json");
        double size=cJSON_GetNumberValue(cJSON_GetObjectItemCaseSensitive(selection,"size"));
        bool ok=size>0&&size<=UINT32_MAX&&staged_hash(host,(uint32_t)size,out->image_sha256); cJSON_Delete(selection);
        if (!ok) return false;
    }
    *pending=(host->running_fault&&!strcmp(host->running_fault,"pending"))||(host->boot_mode&&!strcmp(host->boot_mode,"pending")); return true;
}
static bool publish(void *context, const char *topic, const char *data, size_t length) {
    host_t *host = context;
    if (strstr(topic,"/up/ota_result")&&host->drop_ota_results) { host->drop_ota_results--; return false; }
    return mosquitto_publish_v5(host->mqtt, NULL, topic, (int)length, data, 1, false, NULL) == MOSQ_ERR_SUCCESS;
}
static bool read_property(void *context, const char *path, li_value_t *value) {
    host_t *host = context; memset(value, 0, sizeof(*value));
    if (strcmp(path, "light.power") == 0) { value->type = LI_BOOLEAN; value->boolean = host->power; return true; }
    if (strcmp(path, "light.brightness") == 0) { value->type = LI_INTEGER; value->integer = host->brightness; return true; }
    return false;
}
static li_apply_result_t write_property(void *context, const char *path, li_value_t value) {
    host_t *host = context; bool power = host->power; int64_t brightness = host->brightness;
    if (strcmp(path, "light.power") == 0) power = value.boolean; else if (strcmp(path, "light.brightness") == 0) brightness = value.integer; else return LI_NOT_APPLIED;
    char state[128]; int size = snprintf(state, sizeof(state), "{\"power\":%s,\"brightness\":%lld}", power ? "true" : "false", (long long)brightness);
    if (size < 0 || !durable_file(host, "hardware.json", state, (size_t)size)) return LI_EXECUTION_UNKNOWN;
    host->power = power; host->brightness = brightness; return LI_APPLIED;
}
static bool read_device_info(void *context, li_device_info_t *info) {
    host_t *host = context;
    /* 测试端口报告虚拟容量，不能与 ESP 芯片或板卡身份混用。 */
    *info = (li_device_info_t){
        .product_id = host->button ? "desk-node-button-host" : "desk-node-lamp-host",
        .architecture = "native", .chip = "host", .board = "host-fixture",
        .bootloader_version = "0.0.1", .security_epoch = host->current_epoch, .ota_capacity_bytes = 1966080,
        .external_power = !host->installer_power_lost, .safe_to_update = host->ota_eligible,
        .pending_update = host->boot_mode&&!strcmp(host->boot_mode,"pending"),
    };
    return true;
}
/* 可选宿主安装夹具：真实HTTPS/文件传输，激活与重启只写测试审计，不操作宿主启动。 */
static bool installer_audit(host_t *host, const char *event) {
    char *raw=malloc(LI_OTA_LOG_BYTES); size_t size=0; bool found=false;
    if (!raw || !ota_read(host,raw,LI_OTA_LOG_BYTES,&size,&found) || !found) { free(raw); return false; }
    cJSON *item=cJSON_CreateObject(), *log=cJSON_ParseWithLength(raw,size); free(raw);
    if (!item || !log) { cJSON_Delete(item); cJSON_Delete(log); return false; }
    cJSON_AddStringToObject(item,"event",event); cJSON_AddItemToObject(item,"journal",log);
    char *line=cJSON_PrintUnformatted(item); cJSON_Delete(item); if (!line) return false;
    char filename[PATH_MAX]; int n=snprintf(filename,sizeof(filename),"%s/installer.ndjson",host->directory);
    int fd=n>0&&(size_t)n<sizeof(filename)?open(filename,O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW,0600):-1;
    bool ok=fd>=0&&write(fd,line,strlen(line))==(ssize_t)strlen(line)&&write(fd,"\n",1)==1&&fsync(fd)==0;
    if (fd>=0) close(fd);
    free(line); return ok;
}
static bool installer_current(void *context) { host_t *host=context; return host->connected&&host->installer_current; }
static bool installer_read(void *context, uint8_t *data, size_t capacity, size_t *received, bool *complete) {
    transfer_host_t *transfer=context; host_t *host=transfer->owner;
    bool ok=read_http(transfer,data,capacity,received,complete);
    if (ok&&*received) {
        if (transfer_fault(transfer,"disconnect-read")) host->installer_current=false;
        if (transfer_fault(transfer,"power-read")) host->installer_power_lost=true;
        if (transfer_fault(transfer,"clock-read")) host->installer_clock_lost=true;
        if (transfer_fault(transfer,"revoke-read")) {
            host->installer_policy.revoked_artifact_ids=host->installer_revoked;
            host->installer_policy.revoked_count=1;
        }
    }
    return ok;
}
static li_error_t installer_stage(void *context, const li_ota_candidate_t *candidate, const li_ota_transfer_guard_t *guard,
                                 li_ota_transfer_result_t *result, const char **issue) {
    host_t *host=context; char filename[PATH_MAX];
    if (!installer_audit(host,"stage") || snprintf(filename,sizeof(filename),"%s/staged.bin",host->directory)>=(int)sizeof(filename)) return LI_STORAGE;
    strcpy(host->installer_revoked_id,candidate->artifact_id); host->installer_revoked[0]=host->installer_revoked_id;
    transfer_host_t transfer={.owner=host,.plan=host->installer_plan,.path=filename,.fault=transfer_text(host->installer_plan,"fault"),.socket=-1,.file=-1};
    li_ota_source_t source={&transfer,open_http,installer_read,close_http}; li_ota_sink_t sink={&transfer,begin_image,write_image,finish_image,read_image,abort_image};
    li_ota_hash_stream_t hash_stream={&transfer,begin_hash,update_hash,finish_hash,abort_hash};
    li_error_t error=li_ota_transfer_run(candidate,&source,&sink,&hash_stream,guard,result,issue);
    if (transfer.file>=0) close(transfer.file);
    const char *fault=transfer_text(host->installer_plan,"fault");
    if (fault&&!strcmp(fault,"disconnect-stage")) host->installer_current=false;
    if (fault&&!strcmp(fault,"unverified")) result->image_verified=false;
    return error;
}
static bool installer_activate(void *context, const li_ota_candidate_t *candidate, const li_ota_transfer_guard_t *guard, char binding[LI_OTA_LOG_ID_SIZE]) {
    host_t *host=context; const char *fault=transfer_text(host->installer_plan,"fault");
    if (!guard->authorize(guard->context) || !installer_audit(host,"activate")) return false;
    if (fault&&!strcmp(fault,"activation-before")) return false;
    uint8_t random[16]; if (RAND_bytes(random,sizeof(random))!=1) return false;
    strcpy(binding,"host_"); for (size_t i=0;i<sizeof(random);i++) snprintf(binding+5+2*i,3,"%02x",random[i]);
    cJSON *selection=cJSON_CreateObject();
    cJSON_AddStringToObject(selection,"binding",binding); cJSON_AddStringToObject(selection,"version",candidate->version);
    cJSON_AddStringToObject(selection,"sha256",candidate->image_sha256); cJSON_AddNumberToObject(selection,"size",candidate->size_bytes);
    cJSON_AddNumberToObject(selection,"epoch",candidate->security_epoch);
    char *raw=cJSON_PrintUnformatted(selection); cJSON_Delete(selection);
    bool saved=raw&&durable_file(host,"boot-selection.json",raw,strlen(raw)); free(raw);
    if (!saved||!installer_audit(host,"selected")) return false;
    return !fault||strcmp(fault,"activation-after");
}
static bool installer_observe(void *context, const li_ota_log_view_t *view, li_ota_stage_t *stage, li_ota_outcome_t *outcome) {
    host_t *host=context; if (!host->boot_mode) return false;
    cJSON *selection=host_json(host,"boot-selection.json"); char digest[72]; bool ok=false;
    const char *token=cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(selection,"binding"));
    const char *version=cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(selection,"version"));
    const char *expected=cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(selection,"sha256"));
    if (!token||strcmp(token,view->boot_binding)||!version||strcmp(version,view->target_version)||!expected||strcmp(expected,view->target_image_sha256)
        ||cJSON_GetNumberValue(cJSON_GetObjectItemCaseSensitive(selection,"size"))!=view->target_size_bytes
        ||cJSON_GetNumberValue(cJSON_GetObjectItemCaseSensitive(selection,"epoch"))!=view->target_security_epoch
        ||!staged_hash(host,view->target_size_bytes,digest)||strcmp(digest,view->target_image_sha256)) goto finish;
    memset(outcome,0,sizeof(*outcome));
    if (!strcmp(host->boot_mode,"target")||!strcmp(host->boot_mode,"target-native-prefix")) {
        *stage=LI_OTA_SUCCEEDED; strcpy(outcome->firmware_version,host->current_version);
        strcpy(outcome->image_sha256,digest); outcome->security_epoch=host->current_epoch; ok=true;
    } else if (!strcmp(host->boot_mode,"rollback")) {
        bool pending=true; li_ota_baseline_t baseline;
        if (!ota_running(host,&baseline,&pending)||pending||strcmp(baseline.firmware_version,view->baseline.firmware_version)
            ||strcmp(baseline.image_sha256,view->baseline.image_sha256)||baseline.security_epoch!=view->baseline.security_epoch) goto finish;
        *stage=LI_OTA_ROLLED_BACK; strcpy(outcome->firmware_version,baseline.firmware_version); strcpy(outcome->image_sha256,baseline.image_sha256);
        outcome->security_epoch=baseline.security_epoch; strcpy(outcome->error,"ota_boot_rolled_back"); ok=true;
    }
finish:
    cJSON_Delete(selection); return ok;
}
static void installer_restart(void *context) { (void)installer_audit(context,"restart"); }
static void on_connect(struct mosquitto *mqtt, void *context, int reason, int flags, const mosquitto_property *properties) {
    (void)flags; (void)properties; host_t *host = context;
    if (reason != MQTT_RC_SUCCESS) { stopping = 1; return; }
    char topic[256]; snprintf(topic, sizeof(topic), "limeiot/v1/%s/%s/down/+", host->config->space_id, host->config->device_id);
    if (mosquitto_subscribe_v5(mqtt, NULL, topic, 1, MQTT_SUB_OPT_RETAIN_AS_PUBLISHED, NULL) != MOSQ_ERR_SUCCESS) stopping = 1;
}
static void on_subscribe(struct mosquitto *mqtt, void *context, int mid, int count, const int *granted, const mosquitto_property *properties) {
    (void)mqtt; (void)mid; (void)properties; host_t *host = context;
    if (count != 1 || granted[0] > 2 || li_connected(host->core) != LI_OK) { stopping = 1; return; }
    host->connected = true;
}
static void on_disconnect(struct mosquitto *mqtt, void *context, int reason, const mosquitto_property *properties) {
    (void)mqtt; (void)reason; (void)properties; host_t *host = context;
    host->connected = false; li_disconnected(host->core);
}
static void on_message(struct mosquitto *mqtt, void *context, const struct mosquitto_message *message, const mosquitto_property *properties) {
    (void)mqtt; (void)properties; host_t *host = context;
    li_error_t error = li_receive(host->core, message->topic, message->payload, (size_t)message->payloadlen, message->retain);
    if (error != LI_OK && error != LI_IGNORED) fprintf(stderr, "{\"event\":\"firmware.rejected\",\"code\":\"%s\"}\n", li_error_code(error));
}
int main(int argc, char **argv) {
    if (argc != 4 || (strcmp(argv[2], "lamp") != 0 && strcmp(argv[2], "button") != 0)) return 2;
    const char *broker = getenv("LIMEIOT_MQTT_HOST"), *password = getenv("LIMEIOT_MQTT_PASSWORD"), *port_text = getenv("LIMEIOT_MQTT_PORT");
    if (!broker || strcmp(broker, "127.0.0.1") != 0 || !password || !port_text) return 2;
    char *end; long port = strtol(port_text, &end, 10); if (*end || port < 1 || port > 65535) return 2;
    host_t host = {0}; host.button = strcmp(argv[2], "button") == 0;
    if (strlen(argv[3]) >= sizeof(host.directory)) return 2;
    strcpy(host.directory, argv[3]); if (mkdir(host.directory, 0700) != 0 && errno != EEXIST) return 2;
    struct stat directory; if (lstat(host.directory, &directory) != 0 || !S_ISDIR(directory.st_mode)) return 2;
    strcpy(host.current_version,"0.1.0"); host.boot_mode=getenv("LIMEIOT_FIRMWARE_OTA_BOOT");
    if (host.boot_mode&&(!strcmp(host.boot_mode,"target")||!strcmp(host.boot_mode,"target-native-prefix")||!strcmp(host.boot_mode,"pending"))) {
        cJSON *selection=host_json(&host,"boot-selection.json");
        const char *version=cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(selection,"version"));
        double epoch=cJSON_GetNumberValue(cJSON_GetObjectItemCaseSensitive(selection,"epoch"));
        if (!version||strlen(version)>=sizeof(host.current_version)||epoch<0||epoch>UINT32_MAX) { cJSON_Delete(selection); return 2; }
        strcpy(host.current_version,version); host.current_epoch=(uint32_t)epoch; cJSON_Delete(selection);
    }
    li_config_t config = {"space-demo", argv[1], host.button ? LI_BUTTON_REVISION : LI_LAMP_REVISION, host.current_version, "host-fixture", host.button ? NULL : LI_LAMP_PROPERTIES, host.button ? 0 : LI_LAMP_PROPERTY_COUNT, host.button ? LI_BUTTON_EVENTS : NULL, host.button ? LI_BUTTON_EVENT_COUNT : 0, "host-fixture"};
    host.config = &config;
    host.running_fault=getenv("LIMEIOT_FIRMWARE_RUNNING_FAULT");
    /* 仅限显式宿主夹具，测试预检通过但缺安装提供方的拒绝路径。 */
    const char *eligible=getenv("LIMEIOT_FIRMWARE_OTA_ELIGIBLE"); host.ota_eligible=eligible&&!strcmp(eligible,"1");
    const char *ota_failure=getenv("LIMEIOT_FIRMWARE_OTA_FAIL_STORE"); if (ota_failure) host.ota_fail_store=(unsigned)strtoul(ota_failure,NULL,10);
    const char *after=getenv("LIMEIOT_FIRMWARE_OTA_FAIL_AFTER_STORE"); host.ota_fail_after=after&&!strcmp(after,"1");
    const char *drop_ota=getenv("LIMEIOT_FIRMWARE_DROP_OTA_RESULTS"); if (drop_ota) host.drop_ota_results=(unsigned)strtoul(drop_ota,NULL,10);
    char state_path[PATH_MAX]; snprintf(state_path, sizeof(state_path), "%s/hardware.json", host.directory);
    FILE *state = fopen(state_path, "rb");
    if (state) { char data[128]; size_t count = fread(data, 1, sizeof(data)-1, state); fclose(state); data[count] = '\0'; cJSON *json = cJSON_Parse(data); if (!json) return 2; cJSON *power = cJSON_GetObjectItemCaseSensitive(json, "power"), *brightness = cJSON_GetObjectItemCaseSensitive(json, "brightness"); if (!cJSON_IsBool(power) || !cJSON_IsNumber(brightness) || brightness->valuedouble < 0 || brightness->valuedouble > 100) { cJSON_Delete(json); return 2; } host.power = cJSON_IsTrue(power); host.brightness = brightness->valueint; cJSON_Delete(json); }
    const char *failure = getenv("LIMEIOT_FIRMWARE_FAIL_STORE"); if (failure) host.fail_store = (unsigned)strtoul(failure, NULL, 10);
    li_ports_t ports = {&host, random_bytes, monotonic, sha256, storage_read, storage_write, publish, read_property, write_property, read_device_info}; li_error_t error;
    host.core = li_core_create(&config, &ports, &error); if (!host.core) return 2;
    li_ota_crypto_t ota_crypto={NULL,hash,verify};
    const char *policy_file=getenv("LIMEIOT_FIRMWARE_OTA_POLICY");
    if (policy_file) {
        FILE *file=fopen(policy_file,"rb"); if (!file) return 2;
        char *raw=calloc(LI_MAX_PACKET+2,1); if (!raw) { fclose(file); return 2; }
        size_t bytes=fread(raw,1,LI_MAX_PACKET+1,file); bool valid=!ferror(file)&&bytes<=LI_MAX_PACKET; fclose(file);
        error=valid?li_ota_trust_decode(&ota_crypto,raw,bytes,&host.ota_trust):LI_INVALID; free(raw); if (error!=LI_OK) return 2;
    }
    li_ota_log_ports_t log_ports={&host,ota_read,ota_write,ota_milliseconds};
    host.ota_log=li_ota_log_open(&config,&ota_crypto,&log_ports,&error); if (!host.ota_log) return 2;
    const li_ota_policy_t *policy=li_ota_trust_policy(host.ota_trust);
    if (policy) host.installer_policy=*policy;
    li_ota_device_ports_t ota_ports={&host,ota_running,ota_seconds};
    if (li_ota_device_attach(host.core,host.ota_log,&ota_crypto,policy?&host.installer_policy:NULL,&ota_ports)!=LI_OK) return 2;
    li_ota_boot_observer_t observer={&host,installer_observe};
    if (li_ota_device_set_boot_observer(host.core,&observer)!=LI_OK) return 2;
    const char *installer_file=getenv("LIMEIOT_FIRMWARE_OTA_SOURCE");
    if (installer_file) {
        signal(SIGPIPE,SIG_IGN);
        FILE *file=fopen(installer_file,"rb"); if (!file) return 2;
        char raw[8192]; size_t bytes=fread(raw,1,sizeof(raw),file); bool ok=!ferror(file)&&fgetc(file)==EOF; fclose(file);
        host.installer_plan=ok?cJSON_ParseWithLength(raw,bytes):NULL; if (!host.installer_plan) return 2;
        host.installer_current=true; li_ota_installer_t installer={&host,installer_current,installer_stage,installer_activate,installer_restart};
        if (li_ota_device_set_installer(host.core,&installer)!=LI_OK) return 2;
    }
    mosquitto_lib_init(); host.mqtt = mosquitto_new(argv[1], true, &host); if (!host.mqtt) return 2;
    mosquitto_int_option(host.mqtt, MOSQ_OPT_PROTOCOL_VERSION, MQTT_PROTOCOL_V5);
    mosquitto_username_pw_set(host.mqtt, argv[1], password);
    mosquitto_connect_v5_callback_set(host.mqtt, on_connect); mosquitto_subscribe_v5_callback_set(host.mqtt, on_subscribe); mosquitto_disconnect_v5_callback_set(host.mqtt, on_disconnect); mosquitto_message_v5_callback_set(host.mqtt, on_message);
    signal(SIGINT, stop_signal); signal(SIGTERM, stop_signal);
    if (mosquitto_connect_bind_v5(host.mqtt, broker, (int)port, 10, NULL, NULL) != MOSQ_ERR_SUCCESS) stopping = 1;
    char input[1024]; size_t used = 0; bool stdin_open = true;
    while (!stopping) {
        int status = mosquitto_loop(host.mqtt, 50, 1);
        if (status != MOSQ_ERR_SUCCESS) { li_disconnected(host.core); host.connected = false; struct timespec delay = {0, 500000000}; nanosleep(&delay, NULL); mosquitto_reconnect(host.mqtt); }
        if (host.connected) (void)li_tick(host.core);
        struct pollfd descriptor = {STDIN_FILENO, POLLIN, 0};
        if (stdin_open && poll(&descriptor, 1, 0) > 0 && (descriptor.revents & (POLLIN | POLLHUP))) {
            char byte; ssize_t count = read(STDIN_FILENO, &byte, 1);
            if (count == 0) stdin_open = false;
            else if (count == 1 && byte == '\n') {
                input[used] = '\0'; used = 0; cJSON *json = cJSON_Parse(input);
                if (json) { cJSON *data = cJSON_GetObjectItemCaseSensitive(json, "data"), *value = cJSON_GetObjectItemCaseSensitive(data, "count"); if (host.button && cJSON_IsNumber(value)) (void)li_emit_event(host.core, "button.pressed", value->valueint); cJSON_Delete(json); }
            } else if (count == 1 && used < sizeof(input)-1) input[used++] = byte;
        }
    }
    mosquitto_disconnect(host.mqtt); mosquitto_destroy(host.mqtt); mosquitto_lib_cleanup(); li_core_destroy(host.core); li_ota_log_close(host.ota_log); li_ota_trust_destroy(host.ota_trust); cJSON_Delete(host.installer_plan); return 0;
}
