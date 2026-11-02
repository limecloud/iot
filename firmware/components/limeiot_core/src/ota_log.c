/* 同一完整快照保存原请求与执行状态；恢复和查询绝不触发设备副作用。 */
#include "limeiot_ota_log.h"
#include "ota_internal.h"
#include <stdlib.h>
#include <string.h>

typedef struct { li_ota_log_view_t view; char *request; } record_t;
struct li_ota_log {
    li_config_t identity;
    li_ota_crypto_t crypto;
    li_ota_log_ports_t ports;
    record_t *records[LI_OTA_LOG_SLOTS];
    bool faulted;
};
#define KEYS(object, ...) li_ota_object_fields(object, (const char *const[]){__VA_ARGS__}, sizeof((const char *const[]){__VA_ARGS__})/sizeof(const char *))
static const cJSON *field(const cJSON *root, const char *name) { return cJSON_GetObjectItemCaseSensitive(root,name); }
static const char *text(const cJSON *root, const char *name) { return cJSON_GetStringValue(field(root,name)); }
static bool equal(const cJSON *root, const char *name, const char *value) { const char *actual=text(root,name); return actual && !strcmp(actual,value); }
bool li_ota_identifier(const char *value) {
    if (!value || !*value || strlen(value)>=LI_OTA_LOG_ID_SIZE) return false;
    for (const char *p=value; *p; p++) if (!((*p>='a'&&*p<='z')||(*p>='A'&&*p<='Z')||(*p>='0'&&*p<='9')||*p=='_'||*p=='-')) return false;
    return true;
}
static bool terminated(const char *value, size_t size) { return memchr(value,0,size)!=NULL; }
static bool baseline_valid(const li_ota_baseline_t *v) {
    return v && terminated(v->firmware_version,sizeof(v->firmware_version)) && terminated(v->image_sha256,sizeof(v->image_sha256))
        && li_ota_version_valid(v->firmware_version) && li_ota_digest_valid(v->image_sha256);
}
const char *li_ota_stage_name(li_ota_stage_t stage) {
    static const char *const names[] = {"intent","installing","awaiting_boot","succeeded","rejected","failed","rolled_back"};
    return (unsigned)stage<sizeof(names)/sizeof(*names) ? names[stage] : NULL;
}
static bool terminal(li_ota_stage_t stage) { return stage>=LI_OTA_SUCCEEDED && stage<=LI_OTA_ROLLED_BACK; }
bool li_ota_deadline(const char *value, int64_t *ms) {
    if (!value) return false;
    size_t length=strlen(value); int64_t seconds=0;
    if (length==20) { if (!li_ota_time_parse(value,&seconds)) return false; *ms=seconds*1000; return true; }
    if (length<22 || length>30 || value[19]!='.' || value[length-1]!='Z') return false;
    char whole[21]; memcpy(whole,value,19); whole[19]='Z'; whole[20]=0;
    if (!li_ota_time_parse(whole,&seconds)) return false;
    unsigned fraction=0;
    for (size_t i=20; i<length-1; i++) {
        if (value[i]<'0'||value[i]>'9') return false;
        if (i<23) fraction+=(unsigned)(value[i]-'0')*(i==20?100U:i==21?10U:1U);
    }
    *ms=seconds*1000+fraction; return true;
}
cJSON *li_ota_install_parse(const li_config_t *identity, const li_ota_crypto_t *crypto, const char *raw, size_t length, li_ota_log_view_t *view) {
    if (!view) return NULL;
    memset(view,0,sizeof(*view));
    cJSON *root=li_ota_document_parse(raw,length); if (!root) return NULL;
    uint32_t version=0;
    const cJSON *body=field(root,"body"), *manifest=field(body,"manifest"), *statement=field(manifest,"statement");
    const char *task=text(body,"task_id"), *execution=text(body,"execution_id"), *boot=text(root,"boot_id"), *session=text(root,"session_id");
    if (!identity || !crypto || !KEYS(root,"v","kind","message_id","device_id","model_revision","boot_id","session_id","body")
        || !li_ota_uint32(field(root,"v"),&version) || version!=1 || !equal(root,"kind","ota_install")
        || !li_ota_identifier(text(root,"message_id")) || !equal(root,"device_id",identity->device_id) || !li_ota_digest_valid(text(root,"model_revision"))
        || !li_ota_identifier(boot) || !li_ota_identifier(session) || !KEYS(body,"task_id","execution_id","manifest_digest","manifest","expires_at")
        || !li_ota_identifier(task) || strncmp(task,"ota-",4) || !task[4] || !li_ota_identifier(execution) || !li_ota_deadline(text(body,"expires_at"),&view->expires_ms)
        || !cJSON_IsObject(manifest) || !li_ota_json_hash(crypto,manifest,LI_MAX_PACKET,view->manifest_digest)
        || !equal(body,"manifest_digest",view->manifest_digest) || !li_ota_version_valid(text(statement,"version"))
        || !li_ota_uint32(field(statement,"size_bytes"),&view->target_size_bytes) || !view->target_size_bytes || view->target_size_bytes>UINT32_C(33554432)
        || !li_ota_digest_valid(text(statement,"sha256")) || !li_ota_uint32(field(statement,"security_epoch"),&view->target_security_epoch)
        || !li_ota_json_hash(crypto,root,LI_MAX_PACKET,view->request_digest)) goto fail;
    strcpy(view->task_id,task); strcpy(view->execution_id,execution); strcpy(view->boot_id,boot); strcpy(view->session_id,session);
    strcpy(view->target_version,text(statement,"version")); strcpy(view->target_image_sha256,text(statement,"sha256"));
    return root;
fail:
    memset(view,0,sizeof(*view)); cJSON_Delete(root); return NULL;
}
static record_t *request_decode(li_ota_log_t *log, const char *raw, size_t length) {
    record_t *r=calloc(1,sizeof(*r)); if (!r) return NULL;
    cJSON *root=li_ota_install_parse(&log->identity,&log->crypto,raw,length,&r->view);
    if (root) r->request=li_ota_json_encode(root,LI_MAX_PACKET,NULL);
    cJSON_Delete(root);
    if (!r->request) { free(r); return NULL; } return r;
}
static bool outcome_valid(const record_t *r, li_ota_stage_t stage, const li_ota_outcome_t *value) {
    if (!terminal(stage) || !value || !terminated(value->boot_id,sizeof(value->boot_id)) || !terminated(value->firmware_version,sizeof(value->firmware_version))
        || !terminated(value->image_sha256,sizeof(value->image_sha256)) || !terminated(value->error,sizeof(value->error))
        || !li_ota_identifier(value->boot_id) || value->pending_update) return false;
    bool success=stage==LI_OTA_SUCCEEDED;
    if (strcmp(value->firmware_version,success?r->view.target_version:r->view.baseline.firmware_version)
        || value->security_epoch!=(success?r->view.target_security_epoch:r->view.baseline.security_epoch)
        || strcmp(value->image_sha256,success?r->view.target_image_sha256:r->view.baseline.image_sha256)
        || ((success||stage==LI_OTA_ROLLED_BACK) && !strcmp(value->boot_id,r->view.boot_id))) return false;
    if (success) return !value->error[0];
    if (value->error[0]<'a'||value->error[0]>'z') return false;
    for (const char *p=value->error; *p; p++) if (!((*p>='a'&&*p<='z')||(*p>='0'&&*p<='9')||*p=='_')) return false;
    return true;
}
static cJSON *baseline_json(const li_ota_baseline_t *v) {
    cJSON *out=cJSON_CreateObject();
    if (!out || !cJSON_AddStringToObject(out,"firmware_version",v->firmware_version) || !cJSON_AddNumberToObject(out,"security_epoch",v->security_epoch)
        || !cJSON_AddStringToObject(out,"image_sha256",v->image_sha256)) { cJSON_Delete(out); return NULL; }
    return out;
}
static cJSON *outcome_json(const record_t *r) {
    if (!terminal(r->view.stage)) return cJSON_CreateNull();
    const li_ota_outcome_t *v=&r->view.outcome; cJSON *out=cJSON_CreateObject();
    if (!out || !cJSON_AddStringToObject(out,"boot_id",v->boot_id) || !cJSON_AddStringToObject(out,"firmware_version",v->firmware_version)
        || !cJSON_AddNumberToObject(out,"security_epoch",v->security_epoch) || !cJSON_AddStringToObject(out,"image_sha256",v->image_sha256)
        || !cJSON_AddBoolToObject(out,"pending_update",v->pending_update) || !(v->error[0]?cJSON_AddStringToObject(out,"error",v->error):cJSON_AddNullToObject(out,"error"))) {
        cJSON_Delete(out); return NULL;
    }
    return out;
}
static bool attach(cJSON *parent, const char *key, cJSON *value) {
    if (!value) return false;
    bool ok=key?cJSON_AddItemToObject(parent,key,value):cJSON_AddItemToArray(parent,value);
    if (!ok) cJSON_Delete(value);
    return ok;
}
static char *snapshot(li_ota_log_t *log, record_t *const records[LI_OTA_LOG_SLOTS], size_t *length) {
    cJSON *root=cJSON_CreateObject(), *items=NULL; char *raw=NULL; char digest[72];
    if (!root || !cJSON_AddNumberToObject(root,"version",2) || !cJSON_AddStringToObject(root,"space_id",log->identity.space_id)
        || !cJSON_AddStringToObject(root,"device_id",log->identity.device_id) || !(items=cJSON_AddArrayToObject(root,"records"))) goto finish;
    for (size_t i=0;i<LI_OTA_LOG_SLOTS;i++) {
        const record_t *r=records[i]; if (!r) continue;
        cJSON *item=cJSON_CreateObject(); if (!item) goto finish;
        if (!attach(items,NULL,item)) goto finish;
        if (!attach(item,"request",li_ota_document_parse(r->request,strlen(r->request))) || !attach(item,"baseline",baseline_json(&r->view.baseline))
            || !attach(item,"boot_binding",r->view.boot_binding[0]?cJSON_CreateString(r->view.boot_binding):cJSON_CreateNull())
            || !cJSON_AddStringToObject(item,"stage",li_ota_stage_name(r->view.stage)) || !attach(item,"outcome",outcome_json(r))) goto finish;
    }
    if (!li_ota_json_hash(&log->crypto,root,LI_OTA_LOG_BYTES,digest) || !cJSON_AddStringToObject(root,"checksum",digest)) goto finish;
    raw=li_ota_json_encode(root,LI_OTA_LOG_BYTES,length);
    if (raw) {
        cJSON *bounded=li_ota_document_parse_limit(raw,*length,LI_OTA_LOG_BYTES);
        if (!bounded) { free(raw); raw=NULL; } cJSON_Delete(bounded);
    }
finish:
    cJSON_Delete(root); return raw;
}
static li_error_t commit(li_ota_log_t *log, record_t *const records[LI_OTA_LOG_SLOTS]) {
    size_t length=0; char *raw=snapshot(log,records,&length); if (!raw) return LI_CAPACITY;
    bool saved=log->ports.write(log->ports.context,raw,length); free(raw);
    if (!saved) { log->faulted=true; return LI_STORAGE; } return LI_OK;
}
static bool baseline_read(const cJSON *root, li_ota_baseline_t *out) {
    if (!KEYS(root,"firmware_version","security_epoch","image_sha256") || !li_ota_version_valid(text(root,"firmware_version"))
        || !li_ota_digest_valid(text(root,"image_sha256")) || !li_ota_uint32(field(root,"security_epoch"),&out->security_epoch)) return false;
    strcpy(out->firmware_version,text(root,"firmware_version")); strcpy(out->image_sha256,text(root,"image_sha256")); return true;
}
static bool outcome_read(const cJSON *root, const record_t *r, li_ota_outcome_t *out) {
    if (!KEYS(root,"boot_id","firmware_version","security_epoch","image_sha256","pending_update","error") || !li_ota_identifier(text(root,"boot_id"))
        || !li_ota_version_valid(text(root,"firmware_version")) || !li_ota_digest_valid(text(root,"image_sha256"))
        || !li_ota_uint32(field(root,"security_epoch"),&out->security_epoch) || !cJSON_IsFalse(field(root,"pending_update"))) return false;
    const char *error=text(root,"error");
    if ((!error&&!cJSON_IsNull(field(root,"error"))) || (error&&(!*error||strlen(error)>64))) return false;
    strcpy(out->boot_id,text(root,"boot_id")); strcpy(out->firmware_version,text(root,"firmware_version")); strcpy(out->image_sha256,text(root,"image_sha256"));
    if (error) strcpy(out->error,error);
    return outcome_valid(r,r->view.stage,out);
}
static bool restore(li_ota_log_t *log, const char *raw, size_t length) {
    cJSON *root=li_ota_document_parse_limit(raw,length,LI_OTA_LOG_BYTES); if (!root) return false;
    bool valid=false; uint32_t version=0; char computed[72];
    const char *digest=text(root,"checksum");
    if (!KEYS(root,"version","space_id","device_id","records","checksum") || !li_ota_uint32(field(root,"version"),&version) || (version!=1&&version!=2)
        || !equal(root,"space_id",log->identity.space_id) || !equal(root,"device_id",log->identity.device_id) || !li_ota_digest_valid(digest)) goto finish;
    char expected[72]; strcpy(expected,digest);
    cJSON_Delete(cJSON_DetachItemFromObjectCaseSensitive(root,"checksum"));
    if (!li_ota_json_hash(&log->crypto,root,LI_OTA_LOG_BYTES,computed) || strcmp(expected,computed)) goto finish;
    const cJSON *items=field(root,"records");
    if (!cJSON_IsArray(items) || cJSON_GetArraySize(items)>LI_OTA_LOG_SLOTS) goto finish;
    size_t count=0, pending=0;
    for (const cJSON *p=items->child;p;p=p->next) {
        if (!(version==1?KEYS(p,"request","baseline","stage","outcome"):KEYS(p,"request","baseline","stage","outcome","boot_binding"))) goto finish;
        size_t request_length=0; char *request=li_ota_json_encode(field(p,"request"),LI_MAX_PACKET,&request_length);
        if (!request) goto finish;
        record_t *r=request_decode(log,request,request_length); free(request); if (!r) goto finish;
        log->records[count++]=r;
        const char *stage=text(p,"stage"); bool known=false;
        for (unsigned i=0;i<=LI_OTA_ROLLED_BACK;i++) if (stage&&!strcmp(stage,li_ota_stage_name((li_ota_stage_t)i))) { r->view.stage=(li_ota_stage_t)i; known=true; break; }
        if (!known || !baseline_read(field(p,"baseline"),&r->view.baseline)) goto finish;
        if (terminal(r->view.stage)) { if (!outcome_read(field(p,"outcome"),r,&r->view.outcome)) goto finish; }
        else { if (!cJSON_IsNull(field(p,"outcome")) || ++pending>1) goto finish; r->view.recovered=true; }
        if (version==2) {
            const char *binding=text(p,"boot_binding");
            if (binding) {
                if (!li_ota_identifier(binding) || (r->view.stage!=LI_OTA_AWAITING_BOOT&&r->view.stage!=LI_OTA_SUCCEEDED&&r->view.stage!=LI_OTA_ROLLED_BACK)) goto finish;
                strcpy(r->view.boot_binding,binding);
            } else if (!cJSON_IsNull(field(p,"boot_binding"))) goto finish;
        }
        for (size_t i=0;i+1<count;i++) if (!strcmp(log->records[i]->view.execution_id,r->view.execution_id) || !strcmp(log->records[i]->view.task_id,r->view.task_id)) goto finish;
    }
    valid=true;
finish:
    cJSON_Delete(root); return valid;
}
li_ota_log_t *li_ota_log_open(const li_config_t *identity, const li_ota_crypto_t *crypto, const li_ota_log_ports_t *ports, li_error_t *error) {
    if (error) *error=LI_INVALID;
    if (!identity || !li_ota_identifier(identity->space_id) || !li_ota_identifier(identity->device_id) || !crypto || !crypto->sha256 || !ports || !ports->read || !ports->write || !ports->trusted_unix_ms) return NULL;
    li_ota_log_t *log=calloc(1,sizeof(*log)); char *raw=malloc(LI_OTA_LOG_BYTES);
    if (!log || !raw) { free(raw); free(log); if (error) *error=LI_CAPACITY; return NULL; }
    log->identity=*identity; log->crypto=*crypto; log->ports=*ports;
    size_t length=0; bool found=false;
    bool valid=ports->read(ports->context,raw,LI_OTA_LOG_BYTES,&length,&found) && length<=LI_OTA_LOG_BYTES
        && (found?restore(log,raw,length):length==0);
    free(raw);
    if (!valid) { li_ota_log_close(log); if (error) *error=LI_STORAGE; return NULL; }
    if (error) *error=LI_OK;
    return log;
}
void li_ota_log_close(li_ota_log_t *log) {
    if (!log) return;
    for (size_t i=0;i<LI_OTA_LOG_SLOTS;i++) if (log->records[i]) { free(log->records[i]->request); free(log->records[i]); }
    free(log);
}
static int locate(const li_ota_log_t *log, const char *execution) {
    if (!execution) return -1;
    for (size_t i=0;i<LI_OTA_LOG_SLOTS;i++) if (log->records[i]&&!strcmp(log->records[i]->view.execution_id,execution)) return (int)i;
    return -1;
}
bool li_ota_log_blocked(const li_ota_log_t *log) {
    if (!log || log->faulted) return true;
    for (size_t i=0;i<LI_OTA_LOG_SLOTS;i++) if (log->records[i]&&!terminal(log->records[i]->view.stage)) return true;
    return false;
}
li_error_t li_ota_log_get(const li_ota_log_t *log, const char *execution, const li_ota_log_view_t **view, const char **request) {
    if (view) *view=NULL;
    if (request) *request=NULL;
    if (!log) return LI_INVALID;
    if (log->faulted) return LI_STORAGE;
    int slot=locate(log,execution); if (slot<0) return LI_IGNORED;
    if (view) *view=&log->records[slot]->view;
    if (request) *request=log->records[slot]->request;
    return LI_OK;
}
li_error_t li_ota_log_pending(const li_ota_log_t *log, const li_ota_log_view_t **view) {
    if (view) *view=NULL;
    if (!log || !view) return LI_INVALID;
    if (log->faulted) return LI_STORAGE;
    for (size_t i=0;i<LI_OTA_LOG_SLOTS;i++) if (log->records[i]&&!terminal(log->records[i]->view.stage)) {
        *view=&log->records[i]->view; return LI_OK;
    }
    return LI_IGNORED;
}
li_error_t li_ota_log_prepare(li_ota_log_t *log, const char *raw, size_t length, const li_ota_baseline_t *baseline) {
    if (!log || !raw) return LI_INVALID;
    if (log->faulted) return LI_STORAGE;
    record_t *fresh=request_decode(log,raw,length); if (!fresh) return LI_INVALID;
    li_error_t error=LI_INVALID; record_t *proposed[LI_OTA_LOG_SLOTS]; memcpy(proposed,log->records,sizeof(proposed));
    for (size_t i=0;i<LI_OTA_LOG_SLOTS;i++) if (proposed[i]) {
        const li_ota_log_view_t *old=&proposed[i]->view;
        if (!strcmp(old->execution_id,fresh->view.execution_id)||!strcmp(old->task_id,fresh->view.task_id)) {
            error=!strcmp(old->request_digest,fresh->view.request_digest)?LI_IGNORED:LI_CONFLICT; goto finish;
        }
    }
    for (size_t i=0;i<LI_OTA_LOG_SLOTS;i++) if (proposed[i]&&!terminal(proposed[i]->view.stage)) { error=LI_CONFLICT; goto finish; }
    if (!baseline_valid(baseline)) goto finish;
    int64_t now=-1; error=LI_CLOCK;
    if (!log->ports.trusted_unix_ms(log->ports.context,&now) || now<0 || now>INT64_C(253402300799999)) goto finish;
    error=LI_EXPIRED; if (now>=fresh->view.expires_ms) goto finish;
    int slot=-1;
    for (size_t i=0;i<LI_OTA_LOG_SLOTS;i++) if (!proposed[i] || proposed[i]->view.expires_ms<=now) { slot=(int)i; break; }
    error=LI_CAPACITY; if (slot<0) goto finish;
    fresh->view.baseline=*baseline; proposed[slot]=fresh;
    error=commit(log,proposed);
    if (error==LI_OK) {
        if (log->records[slot]) { free(log->records[slot]->request); free(log->records[slot]); }
        log->records[slot]=fresh; fresh=NULL;
    }
finish:
    if (fresh) { free(fresh->request); free(fresh); } return error;
}
static li_error_t replace(li_ota_log_t *log, int slot, const record_t *value) {
    record_t *proposed[LI_OTA_LOG_SLOTS]; memcpy(proposed,log->records,sizeof(proposed)); proposed[slot]=(record_t *)value;
    li_error_t error=commit(log,proposed); if (error==LI_OK) *log->records[slot]=*value; return error;
}
li_error_t li_ota_log_advance(li_ota_log_t *log, const char *execution, li_ota_stage_t next) {
    if (!log) return LI_INVALID;
    if (log->faulted) return LI_STORAGE;
    int slot=locate(log,execution); if (slot<0) return LI_IGNORED;
    record_t value=*log->records[slot];
    if (value.view.recovered || !((value.view.stage==LI_OTA_INTENT&&next==LI_OTA_INSTALLING)||(value.view.stage==LI_OTA_INSTALLING&&next==LI_OTA_AWAITING_BOOT))) return LI_CONFLICT;
    if (next==LI_OTA_INSTALLING) {
        int64_t now=-1;
        if (!log->ports.trusted_unix_ms(log->ports.context,&now) || now<0 || now>INT64_C(253402300799999)) return LI_CLOCK;
        if (now>=value.view.expires_ms) return LI_EXPIRED;
    }
    value.view.stage=next; return replace(log,slot,&value);
}
li_error_t li_ota_log_bind_boot(li_ota_log_t *log, const char *execution, const char *binding) {
    if (!log || !li_ota_identifier(binding)) return LI_INVALID;
    if (log->faulted) return LI_STORAGE;
    int slot=locate(log,execution); if (slot<0) return LI_IGNORED;
    record_t value=*log->records[slot];
    if (value.view.boot_binding[0]) return !strcmp(value.view.boot_binding,binding)?LI_IGNORED:LI_CONFLICT;
    if (value.view.recovered || value.view.stage!=LI_OTA_AWAITING_BOOT) return LI_CONFLICT;
    strcpy(value.view.boot_binding,binding); return replace(log,slot,&value);
}
li_error_t li_ota_log_finish(li_ota_log_t *log, const char *execution, li_ota_stage_t next, const li_ota_outcome_t *outcome) {
    if (!log) return LI_INVALID;
    if (log->faulted) return LI_STORAGE;
    int slot=locate(log,execution); if (slot<0) return LI_IGNORED;
    record_t value=*log->records[slot];
    if (!outcome_valid(&value,next,outcome)) return LI_INVALID;
    if (terminal(value.view.stage)) {
        const li_ota_outcome_t *old=&value.view.outcome;
        return value.view.stage==next && !strcmp(old->boot_id,outcome->boot_id) && !strcmp(old->firmware_version,outcome->firmware_version)
            && !strcmp(old->image_sha256,outcome->image_sha256) && !strcmp(old->error,outcome->error)
            && old->security_epoch==outcome->security_epoch && old->pending_update==outcome->pending_update ? LI_IGNORED:LI_CONFLICT;
    }
    if ((next==LI_OTA_SUCCEEDED||next==LI_OTA_ROLLED_BACK)&&value.view.stage==LI_OTA_INTENT) return LI_CONFLICT;
    if (next==LI_OTA_REJECTED&&value.view.stage!=LI_OTA_INTENT) return LI_CONFLICT;
    if (value.view.boot_binding[0] && next!=LI_OTA_SUCCEEDED && next!=LI_OTA_ROLLED_BACK) return LI_CONFLICT;
    value.view.stage=next; value.view.outcome=*outcome; value.view.recovered=false;
    return replace(log,slot,&value);
}
