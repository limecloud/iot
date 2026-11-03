/* 直接运行生产ESP提供方；HTTP为真实回环HTTPS，分区/镜像验证/启动API为显式夹具。 */
#include "limeiot_espidf.h"
#include "ota_transfer.h"
#include "credential_window.h"
#include "esp_http_client.h"
#include "esp_image_format.h"
#include "bootloader_common.h"
#include "esp_rom_crc.h"
#include "psa/crypto.h"
#include "cJSON.h"
#include <openssl/ssl.h>
#include <openssl/pem.h>
#include <arpa/inet.h>
#include <assert.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static struct {
    cJSON *plan;
    const char *suite, *fault, *checkpoint, *invalidation;
    esp_partition_t app[2], data;
    esp_app_desc_t description[2];
    esp_ota_select_entry_t entries[2];
    int files[2]; unsigned running, chosen, written;
    uint32_t lengths[2];
    unsigned opens, reads, closes, cleanups, begins, writes, ends, aborts, partition_reads;
    unsigned metadata_reads, selections, image_checks, guard_calls, io_after_loss;
    bool active, trusted, injected, observed_loss;
    li_credential_window_t window;
} host;
struct li_test_http {
    esp_http_client_config_t config;
    SSL_CTX *tls; SSL *ssl; int socket, status;
    bool encoding_header, connection_header, complete;
};
static const char *text(const char *name) { return cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(host.plan,name)); }
static bool fault(const char *name) { return !strcmp(host.fault,name); }
static bool suite(const char *name) { return !strcmp(host.suite,name); }
#ifdef LI_ESP_NATIVE_INSTALL_HOST
static bool native_credentials_current(void);
static void native_checkpoint(const char *);
static void native_selection_saved(void);
#else
static int64_t monotonic(void *context) {
    (void)context; struct timespec now; assert(clock_gettime(CLOCK_MONOTONIC,&now)==0);
    return (int64_t)now.tv_sec*1000+now.tv_nsec/1000000;
}
static bool authorize(void *context) {
    (void)context; host.guard_calls++; return li_credential_window_check(&host.window,host.trusted);
}
#endif
static void io(void) {
#ifdef LI_ESP_NATIVE_INSTALL_HOST
    if ((suite("stage")||suite("activate"))&&!native_credentials_current()) host.io_after_loss++;
#else
    if (!li_credential_window_current(&host.window,host.trusted)) host.io_after_loss++;
#endif
}
static void inject(const char *where) {
#ifdef LI_ESP_NATIVE_INSTALL_HOST
    native_checkpoint(where);
#else
    if (host.injected||strcmp(host.checkpoint,where)) return;
    host.injected=true;
    if (!strcmp(host.invalidation,"clock")) host.trusted=false;
    else {
        int64_t started=monotonic(NULL); const struct timespec pause={.tv_nsec=10000000};
        while (li_credential_window_current(&host.window,true)&&monotonic(NULL)-started<7000) assert(nanosleep(&pause,NULL)==0);
    }
    host.observed_loss=!li_credential_window_current(&host.window,host.trusted);
#endif
}
static unsigned char *read_file(const char *name, size_t *size) {
    assert(name); FILE *file=fopen(name,"rb"); assert(file); assert(fseek(file,0,SEEK_END)==0);
    long length=ftell(file); assert(length>=0&&length<=1024*1024); rewind(file);
    unsigned char *data=calloc((size_t)length+1,1); assert(data);
    assert(fread(data,1,(size_t)length,file)==(size_t)length&&!ferror(file)); assert(fclose(file)==0);
    *size=(size_t)length; return data;
}
static void store(const char *folder, const char *name, const void *data, size_t size) {
    char path[4096]; assert(snprintf(path,sizeof(path),"%s/%s",folder,name)>0);
    int file=open(path,O_WRONLY|O_CREAT|O_EXCL,0600); assert(file>=0);
    assert(write(file,data,size)==(ssize_t)size&&fsync(file)==0&&close(file)==0);
}
#ifndef LI_ESP_NATIVE_INSTALL_HOST
int sodium_memcmp(const void *a, const void *b, size_t size) { return CRYPTO_memcmp(a,b,size); }
#endif

esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t *config) {
    assert(config&&config->method==HTTP_METHOD_GET&&config->transport_type==HTTP_TRANSPORT_OVER_SSL);
    assert(config->disable_auto_redirect&&config->max_authorization_retries==-1&&!config->keep_alive_enable);
    assert(config->timeout_ms==5000&&config->buffer_size==1024&&config->buffer_size_tx==512&&config->event_handler);
    if (fault("http-init")) return NULL;
    struct li_test_http *client=calloc(1,sizeof(*client)); assert(client);
    client->config=*config; client->socket=-1; return client;
}
esp_err_t esp_http_client_set_header(esp_http_client_handle_t client, const char *name, const char *value) {
    if (fault("http-header")) return ESP_FAIL;
    if (!strcmp(name,"Accept-Encoding")) { assert(!strcmp(value,"identity")); client->encoding_header=true; }
    else { assert(!strcmp(name,"Connection")&&!strcmp(value,"close")); client->connection_header=true; }
    return ESP_OK;
}
esp_err_t esp_http_client_open(esp_http_client_handle_t client, int length) {
    io(); host.opens++; assert(length==0&&client->encoding_header&&client->connection_header);
    if (fault("http-open")) return ESP_FAIL;
    char hostname[256], path[1025], request[1400]; unsigned port;
    if (sscanf(client->config.url,"https://%255[^:/]:%u%1024s",hostname,&port,path)!=3||strcmp(hostname,"localhost")||!port||port>65535) return ESP_FAIL;
    client->tls=SSL_CTX_new(TLS_client_method()); assert(client->tls);
    BIO *input=BIO_new_mem_buf(client->config.cert_pem,-1); assert(input);
    X509 *ca=PEM_read_bio_X509(input,NULL,NULL,NULL); BIO_free(input);
    if (!ca) return ESP_FAIL;
    int added=X509_STORE_add_cert(SSL_CTX_get_cert_store(client->tls),ca); X509_free(ca);
    if (added!=1) return ESP_FAIL;
    SSL_CTX_set_verify(client->tls,SSL_VERIFY_PEER,NULL);
    client->socket=socket(AF_INET,SOCK_STREAM,0); assert(client->socket>=0);
    struct timeval timeout={.tv_sec=1};
    assert(setsockopt(client->socket,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout))==0);
    assert(setsockopt(client->socket,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout))==0);
    struct sockaddr_in address={.sin_family=AF_INET,.sin_port=htons((uint16_t)port),.sin_addr={htonl(INADDR_LOOPBACK)}};
    if (connect(client->socket,(struct sockaddr *)&address,sizeof(address))) return ESP_FAIL;
    client->ssl=SSL_new(client->tls); assert(client->ssl);
    if (SSL_set_fd(client->ssl,client->socket)!=1||X509_VERIFY_PARAM_set1_host(SSL_get0_param(client->ssl),hostname,0)!=1
        ||SSL_set_tlsext_host_name(client->ssl,hostname)!=1||SSL_connect(client->ssl)!=1) return ESP_FAIL;
    int count=snprintf(request,sizeof(request),"GET %s HTTP/1.0\r\nHost: %s:%u\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n",path,hostname,port);
    return count>0&&(size_t)count<sizeof(request)&&SSL_write(client->ssl,request,count)==count?ESP_OK:ESP_FAIL;
}
int64_t esp_http_client_fetch_headers(esp_http_client_handle_t client) {
    if (fault("http-fetch")) return -1;
    char headers[8192]; size_t used=0;
    while (used<sizeof(headers)-1) {
        if (SSL_read(client->ssl,headers+used,1)!=1) return -1;
        used++; if (used>=4&&!memcmp(headers+used-4,"\r\n\r\n",4)) break;
    }
    if (used==sizeof(headers)-1) return -1;
    headers[used]=0; char *save=NULL, *line=strtok_r(headers,"\r\n",&save);
    if (!line||sscanf(line,"HTTP/%*s %d",&client->status)!=1) return -1;
    while ((line=strtok_r(NULL,"\r\n",&save))) {
        char *value=strchr(line,':'); if (!value) return -1; *value++=0; while (*value==' ') value++;
        /* 不预先过滤响应；让生产header回调自行核对长度/编码等约束。 */
        esp_http_client_event_t event={HTTP_EVENT_ON_HEADER,line,value,client->config.user_data};
        if (client->config.event_handler(&event)!=ESP_OK) return -1;
    }
    return 0;
}
int esp_http_client_get_status_code(esp_http_client_handle_t client) { return client->status; }
int esp_http_client_read(esp_http_client_handle_t client, char *data, int capacity) {
    io(); host.reads++; if (fault("http-read")) return -1;
    int count=SSL_read(client->ssl,data,capacity);
    if (count<=0) { client->complete=SSL_get_error(client->ssl,count)==SSL_ERROR_ZERO_RETURN; return client->complete?0:-1; }
    inject("read"); return count;
}
bool esp_http_client_is_complete_data_received(esp_http_client_handle_t client) { return client->complete; }
esp_err_t esp_http_client_close(esp_http_client_handle_t client) {
    host.closes++; SSL_free(client->ssl); client->ssl=NULL; SSL_CTX_free(client->tls); client->tls=NULL;
    if (client->socket>=0) { assert(close(client->socket)==0); client->socket=-1; } return ESP_OK;
}
esp_err_t esp_http_client_cleanup(esp_http_client_handle_t client) { host.cleanups++; free(client); return ESP_OK; }

/* 与固定SDK的bootloader_common_loader.c相同包装，CRC函数直接链接SDK linux实现。 */
uint32_t bootloader_common_ota_select_crc(const esp_ota_select_entry_t *entry) {
    return esp_rom_crc32_le(UINT32_MAX,(const uint8_t *)&entry->ota_seq,4);
}
static void entry(unsigned index, uint32_t sequence, esp_ota_img_states_t state) {
    host.entries[index]=(esp_ota_select_entry_t){.ota_seq=sequence,.ota_state=state};
    host.entries[index].crc=bootloader_common_ota_select_crc(&host.entries[index]);
}
const esp_partition_t *esp_ota_get_running_partition(void) { return fault("missing-running")?NULL:&host.app[host.running]; }
const esp_partition_t *esp_ota_get_next_update_partition(const esp_partition_t *running) {
    (void)running; if (fault("missing-next")) return NULL;
    return fault("same-partition")?&host.app[host.running]:&host.app[1-host.running];
}
const esp_partition_t *esp_ota_get_boot_partition(void) { return fault("missing-boot")?NULL:&host.app[host.chosen]; }
unsigned esp_ota_get_app_partition_count(void) { return fault("zero-partitions")?0:2; }
const esp_partition_t *esp_partition_find_first(unsigned type, unsigned subtype, const char *label) {
    assert(!label);
    if (type==ESP_PARTITION_TYPE_DATA) return fault("missing-otadata")?NULL:&host.data;
    if (type==ESP_PARTITION_TYPE_APP&&subtype>=ESP_PARTITION_SUBTYPE_APP_OTA_MIN&&subtype<ESP_PARTITION_SUBTYPE_APP_OTA_MIN+2)
        return &host.app[subtype-ESP_PARTITION_SUBTYPE_APP_OTA_MIN];
    return NULL;
}
esp_err_t esp_partition_read(const esp_partition_t *partition, uint32_t offset, void *data, size_t length) {
    if (partition==&host.data) {
        host.metadata_reads++;
        assert(length==sizeof(host.entries[0])&&(offset==0||offset==partition->erase_size));
        if (fault("metadata-read")||(fault("post-selection-read")&&host.selections)) return ESP_FAIL;
        if (fault("observation-changed")&&host.metadata_reads==3) entry(1,4,ESP_OTA_IMG_VALID);
        memcpy(data,&host.entries[offset?1:0],length); return ESP_OK;
    }
    io(); host.partition_reads++; unsigned index=partition==&host.app[0]?0:1; assert(partition==&host.app[index]);
    if (fault("partition-read")||offset>host.lengths[index]||length>host.lengths[index]-offset) return ESP_FAIL;
    if (pread(host.files[index],data,length,offset)!=(ssize_t)length) return ESP_FAIL;
    inject(suite("stage")?"verify":suite("activate")?"activation-read":"baseline-read"); return ESP_OK;
}
esp_err_t esp_ota_begin(const esp_partition_t *partition, size_t size, esp_ota_handle_t *handle) {
    io(); host.begins++; assert(partition==&host.app[1]&&size<=partition->size&&!host.active);
    if (fault("begin")) return ESP_FAIL;
    host.active=true; *handle=7; return ESP_OK;
}
esp_err_t esp_ota_write(esp_ota_handle_t handle, const void *data, size_t length) {
    io(); host.writes++; assert(handle==7&&host.active);
    if (fault("write")) return ESP_FAIL;
    assert(pwrite(host.files[1],data,length,host.written)==(ssize_t)length);
    if (fault("corrupt-write")) { unsigned char byte=(*(const unsigned char *)data)^1; assert(pwrite(host.files[1],&byte,1,host.written)==1); }
    host.written+=(unsigned)length; host.lengths[1]=host.written; inject("write"); return ESP_OK;
}
esp_err_t esp_ota_end(esp_ota_handle_t handle) {
    host.ends++; assert(handle==7&&host.active); host.active=false; assert(fsync(host.files[1])==0);
    inject("finish"); return fault("finish")?ESP_FAIL:ESP_OK;
}
esp_err_t esp_ota_abort(esp_ota_handle_t handle) { host.aborts++; assert(handle==7&&host.active); host.active=false; return ESP_OK; }
esp_err_t esp_ota_get_partition_description(const esp_partition_t *partition, esp_app_desc_t *description) {
    if (fault("description-read")) return ESP_FAIL;
    *description=host.description[partition==&host.app[0]?0:1]; return ESP_OK;
}
const esp_app_desc_t *esp_app_get_description(void) { return &host.description[host.running]; }
esp_err_t esp_ota_get_state_partition(const esp_partition_t *partition, esp_ota_img_states_t *state) {
    assert(partition==&host.app[0]); if (fault("baseline-state-read")) return ESP_FAIL;
    *state=fault("baseline-pending")?ESP_OTA_IMG_PENDING_VERIFY:ESP_OTA_IMG_VALID; return ESP_OK;
}
esp_err_t esp_image_verify(int kind, const esp_partition_pos_t *position, esp_image_metadata_t *metadata) {
    host.image_checks++; assert(kind==ESP_IMAGE_VERIFY_SILENT);
    unsigned index=position->offset==host.app[0].address?0:1;
    assert(position->offset==host.app[index].address&&position->size==host.app[index].size);
    if (fault("image-invalid")) return ESP_FAIL;
    metadata->image_len=fault("image-too-big")?position->size+1:host.lengths[index]; return ESP_OK;
}
esp_err_t esp_ota_set_boot_partition(const esp_partition_t *partition) {
    io(); host.selections++; assert(partition==&host.app[1]);
    if (fault("selection-error-before")) return ESP_FAIL;
    /* 预定外部结果；不把本夹具当作SDK的选槽/掉电算法。 */
    entry(1,fault("wrong-slot")?3:2,ESP_OTA_IMG_NEW); host.chosen=1;
    if (fault("selection-crc")) host.entries[1].crc^=1;
    if (fault("selection-duplicate")) entry(0,4,ESP_OTA_IMG_NEW);
    if (fault("selected-wrong-boot")) host.chosen=0;
#ifdef LI_ESP_NATIVE_INSTALL_HOST
    native_selection_saved();
#endif
    inject("select"); return fault("selection-error-after")?ESP_FAIL:ESP_OK;
}
#ifndef LI_ESP_NATIVE_INSTALL_HOST
static void copy_string(char *destination, size_t size, const char *source) { assert(source&&strlen(source)<size); strcpy(destination,source); }
#endif
static void initialize(const char *folder) {
    host.suite=text("suite"); host.fault=text("fault"); host.checkpoint=text("checkpoint"); host.invalidation=text("invalidation");
    assert(host.suite&&host.fault&&host.checkpoint&&host.invalidation); host.trusted=true;
    host.app[0]=(esp_partition_t){ESP_PARTITION_TYPE_APP,ESP_PARTITION_SUBTYPE_APP_OTA_MIN,0x20000,0x1e0000,4096};
    host.app[1]=(esp_partition_t){ESP_PARTITION_TYPE_APP,ESP_PARTITION_SUBTYPE_APP_OTA_MIN+1,0x200000,0x1e0000,4096};
    host.data=(esp_partition_t){ESP_PARTITION_TYPE_DATA,ESP_PARTITION_SUBTYPE_DATA_OTA,0xd000,8192,4096};
    for (unsigned i=0;i<2;i++) {
        const char *name=i?"spare.bin":"baseline.bin"; size_t size=0;
#ifdef LI_ESP_NATIVE_INSTALL_HOST
        bool resumed=strcmp(runtime.mode,"install")!=0;
        if (!resumed) {
#endif
        unsigned char *bytes=read_file(text(i?"image":"baseline"),&size);
        if (i&&suite("stage")) size=0;
        host.lengths[i]=(uint32_t)size; store(folder,name,bytes,size); free(bytes);
#ifdef LI_ESP_NATIVE_INSTALL_HOST
        }
#endif
        char path[4096]; snprintf(path,sizeof(path),"%s/%s",folder,name); host.files[i]=open(path,O_RDWR); assert(host.files[i]>=0);
#ifdef LI_ESP_NATIVE_INSTALL_HOST
        struct stat status; assert(fstat(host.files[i],&status)==0&&status.st_size>=0&&status.st_size<=host.app[i].size);
        host.lengths[i]=(uint32_t)status.st_size;
#endif
        host.description[i]=(esp_app_desc_t){.magic_word=ESP_APP_DESC_MAGIC_WORD,.secure_version=i?2:1};
        strcpy(host.description[i].version,i?"0.2.0":"0.1.0"); strcpy(host.description[i].project_name,"limeiot-test");
    }
    entry(0,1,ESP_OTA_IMG_VALID); memset(&host.entries[1],0xff,sizeof(host.entries[1]));
    if (suite("observe")) {
        entry(1,2,fault("pending")?ESP_OTA_IMG_PENDING_VERIFY:fault("new")?ESP_OTA_IMG_NEW:
            fault("rollback")||fault("baseline-pending")||fault("baseline-state-read")||fault("baseline-hash")||fault("baseline-version")||fault("baseline-epoch")?ESP_OTA_IMG_ABORTED:
            fault("rollback-invalid")?ESP_OTA_IMG_INVALID:ESP_OTA_IMG_VALID);
        host.running=host.entries[1].ota_state==ESP_OTA_IMG_ABORTED||host.entries[1].ota_state==ESP_OTA_IMG_INVALID?0:1;
        host.chosen=host.running;
        if (fault("observe-crc")) host.entries[1].crc^=1;
        if (fault("observe-duplicate")) host.entries[0]=host.entries[1];
        if (fault("observe-wrong-slot")) entry(1,3,ESP_OTA_IMG_VALID);
        if (fault("running-boot-mismatch")) host.chosen=1-host.running;
    }
    if (fault("capacity")) host.app[1].size=1;
    if (fault("not-app")) host.app[1].type=ESP_PARTITION_TYPE_DATA;
    if (fault("bad-erase-size")) host.data.erase_size=1;
    if (fault("bad-metadata-size")) host.data.size=4096;
    if (fault("sequence-overflow")) entry(0,UINT32_MAX-3,ESP_OTA_IMG_VALID);
    if (fault("sequence-reused")) entry(1,2,ESP_OTA_IMG_NEW);
    if (fault("preselected")) host.chosen=1;
    if (fault("target-version")) strcpy(host.description[1].version,"9.9.9");
    if (fault("target-epoch")) host.description[1].secure_version++;
    if (fault("target-project")) strcpy(host.description[1].project_name,"other-project");
    if (fault("unterminated-version")) memset(host.description[1].version,'x',sizeof(host.description[1].version));
    if (fault("unterminated-project")) memset(host.description[1].project_name,'x',sizeof(host.description[1].project_name));
#ifdef LI_ESP_NATIVE_INSTALL_HOST
    if (strcmp(runtime.mode,"install")) {
        char path[4096]; snprintf(path,sizeof(path),"%s/otadata.bin",folder);
        size_t size; unsigned char *bytes=read_file(path,&size); assert(size==sizeof(host.entries)); memcpy(host.entries,bytes,size); free(bytes);
        host.chosen=host.entries[1].ota_seq==2?1:0;
        if (!strcmp(runtime.mode,"boot-success")||!strcmp(runtime.mode,"boot-pending")) {
            host.running=host.chosen=1;
            entry(1,2,!strcmp(runtime.mode,"boot-success")?ESP_OTA_IMG_VALID:ESP_OTA_IMG_PENDING_VERIFY);
        } else if (!strcmp(runtime.mode,"boot-rollback")) { host.running=host.chosen=0; entry(1,2,ESP_OTA_IMG_ABORTED); }
    }
    native_selection_saved();
#else
    size_t unused;
    char *key=(char *)read_file(text("identity_key"),&unused), *leaf=(char *)read_file(text("identity_leaf"),&unused), *ca=(char *)read_file(text("identity_ca"),&unused);
    assert(li_credential_window_open(&host.window,key,leaf,ca,"device-lamp"));
    OPENSSL_cleanse(key,strlen(key)); free(key); free(leaf); free(ca);
#endif
}
#ifndef LI_ESP_NATIVE_INSTALL_HOST
int main(int argc, char **argv) {
    if (argc!=3) return 5;
    signal(SIGPIPE,SIG_IGN); size_t size; unsigned char *raw=read_file(argv[1],&size);
    host.plan=cJSON_ParseWithLength((const char *)raw,size); free(raw); assert(host.plan&&psa_crypto_init()==PSA_SUCCESS);
    initialize(argv[2]); store(argv[2],"otadata-before.bin",host.entries,sizeof(host.entries));
    li_ota_candidate_t candidate={.size_bytes=(uint32_t)cJSON_GetNumberValue(cJSON_GetObjectItemCaseSensitive(host.plan,"size")),.security_epoch=2};
    copy_string(candidate.download_url,sizeof(candidate.download_url),text("url")); copy_string(candidate.image_sha256,sizeof(candidate.image_sha256),text("sha256"));
    strcpy(candidate.version,"0.2.0");
    li_ota_transfer_guard_t guard={NULL,monotonic,authorize};
    li_ota_transfer_result_t result={0}; li_ota_outcome_t outcome={0}; li_ota_stage_t stage=LI_OTA_AWAITING_BOOT;
    li_error_t error=LI_INVALID; bool accepted=false; char binding[LI_OTA_LOG_ID_SIZE]={0}; const char *issue="not_stage";
    inject("before");
    if (suite("stage")) {
        char *ca=(char *)read_file(text("download_ca"),&size);
        error=li_espidf_ota_stage(&candidate,fault("empty-ca")?"":ca,&guard,&result,&issue); free(ca); accepted=error==LI_OK;
    } else if (suite("activate")) accepted=li_esp_ota_activate(&candidate,&guard,binding);
    else {
        assert(suite("observe"));
        li_ota_log_view_t view={.target_size_bytes=candidate.size_bytes,.target_security_epoch=2,.stage=LI_OTA_AWAITING_BOOT};
        strcpy(view.boot_binding,"esp_00200000_00000002"); strcpy(view.target_version,candidate.version); strcpy(view.target_image_sha256,candidate.image_sha256);
        strcpy(view.baseline.firmware_version,fault("baseline-version")?"9.9.9":"0.1.0"); view.baseline.security_epoch=fault("baseline-epoch")?9:1;
        copy_string(view.baseline.image_sha256,sizeof(view.baseline.image_sha256),text("baseline_sha256"));
        if (fault("baseline-hash")) view.baseline.image_sha256[7]=view.baseline.image_sha256[7]=='0'?'1':'0';
        if (fault("binding-noncanonical")) strcpy(view.boot_binding,"esp_200000_00000002");
        if (fault("binding-trailing")) strcat(view.boot_binding,"x");
        if (fault("binding-wrong-address")) strcpy(view.boot_binding,"esp_00300000_00000002");
        if (fault("target-hash")) view.target_image_sha256[7]=view.target_image_sha256[7]=='0'?'1':'0';
        accepted=li_esp_ota_observe(&view,&stage,&outcome);
    }
    store(argv[2],"otadata-after.bin",host.entries,sizeof(host.entries));
    cJSON *output=cJSON_CreateObject(); assert(output);
#define NUMBER(name,value) cJSON_AddNumberToObject(output,name,value)
#define BOOL(name,value) cJSON_AddBoolToObject(output,name,value)
#define STRING(name,value) cJSON_AddStringToObject(output,name,value)
    BOOL("accepted",accepted); NUMBER("code",error); STRING("issue",issue); STRING("binding",binding);
    BOOL("image_verified",result.image_verified); STRING("image_sha256",result.image_sha256);
    NUMBER("bytes_received",result.bytes_received); NUMBER("bytes_written",result.bytes_written); NUMBER("bytes_verified",result.bytes_verified);
    NUMBER("stage",stage); STRING("outcome_version",outcome.firmware_version); STRING("outcome_sha256",outcome.image_sha256); STRING("outcome_error",outcome.error);
    NUMBER("opens",host.opens); NUMBER("reads",host.reads); NUMBER("closes",host.closes); NUMBER("cleanups",host.cleanups);
    NUMBER("begins",host.begins); NUMBER("writes",host.writes); NUMBER("ends",host.ends); NUMBER("aborts",host.aborts);
    NUMBER("partition_reads",host.partition_reads); NUMBER("metadata_reads",host.metadata_reads); NUMBER("selections",host.selections); NUMBER("chosen",host.chosen);
    NUMBER("image_checks",host.image_checks); NUMBER("guard_calls",host.guard_calls); NUMBER("io_after_loss",host.io_after_loss);
    BOOL("active_handle",host.active); BOOL("injected",host.injected); BOOL("observed_loss",host.observed_loss);
    BOOL("current",li_credential_window_current(&host.window,host.trusted)); BOOL("leaf_still_valid",!mbedtls_x509_time_is_past(&host.window.leaf_to));
    host.trusted=true; BOOL("restored_current",li_credential_window_check(&host.window,true));
    BOOL("hardware",false); BOOL("actual_installation",false);
    char *encoded=cJSON_PrintUnformatted(output); assert(encoded); puts(encoded); free(encoded); cJSON_Delete(output);
    assert(close(host.files[0])==0&&close(host.files[1])==0); cJSON_Delete(host.plan); return 0;
}
#endif
