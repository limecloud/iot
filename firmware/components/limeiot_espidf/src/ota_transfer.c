/* ESP HTTPS及备用分区适配；不选择启动分区，不重启。 */
#include "limeiot_espidf.h"
#include "ota_transfer.h"
#include "esp_app_desc.h"
#include "esp_image_format.h"
#include "bootloader_common.h"
#include <stdio.h>
#include "esp_http_client.h"
#include "esp_ota_ops.h"
#include "psa/crypto.h"
#include <stdlib.h>
#include <string.h>
#include <strings.h>

typedef struct {
    const char *ca;
    esp_http_client_handle_t http;
    const esp_partition_t *partition;
    esp_ota_handle_t ota;
    bool active, headers_invalid;
    unsigned lengths;
    li_ota_http_response_t response;
    psa_hash_operation_t hash;
} transfer_t;
static esp_err_t header(esp_http_client_event_t *event) {
    transfer_t *t=event->user_data;
    if (event->event_id!=HTTP_EVENT_ON_HEADER || !event->header_key || !event->header_value) return ESP_OK;
    if (!strcasecmp(event->header_key,"Content-Length")) {
        const char *value=event->header_value; uint64_t size=0;
        if (++t->lengths!=1 || !*value) t->headers_invalid=true;
        for (;*value;value++) {
            if (*value<'0'||*value>'9'||size>UINT32_MAX/10) { t->headers_invalid=true; break; }
            size=size*10+(unsigned)(*value-'0'); if (size>UINT32_MAX) { t->headers_invalid=true; break; }
        }
        t->response.has_length=true; t->response.content_length=(uint32_t)size;
    } else if (!strcasecmp(event->header_key,"Content-Encoding")&&strcasecmp(event->header_value,"identity")) t->response.encoded=true;
    return ESP_OK;
}
static bool open_http(void *context, const char *url, li_ota_http_response_t *response) {
    transfer_t *t=context;
    esp_http_client_config_t config={.url=url,.cert_pem=t->ca,.method=HTTP_METHOD_GET,.transport_type=HTTP_TRANSPORT_OVER_SSL,
        .timeout_ms=5000,.disable_auto_redirect=true,.max_authorization_retries=-1,.keep_alive_enable=false,
        .buffer_size=1024,.buffer_size_tx=512,.event_handler=header,.user_data=t};
    t->http=esp_http_client_init(&config); if (!t->http) return false;
    if (esp_http_client_set_header(t->http,"Accept-Encoding","identity")!=ESP_OK
        || esp_http_client_set_header(t->http,"Connection","close")!=ESP_OK || esp_http_client_open(t->http,0)!=ESP_OK
        || esp_http_client_fetch_headers(t->http)<0 || t->headers_invalid) return false;
    t->response.status=(unsigned)esp_http_client_get_status_code(t->http);
    t->response.redirected=t->response.status>=300&&t->response.status<400;
    *response=t->response; return true;
}
static bool read_http(void *context, uint8_t *data, size_t capacity, size_t *received, bool *complete) {
    transfer_t *t=context; int count=esp_http_client_read(t->http,(char *)data,(int)capacity);
    if (count<0) return false;
    *received=(size_t)count; *complete=esp_http_client_is_complete_data_received(t->http); return true;
}
static void close_http(void *context) {
    transfer_t *t=context; if (t->http) { (void)esp_http_client_close(t->http); (void)esp_http_client_cleanup(t->http); t->http=NULL; }
}
static bool begin_image(void *context, uint32_t size) {
    transfer_t *t=context; const esp_partition_t *running=esp_ota_get_running_partition();
    t->partition=esp_ota_get_next_update_partition(running);
    if (!running || !t->partition || t->partition->type!=ESP_PARTITION_TYPE_APP || t->partition->address==running->address || size>t->partition->size) return false;
    t->active=esp_ota_begin(t->partition,size,&t->ota)==ESP_OK; return t->active;
}
static bool write_image(void *context, uint32_t offset, const uint8_t *data, size_t length) {
    (void)offset; transfer_t *t=context; return t->active&&esp_ota_write(t->ota,data,length)==ESP_OK;
}
static bool finish_image(void *context) {
    transfer_t *t=context; if (!t->active) return false;
    t->active=false; return esp_ota_end(t->ota)==ESP_OK;
}
static bool read_image(void *context, uint32_t offset, uint8_t *data, size_t length) {
    transfer_t *t=context; return t->partition&&esp_partition_read(t->partition,offset,data,length)==ESP_OK;
}
static void abort_image(void *context) { transfer_t *t=context; if (t->active) { (void)esp_ota_abort(t->ota); t->active=false; } }
static bool begin_hash(void *context) { transfer_t *t=context; return psa_hash_setup(&t->hash,PSA_ALG_SHA_256)==PSA_SUCCESS; }
static bool update_hash(void *context, const uint8_t *data, size_t length) { transfer_t *t=context; return psa_hash_update(&t->hash,data,length)==PSA_SUCCESS; }
static bool finish_hash(void *context, uint8_t digest[32]) {
    transfer_t *t=context; size_t size=0; return psa_hash_finish(&t->hash,digest,32,&size)==PSA_SUCCESS&&size==32;
}
static void abort_hash(void *context) { transfer_t *t=context; (void)psa_hash_abort(&t->hash); }
li_error_t li_espidf_ota_stage(const li_ota_candidate_t *candidate, const char *ca,
                              const li_ota_transfer_guard_t *guard, li_ota_transfer_result_t *result, const char **issue) {
    if (result) memset(result,0,sizeof(*result));
    if (issue) *issue="invalid_ota_https_trust";
    if (!ca || !*ca || strnlen(ca,65537)>65536 || psa_crypto_init()!=PSA_SUCCESS) return LI_INVALID;
    transfer_t t={.ca=ca,.hash=PSA_HASH_OPERATION_INIT};
    li_ota_source_t source={&t,open_http,read_http,close_http};
    li_ota_sink_t sink={&t,begin_image,write_image,finish_image,read_image,abort_image};
    li_ota_hash_stream_t hash={&t,begin_hash,update_hash,finish_hash,abort_hash};
    return li_ota_transfer_run(candidate,&source,&sink,&hash,guard,result,issue);
}
static bool selection(esp_ota_select_entry_t entries[2]) {
    const esp_partition_t *p=esp_partition_find_first(ESP_PARTITION_TYPE_DATA,ESP_PARTITION_SUBTYPE_DATA_OTA,NULL);
    return p&&p->erase_size>=sizeof(entries[0])&&p->size>=p->erase_size+sizeof(entries[0])
        &&esp_partition_read(p,0,&entries[0],sizeof(entries[0]))==ESP_OK
        &&esp_partition_read(p,p->erase_size,&entries[1],sizeof(entries[1]))==ESP_OK;
}
static bool valid_entry(const esp_ota_select_entry_t *e) {
    return e->ota_seq&&e->ota_seq!=UINT32_MAX&&e->crc==bootloader_common_ota_select_crc(e);
}
static bool hash_partition(const esp_partition_t *p, uint32_t size, char output[72]) {
    if (!p||!size||size>p->size) return false;
    transfer_t t={.partition=p,.hash=PSA_HASH_OPERATION_INIT}; uint8_t buffer[LI_OTA_TRANSFER_CHUNK], digest[32]; bool ok=begin_hash(&t);
    for (uint32_t offset=0;ok&&offset<size;) {
        size_t length=size-offset; if (length>sizeof(buffer)) length=sizeof(buffer);
        ok=read_image(&t,offset,buffer,length)&&update_hash(&t,buffer,length); offset+=(uint32_t)length;
    }
    if (ok) ok=finish_hash(&t,digest);
    abort_hash(&t); if (!ok) return false;
    strcpy(output,"sha256:"); static const char hex[]="0123456789abcdef";
    for (size_t i=0;i<32;i++) { output[7+2*i]=hex[digest[i]>>4]; output[8+2*i]=hex[digest[i]&15]; } output[71]=0; return true;
}
bool li_esp_ota_activate(const li_ota_candidate_t *candidate, const li_ota_transfer_guard_t *guard, char binding[LI_OTA_LOG_ID_SIZE]) {
    if (binding) *binding=0;
    if (!binding) return false;
    if (!candidate || !guard || !guard->authorize || !guard->authorize(guard->context)) return false;
    const esp_partition_t *running=esp_ota_get_running_partition(), *next=esp_ota_get_next_update_partition(running);
    esp_app_desc_t description;
    if (!running || !next || next->address==running->address || !candidate->size_bytes || candidate->size_bytes>next->size
        || esp_ota_get_partition_description(next,&description)!=ESP_OK
        || !memchr(description.version,0,sizeof(description.version)) || strcmp(description.version,candidate->version)
        || !memchr(description.project_name,0,sizeof(description.project_name))
        || strcmp(description.project_name,esp_app_get_description()->project_name) || description.secure_version!=candidate->security_epoch) return false;
    transfer_t t={.partition=next,.hash=PSA_HASH_OPERATION_INIT};
    uint8_t buffer[LI_OTA_TRANSFER_CHUNK], digest[32]; bool ok=begin_hash(&t);
    for (uint32_t offset=0;ok&&offset<candidate->size_bytes;) {
        size_t size=candidate->size_bytes-offset; if (size>sizeof(buffer)) size=sizeof(buffer);
        ok=guard->authorize(guard->context)&&read_image(&t,offset,buffer,size)&&update_hash(&t,buffer,size); offset+=(uint32_t)size;
    }
    if (ok) ok=finish_hash(&t,digest);
    abort_hash(&t); if (!ok) return false;
    char computed[72]="sha256:"; static const char hex[]="0123456789abcdef";
    for (size_t i=0;i<32;i++) { computed[7+2*i]=hex[digest[i]>>4]; computed[8+2*i]=hex[digest[i]&15]; }
    if (strcmp(computed,candidate->image_sha256) || !guard->authorize(guard->context)) return false;
    esp_ota_select_entry_t before[2], after[2]; uint32_t maximum=0; unsigned count=esp_ota_get_app_partition_count();
    const esp_partition_t *previous=esp_ota_get_boot_partition();
    if (!count||!selection(before)||!previous||previous->address!=running->address) return false;
    for (size_t i=0;i<2;i++) if (valid_entry(&before[i])&&before[i].ota_seq>maximum) maximum=before[i].ota_seq;
    if (maximum>=UINT32_MAX-count-1 || !guard->authorize(guard->context) || esp_ota_set_boot_partition(next)!=ESP_OK || !selection(after)) return false;
    const esp_partition_t *chosen=esp_ota_get_boot_partition(); if (!chosen||chosen->address!=next->address) return false;
    unsigned matches=0; uint32_t sequence=0;
    for (size_t i=0;i<2;i++) if (valid_entry(&after[i])&&after[i].ota_state==ESP_OTA_IMG_NEW
        &&(after[i].ota_seq-1)%count==(unsigned)(next->subtype-ESP_PARTITION_SUBTYPE_APP_OTA_MIN)) { sequence=after[i].ota_seq; matches++; }
    if (matches!=1) return false;
    for (size_t i=0;i<2;i++) if (valid_entry(&before[i])&&before[i].ota_seq==sequence&&before[i].ota_state==ESP_OTA_IMG_NEW) return false;
    int n=snprintf(binding,LI_OTA_LOG_ID_SIZE,"esp_%08x_%08x",(unsigned)next->address,(unsigned)sequence);
    return n>0&&n<LI_OTA_LOG_ID_SIZE;
}
bool li_esp_ota_observe(const li_ota_log_view_t *view, li_ota_stage_t *stage, li_ota_outcome_t *outcome) {
    unsigned address=0, sequence=0; int consumed=0; char canonical[LI_OTA_LOG_ID_SIZE];
    if (!view||!stage||!outcome||sscanf(view->boot_binding,"esp_%8x_%8x%n",&address,&sequence,&consumed)!=2
        || consumed<=0 || (size_t)consumed!=strlen(view->boot_binding)) return false;
    snprintf(canonical,sizeof(canonical),"esp_%08x_%08x",address,sequence);
    if (strcmp(canonical,view->boot_binding)) return false;
    unsigned count=esp_ota_get_app_partition_count(); esp_ota_select_entry_t entries[2], confirmed[2]; const esp_partition_t *target=NULL;
    if (!count||!selection(entries)) return false;
    for (unsigned i=0;i<count;i++) {
        const esp_partition_t *p=esp_partition_find_first(ESP_PARTITION_TYPE_APP,ESP_PARTITION_SUBTYPE_APP_OTA_MIN+i,NULL);
        if (p&&p->address==address&&(sequence-1)%count==i) target=p;
    }
    unsigned matches=0; esp_ota_img_states_t state=ESP_OTA_IMG_UNDEFINED;
    for (size_t i=0;i<2;i++) if (valid_entry(&entries[i])&&entries[i].ota_seq==sequence) { state=entries[i].ota_state; matches++; }
    if (!target||matches!=1||!view->target_size_bytes||view->target_size_bytes>target->size) return false;
    const esp_partition_t *running=esp_ota_get_running_partition(), *chosen=esp_ota_get_boot_partition(); esp_app_desc_t image;
    esp_partition_pos_t position={.offset=target->address,.size=target->size}; esp_image_metadata_t metadata={0}; char digest[72];
    if (!running||!chosen||chosen->address!=running->address
        ||esp_image_verify(ESP_IMAGE_VERIFY_SILENT,&position,&metadata)!=ESP_OK||metadata.image_len>view->target_size_bytes
        ||esp_ota_get_partition_description(target,&image)!=ESP_OK||!memchr(image.version,0,sizeof(image.version))
        ||strcmp(image.version,view->target_version)||image.secure_version!=view->target_security_epoch
        ||!memchr(image.project_name,0,sizeof(image.project_name))||strcmp(image.project_name,esp_app_get_description()->project_name)
        ||!hash_partition(target,view->target_size_bytes,digest)||strcmp(digest,view->target_image_sha256)) return false;
    memset(outcome,0,sizeof(*outcome));
    if (target->address==running->address) {
        if (state!=ESP_OTA_IMG_VALID) return false;
        *stage=LI_OTA_SUCCEEDED; strcpy(outcome->firmware_version,image.version); outcome->security_epoch=image.secure_version; strcpy(outcome->image_sha256,digest);
    } else {
        esp_ota_img_states_t running_state; esp_app_desc_t baseline;
        if ((state!=ESP_OTA_IMG_ABORTED&&state!=ESP_OTA_IMG_INVALID)
            ||esp_ota_get_state_partition(running,&running_state)!=ESP_OK||running_state!=ESP_OTA_IMG_VALID
            ||esp_ota_get_partition_description(running,&baseline)!=ESP_OK||!memchr(baseline.version,0,sizeof(baseline.version))
            ||strcmp(baseline.version,view->baseline.firmware_version)||baseline.secure_version!=view->baseline.security_epoch) return false;
        position=(esp_partition_pos_t){.offset=running->address,.size=running->size};
        if (esp_image_verify(ESP_IMAGE_VERIFY_SILENT,&position,&metadata)!=ESP_OK
            ||!hash_partition(running,metadata.image_len,digest)||strcmp(digest,view->baseline.image_sha256)) return false;
        *stage=LI_OTA_ROLLED_BACK; strcpy(outcome->firmware_version,baseline.version); outcome->security_epoch=baseline.secure_version;
        strcpy(outcome->image_sha256,digest); strcpy(outcome->error,"ota_boot_rolled_back");
    }
    /* 读取过程中健康状态可由产品确认；前后原生凭据须保持一致。 */
    return selection(confirmed)&&!memcmp(entries,confirmed,sizeof(entries));
}
