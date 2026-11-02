/* 文件存储与故障注入仅用于宿主测试；设备端使用独立NVS命名空间。 */
#include "limeiot_ota_log.h"
#include "ota_host_crypto.h"
#include "cJSON.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

typedef struct {
    const char *path, *fault;
    int64_t now;
    bool trusted;
    unsigned reads, attempts, durable, clocks;
} host_t;
static const cJSON *field(const cJSON *v, const char *key) { return cJSON_GetObjectItemCaseSensitive(v,key); }
static const char *text(const cJSON *v, const char *key) { return cJSON_GetStringValue(field(v,key)); }
static double number(const cJSON *v, const char *key) { const cJSON *n=field(v,key); return cJSON_IsNumber(n)?n->valuedouble:0; }
static bool fault(const host_t *h, const char *name) { return h->fault&&!strcmp(h->fault,name); }
static char *load(const char *path, size_t limit, size_t *length) {
    FILE *f=fopen(path,"rb"); if (!f) return NULL;
    char *raw=calloc(limit+2,1); if (!raw) { fclose(f); return NULL; }
    *length=fread(raw,1,limit+1,f); bool ok=!ferror(f); fclose(f);
    if (!ok||*length>limit) { free(raw); return NULL; } return raw;
}
static bool read_state(void *context, char *data, size_t capacity, size_t *length, bool *found) {
    host_t *h=context; h->reads++; if (fault(h,"read")) return false;
    FILE *f=fopen(h->path,"rb");
    if (!f) { *length=0; *found=false; return errno==ENOENT; }
    *found=true; *length=fread(data,1,capacity,f);
    bool ok=!ferror(f)&&fgetc(f)==EOF; fclose(f); return ok;
}
static bool write_state(void *context, const char *data, size_t length) {
    host_t *h=context; h->attempts++; if (fault(h,"before")) return false;
    size_t size=strlen(h->path)+8; char *temporary=malloc(size), *directory=strdup(h->path);
    if (!temporary||!directory) { free(temporary); free(directory); return false; }
    snprintf(temporary,size,"%s.next",h->path);
    FILE *f=fopen(temporary,"wb"); bool ok=f!=NULL;
    if (f) { ok=fwrite(data,1,length,f)==length&&fflush(f)==0&&fsync(fileno(f))==0; if (fclose(f)!=0) ok=false; }
    if (ok) ok=rename(temporary,h->path)==0;
    char *slash=strrchr(directory,'/'); if (slash) *slash=0; else strcpy(directory,".");
    int descriptor=ok?open(*directory?directory:"/",O_RDONLY|O_DIRECTORY):-1;
    if (descriptor<0) ok=false; else { if (fsync(descriptor)!=0) ok=false; close(descriptor); }
    free(temporary); free(directory);
    if (ok) h->durable++;
    return ok&&!fault(h,"after");
}
static bool clock_ms(void *context, int64_t *now) { host_t *h=context; h->clocks++; *now=h->now; return h->trusted; }
static li_ota_stage_t stage(const char *name) {
    for (unsigned i=0;i<=LI_OTA_ROLLED_BACK;i++) if (name&&!strcmp(name,li_ota_stage_name((li_ota_stage_t)i))) return (li_ota_stage_t)i;
    return (li_ota_stage_t)99;
}
static void copy(char *out, size_t capacity, const char *value) {
    if (!value) { *out=0; return; }
    size_t length=strlen(value); memset(out,'!',capacity);
    if (length<capacity) memcpy(out,value,length+1);
}
static li_ota_baseline_t baseline(const cJSON *v) {
    li_ota_baseline_t out={0}; copy(out.firmware_version,sizeof(out.firmware_version),text(v,"firmware_version"));
    copy(out.image_sha256,sizeof(out.image_sha256),text(v,"image_sha256"));
    out.security_epoch=(uint32_t)number(v,"security_epoch"); return out;
}
static li_ota_outcome_t outcome(const cJSON *v) {
    li_ota_outcome_t out={0};
    copy(out.boot_id,sizeof(out.boot_id),text(v,"boot_id")); copy(out.firmware_version,sizeof(out.firmware_version),text(v,"firmware_version"));
    copy(out.image_sha256,sizeof(out.image_sha256),text(v,"image_sha256")); copy(out.error,sizeof(out.error),text(v,"error"));
    out.security_epoch=(uint32_t)number(v,"security_epoch"); out.pending_update=cJSON_IsTrue(field(v,"pending_update")); return out;
}
static cJSON *view_json(const li_ota_log_view_t *v, const char *request) {
    cJSON *o=cJSON_CreateObject();
    cJSON_AddStringToObject(o,"task_id",v->task_id); cJSON_AddStringToObject(o,"execution_id",v->execution_id);
    cJSON_AddStringToObject(o,"request_digest",v->request_digest); cJSON_AddStringToObject(o,"manifest_digest",v->manifest_digest);
    cJSON_AddStringToObject(o,"boot_binding",v->boot_binding); cJSON_AddNumberToObject(o,"target_size_bytes",v->target_size_bytes);
    cJSON_AddStringToObject(o,"stage",li_ota_stage_name(v->stage)); cJSON_AddBoolToObject(o,"recovered",v->recovered);
    cJSON_AddNumberToObject(o,"expires_ms",(double)v->expires_ms); cJSON_AddStringToObject(o,"original_raw",request);
    cJSON_AddItemToObject(o,"original",cJSON_Parse(request));
    if (v->stage>=LI_OTA_SUCCEEDED) {
        cJSON *r=cJSON_AddObjectToObject(o,"outcome");
        cJSON_AddStringToObject(r,"boot_id",v->outcome.boot_id); cJSON_AddStringToObject(r,"firmware_version",v->outcome.firmware_version);
        cJSON_AddStringToObject(r,"image_sha256",v->outcome.image_sha256); cJSON_AddStringToObject(r,"error",v->outcome.error);
        cJSON_AddNumberToObject(r,"security_epoch",v->outcome.security_epoch); cJSON_AddBoolToObject(r,"pending_update",v->outcome.pending_update);
    }
    return o;
}
int main(int argc, char **argv) {
    if (argc!=3) return 5;
    size_t length=0; char *raw=load(argv[1],262144,&length);
    cJSON *plan=raw?cJSON_ParseWithLength(raw,length):NULL; free(raw); if (!plan) return 5;
    host_t host={.path=argv[2],.fault=text(plan,"fault"),.now=(int64_t)number(plan,"now"),.trusted=true};
    li_config_t identity={.space_id=text(plan,"space_id"),.device_id=text(plan,"device_id")};
    li_ota_crypto_t crypto={NULL,hash,verify}; li_ota_log_ports_t ports={&host,read_state,write_state,clock_ms};
    li_error_t error=LI_INVALID; li_ota_log_t *log=li_ota_log_open(&identity,&crypto,&ports,&error);
    cJSON *output=cJSON_CreateObject(), *results=cJSON_AddArrayToObject(output,"results");
    cJSON_AddNumberToObject(output,"open_error",error); cJSON_AddBoolToObject(output,"opened",log!=NULL);
    const cJSON *steps=field(plan,"steps");
    for (const cJSON *s=log&&steps?steps->child:NULL;s;s=s->next) {
        const char *op=text(s,"op"); if (!op) break;
        host.fault=text(s,"fault");
        if (cJSON_IsNumber(field(s,"now"))) host.now=(int64_t)cJSON_GetNumberValue(field(s,"now"));
        if (cJSON_IsBool(field(s,"trusted"))) host.trusted=cJSON_IsTrue(field(s,"trusted"));
        cJSON *result=cJSON_CreateObject(); cJSON_AddItemToArray(results,result); cJSON_AddStringToObject(result,"op",op);
        if (!strcmp(op,"prepare")) {
            char *request=NULL; size_t bytes=0; const char *filename=text(s,"request_file");
            if (filename) request=load(filename,LI_MAX_PACKET+1,&bytes);
            else { request=cJSON_PrintUnformatted(field(s,"request")); if (request) bytes=strlen(request); }
            li_ota_baseline_t b=baseline(field(s,"baseline")); error=li_ota_log_prepare(log,request,bytes,&b); free(request);
        } else if (!strcmp(op,"advance")) error=li_ota_log_advance(log,text(s,"execution_id"),stage(text(s,"stage")));
        else if (!strcmp(op,"bind")) error=li_ota_log_bind_boot(log,text(s,"execution_id"),text(s,"binding"));
        else if (!strcmp(op,"finish")) { li_ota_outcome_t o=outcome(field(s,"outcome")); error=li_ota_log_finish(log,text(s,"execution_id"),stage(text(s,"stage")),&o); }
        else if (!strcmp(op,"get")) {
            const li_ota_log_view_t *v=(const li_ota_log_view_t *)1; const char *request=(const char *)1;
            error=li_ota_log_get(log,text(s,"execution_id"),&v,&request);
            cJSON_AddBoolToObject(result,"cleared",!v&&!request);
            if (error==LI_OK) cJSON_AddItemToObject(result,"view",view_json(v,request));
        } else if (!strcmp(op,"reopen")) { li_ota_log_close(log); log=li_ota_log_open(&identity,&crypto,&ports,&error); }
        else error=LI_INVALID;
        cJSON_AddNumberToObject(result,"code",error); cJSON_AddBoolToObject(result,"blocked",li_ota_log_blocked(log));
        cJSON_AddNumberToObject(result,"writes",host.attempts); cJSON_AddNumberToObject(result,"durable_writes",host.durable);
        cJSON_AddNumberToObject(result,"clock_reads",host.clocks); cJSON_AddNumberToObject(result,"storage_reads",host.reads);
    }
    char *encoded=cJSON_PrintUnformatted(output); if (encoded) puts(encoded);
    free(encoded); cJSON_Delete(output); li_ota_log_close(log); cJSON_Delete(plan); return 0;
}
