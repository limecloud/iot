/* 固定SDK凭据窗口与生产传输；HTTPS/备用文件为宿主端口，不选择启动或重启。 */
#include "ota_transfer_fixture.h"
#include "credential_window.h"
#include <assert.h>

typedef struct {
    transfer_host_t transfer;
    li_credential_window_t window;
    const char *mode, *checkpoint;
    bool trusted, injected, observed_invalidation;
    unsigned writes_at_gate, reads_at_gate, verifies_at_gate, calls_after_gate;
} credential_transfer_t;

int sodium_memcmp(const void *a, const void *b, size_t size) { return CRYPTO_memcmp(a,b,size); }
static char *read_pem(const char *path) {
    FILE *file=fopen(path,"rb"); assert(file);
    char *value=calloc(4097,1); assert(value);
    size_t length=fread(value,1,4096,file);
    assert(length&&fgetc(file)==EOF&&!ferror(file)); assert(fclose(file)==0); return value;
}
static int64_t monotonic(void *context) {
    (void)context; struct timespec now; assert(clock_gettime(CLOCK_MONOTONIC,&now)==0);
    return (int64_t)now.tv_sec*1000+now.tv_nsec/1000000;
}
static bool authorize(void *context) {
    credential_transfer_t *host=context; host->transfer.authorizations++;
    return li_credential_window_check(&host->window,host->trusted);
}
static void before_io(credential_transfer_t *host) {
    /* 只观测，不在端口中替生产传输拒绝I/O。 */
    if (!li_credential_window_current(&host->window,host->trusted)) host->calls_after_gate++;
}
static void invalidate(credential_transfer_t *host, const char *checkpoint) {
    if (host->injected||strcmp(checkpoint,host->checkpoint)) return;
    host->injected=true;
    if (!strcmp(host->mode,"clock")) host->trusted=false;
    else {
        int64_t start=monotonic(host);
        const struct timespec pause={.tv_nsec=10000000};
        while (li_credential_window_current(&host->window,true)&&monotonic(host)-start<7000)
            assert(nanosleep(&pause,NULL)==0);
    }
    host->observed_invalidation=!li_credential_window_current(&host->window,host->trusted);
    host->writes_at_gate=host->transfer.writes; host->reads_at_gate=host->transfer.reads;
    host->verifies_at_gate=host->transfer.verifies;
}
static bool guarded_read(void *context, uint8_t *data, size_t capacity, size_t *received, bool *complete) {
    transfer_host_t *transfer=context; credential_transfer_t *host=transfer->owner; before_io(host);
    bool result=read_http(context,data,capacity,received,complete);
    if (result&&*received) invalidate(host,"read");
    return result;
}
static bool guarded_write(void *context, uint32_t offset, const uint8_t *data, size_t length) {
    transfer_host_t *transfer=context; credential_transfer_t *host=transfer->owner; before_io(host);
    bool result=write_image(context,offset,data,length);
    if (result) invalidate(host,"write");
    return result;
}
static bool guarded_verify(void *context, uint32_t offset, uint8_t *data, size_t length) {
    transfer_host_t *transfer=context; credential_transfer_t *host=transfer->owner; before_io(host);
    bool result=read_image(context,offset,data,length);
    if (result) invalidate(host,"verify");
    return result;
}
int main(int argc, char **argv) {
    if (argc!=3) return 5;
    signal(SIGPIPE,SIG_IGN);
    char *raw=read_pem(argv[1]); cJSON *plan=cJSON_Parse(raw); free(raw); assert(plan);
    credential_transfer_t host={.transfer={.plan=plan,.path=argv[2],.socket=-1,.file=-1},.trusted=true};
    host.transfer.owner=&host; host.mode=transfer_text(plan,"mode"); host.checkpoint=transfer_text(plan,"checkpoint");
    assert(host.mode&&host.checkpoint);
    char *key=read_pem(transfer_text(plan,"key")), *leaf=read_pem(transfer_text(plan,"leaf")), *ca=read_pem(transfer_text(plan,"identity_ca"));
    bool opened=li_credential_window_open(&host.window,key,leaf,ca,"device-lamp"); assert(opened);
    li_ota_candidate_t candidate={.size_bytes=(uint32_t)cJSON_GetNumberValue(cJSON_GetObjectItemCaseSensitive(plan,"size"))};
    const char *url=transfer_text(plan,"url"), *digest=transfer_text(plan,"sha256");
    assert(url&&digest&&strlen(url)<sizeof(candidate.download_url)&&strlen(digest)<sizeof(candidate.image_sha256));
    strcpy(candidate.download_url,url); strcpy(candidate.image_sha256,digest);
    li_ota_source_t source={&host.transfer,open_http,guarded_read,close_http};
    li_ota_sink_t sink={&host.transfer,begin_image,guarded_write,finish_image,guarded_verify,abort_image};
    li_ota_hash_stream_t hash={&host.transfer,begin_hash,update_hash,finish_hash,abort_hash};
    li_ota_transfer_guard_t guard={&host,monotonic,authorize};
    if (!strcmp(host.checkpoint,"before")) invalidate(&host,"before");
    li_ota_transfer_result_t result; const char *issue=NULL;
    li_error_t error=li_ota_transfer_run(&candidate,&source,&sink,&hash,&guard,&result,&issue);
    unsigned opens=host.transfer.opens, writes=host.transfer.writes, verifies=host.transfer.verifies;
    bool current=li_credential_window_current(&host.window,host.trusted), locked=atomic_load(&host.window.blocked);
    host.trusted=true;
    bool restored=li_credential_window_check(&host.window,true);
    li_error_t retry=LI_OK; li_ota_transfer_result_t retry_result={0}; const char *retry_issue="not_requested";
    if (error!=LI_OK) retry=li_ota_transfer_run(&candidate,&source,&sink,&hash,&guard,&retry_result,&retry_issue);
    bool zero_retry_io=host.transfer.opens==opens&&host.transfer.writes==writes&&host.transfer.verifies==verifies;
    li_credential_window_t reopened;
    bool can_reopen=li_credential_window_open(&reopened,key,leaf,ca,"device-lamp");
    cJSON *output=cJSON_CreateObject();
#define NUMBER(name,value) cJSON_AddNumberToObject(output,name,value)
#define BOOL(name,value) cJSON_AddBoolToObject(output,name,value)
    NUMBER("code",error); cJSON_AddStringToObject(output,"issue",issue);
    BOOL("opened",opened); BOOL("image_verified",result.image_verified); cJSON_AddStringToObject(output,"image_sha256",result.image_sha256);
    NUMBER("bytes_received",result.bytes_received); NUMBER("bytes_written",result.bytes_written); NUMBER("bytes_verified",result.bytes_verified);
    BOOL("injected",host.injected); BOOL("observed_invalidation",host.observed_invalidation); BOOL("current",current); BOOL("locked",locked);
    BOOL("restored_current",restored); BOOL("can_reopen",can_reopen); BOOL("leaf_still_valid",!mbedtls_x509_time_is_past(&host.window.leaf_to));
    NUMBER("writes_at_gate",host.writes_at_gate); NUMBER("reads_at_gate",host.reads_at_gate); NUMBER("verifies_at_gate",host.verifies_at_gate);
    NUMBER("calls_after_gate",host.calls_after_gate); NUMBER("opens",host.transfer.opens); NUMBER("reads",host.transfer.reads);
    NUMBER("closes",host.transfer.closes); NUMBER("writes",host.transfer.writes); NUMBER("verifies",host.transfer.verifies);
    NUMBER("finishes",host.transfer.finishes); NUMBER("aborts",host.transfer.aborts);
    NUMBER("retry_code",retry); cJSON_AddStringToObject(output,"retry_issue",retry_issue); BOOL("zero_retry_io",zero_retry_io);
    BOOL("retry_verified",retry_result.image_verified); BOOL("hardware",false); BOOL("esp_mqtt_runtime",false);
    char *encoded=cJSON_PrintUnformatted(output); assert(encoded); puts(encoded); free(encoded); cJSON_Delete(output);
    if (host.transfer.file>=0) assert(close(host.transfer.file)==0);
    OPENSSL_cleanse(key,strlen(key)); free(key); free(leaf); free(ca); cJSON_Delete(plan); return 0;
}
