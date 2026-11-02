/* OTA网络消费只读取独立配置与本机证据，不接受下行提供安装信任。 */
#include "internal.h"
#include "ota_internal.h"
#include <stdlib.h>
#include <string.h>

struct li_ota_device {
    li_ota_log_t *log;
    li_ota_crypto_t crypto;
    const li_ota_policy_t *policy;
    li_ota_device_ports_t ports;
    li_ota_installer_t installer;
    li_ota_boot_observer_t observer;
    int64_t last_probe;
};
#define KEYS(object, ...) li_ota_object_fields(object,(const char *const[]){__VA_ARGS__},sizeof((const char *const[]){__VA_ARGS__})/sizeof(const char *))
static const cJSON *field(const cJSON *root, const char *key) { return cJSON_GetObjectItemCaseSensitive(root,key); }
static const char *text(const cJSON *root, const char *key) { return cJSON_GetStringValue(field(root,key)); }
static bool equal(const cJSON *root, const char *key, const char *value) { const char *s=text(root,key); return s&&!strcmp(s,value); }
li_error_t li_ota_device_attach(li_core_t *core, li_ota_log_t *log, const li_ota_crypto_t *crypto,
                               const li_ota_policy_t *policy, const li_ota_device_ports_t *ports) {
    if (!core || core->connected || core->ota || !log || !crypto || !crypto->sha256 || !crypto->ed25519_verify || !ports || !ports->read_running || !ports->trusted_unix_seconds
        || (policy&&li_ota_policy_validate(crypto,policy)!=LI_OK)) return LI_INVALID;
    core->ota=calloc(1,sizeof(*core->ota)); if (!core->ota) return LI_CAPACITY;
    *core->ota=(struct li_ota_device){.log=log,.crypto=*crypto,.policy=policy,.ports=*ports}; return LI_OK;
}
li_error_t li_ota_device_set_installer(li_core_t *core, const li_ota_installer_t *installer) {
    if (!core || core->connected || !core->ota || core->ota->installer.stage || !core->ota->policy || !installer
        || !installer->current || !installer->stage || !installer->activate || !installer->restart) return LI_INVALID;
    core->ota->installer=*installer; return LI_OK;
}
li_error_t li_ota_device_set_boot_observer(li_core_t *core, const li_ota_boot_observer_t *observer) {
    if (!core || core->connected || !core->ota || core->ota->observer.read || !observer || !observer->read) return LI_INVALID;
    core->ota->observer=*observer; return LI_OK;
}
void li_ota_device_drop(li_core_t *core) { free(core->ota); core->ota=NULL; }
bool li_ota_device_blocked(const li_core_t *core) { return core->ota&&li_ota_log_blocked(core->ota->log); }
static bool running(li_core_t *core, li_ota_baseline_t *out) {
    bool pending=true; memset(out,0,sizeof(*out));
    return core->ota->ports.read_running(core->ota->ports.context,out,&pending) && !pending
        && memchr(out->firmware_version,0,sizeof(out->firmware_version)) && memchr(out->image_sha256,0,sizeof(out->image_sha256))
        && li_ota_version_valid(out->firmware_version) && !strcmp(out->firmware_version,core->config.firmware_version)
        && li_ota_digest_valid(out->image_sha256);
}
static bool observed(li_core_t *core, const li_ota_log_view_t *view, li_ota_stage_t *stage, li_ota_outcome_t *outcome) {
    memset(outcome,0,sizeof(*outcome)); *stage=LI_OTA_INTENT;
    if (!core->ota->observer.read || !view->boot_binding[0] || !strcmp(view->boot_id,core->boot)
        || !core->ota->observer.read(core->ota->observer.context,view,stage,outcome)
        || (*stage!=LI_OTA_SUCCEEDED&&*stage!=LI_OTA_ROLLED_BACK) || outcome->pending_update
        || !memchr(outcome->firmware_version,0,sizeof(outcome->firmware_version))
        || strcmp(outcome->firmware_version,core->config.firmware_version)) return false;
    strcpy(outcome->boot_id,core->boot); return true;
}
static li_error_t report(li_core_t *core, const li_ota_log_view_t *v) {
    if (v->stage==LI_OTA_INTENT || (v->stage<LI_OTA_SUCCEEDED&&v->recovered)) return LI_IGNORED;
    if (v->stage<LI_OTA_SUCCEEDED && strcmp(v->boot_id,core->boot)) return LI_IGNORED;
    if ((v->stage==LI_OTA_SUCCEEDED||v->stage==LI_OTA_ROLLED_BACK)&&!strcmp(v->boot_id,core->boot)) return LI_IGNORED;
    if ((v->stage==LI_OTA_SUCCEEDED||v->stage==LI_OTA_ROLLED_BACK)&&v->boot_binding[0]) {
        li_ota_outcome_t actual; li_ota_stage_t stage;
        if (!observed(core,v,&stage,&actual) || stage!=v->stage
            || !memchr(actual.image_sha256,0,sizeof(actual.image_sha256)) || !memchr(actual.error,0,sizeof(actual.error))
            || strcmp(actual.firmware_version,v->outcome.firmware_version) || strcmp(actual.image_sha256,v->outcome.image_sha256)
            || actual.security_epoch!=v->outcome.security_epoch || strcmp(actual.error,v->outcome.error)) return LI_IGNORED;
        return li_publish(core,"ota_result",li_codec_ota_result(core,v));
    }
    li_ota_baseline_t local;
    if (!running(core,&local)) return LI_DRIVER;
    const char *version=v->stage>=LI_OTA_SUCCEEDED?v->outcome.firmware_version:v->baseline.firmware_version;
    const char *image=v->stage>=LI_OTA_SUCCEEDED?v->outcome.image_sha256:v->baseline.image_sha256;
    uint32_t epoch=v->stage>=LI_OTA_SUCCEEDED?v->outcome.security_epoch:v->baseline.security_epoch;
    if (strcmp(local.firmware_version,version)||strcmp(local.image_sha256,image)||local.security_epoch!=epoch) return LI_IGNORED;
    return li_publish(core,"ota_result",li_codec_ota_result(core,v));
}
li_error_t li_ota_device_reconcile(li_core_t *core) {
    if (!core->ota || !core->ota->observer.read || !li_ready(core)) return LI_IGNORED;
    int64_t now=core->ports.monotonic_ms(core->ports.context);
    if (now<0 || now<core->ota->last_probe) return LI_CLOCK;
    if (now-core->ota->last_probe<1000) return LI_IGNORED;
    core->ota->last_probe=now;
    const li_ota_log_view_t *view=NULL;
    li_error_t error=li_ota_log_pending(core->ota->log,&view);
    if (error!=LI_OK) return error;
    if (!view->recovered || view->stage!=LI_OTA_AWAITING_BOOT || !view->boot_binding[0]) return LI_IGNORED;
    li_ota_outcome_t outcome; li_ota_stage_t stage;
    if (!observed(core,view,&stage,&outcome)) return LI_IGNORED;
    char execution[LI_OTA_LOG_ID_SIZE]; strcpy(execution,view->execution_id);
    error=li_ota_log_finish(core->ota->log,execution,stage,&outcome);
    if (error!=LI_OK) return error;
    error=li_ota_log_get(core->ota->log,execution,&view,NULL);
    return error==LI_OK?report(core,view):error;
}
static bool clock_seconds(void *context, int64_t *now) {
    li_core_t *core=context; return core->ota->ports.trusted_unix_seconds(core->ota->ports.context,now);
}
static bool device_info(void *context, li_device_info_t *info) {
    li_core_t *core=context; return core->ports.read_device_info&&core->ports.read_device_info(core->ports.context,info);
}
static bool header(li_core_t *core, const cJSON *root, const char *kind) {
    uint32_t version=0;
    return KEYS(root,"v","kind","message_id","device_id","model_revision","boot_id","session_id","body")
        && li_ota_uint32(field(root,"v"),&version)&&version==1 && equal(root,"kind",kind)&&li_ota_identifier(text(root,"message_id"))
        && equal(root,"device_id",core->config.device_id)&&equal(root,"model_revision",core->config.model_revision);
}
typedef struct {
    li_core_t *core;
    const li_ota_log_view_t *original;
    const li_ota_candidate_t *candidate;
    li_device_info_t initial;
    char facts[5][129];
    int64_t started, last;
} install_guard_t;
static bool same_text(const char *a, const char *b) { return a&&b&&!strcmp(a,b); }
static bool install_current(void *context) {
    install_guard_t *g=context; li_core_t *core=g->core; struct li_ota_device *ota=core->ota;
    const li_ota_policy_t *policy=ota->policy; const li_ota_candidate_t *candidate=g->candidate;
    const li_ota_log_view_t *view=NULL; int64_t now=-1, mono=core->ports.monotonic_ms(core->ports.context);
    if (mono<0 || g->started<0 || g->last<0 || mono<g->last || mono<g->started || mono-g->started>=LI_OTA_TRANSFER_TIMEOUT_MS) return false;
    g->last=mono;
    if (!li_ready(core) || !ota->installer.current(ota->installer.context)
        || li_ota_log_get(ota->log,g->original->execution_id,&view,NULL)!=LI_OK || view->recovered
        || (view->stage!=LI_OTA_INSTALLING&&view->stage!=LI_OTA_AWAITING_BOOT)
        || strcmp(view->request_digest,g->original->request_digest) || strcmp(core->boot,view->boot_id) || strcmp(core->session,view->session_id)
        || !ota->ports.trusted_unix_seconds(ota->ports.context,&now) || now<0 || now>INT64_C(253402300799)
        || now<candidate->issued_at || now>=candidate->expires_at || now>=view->expires_ms/1000
        || li_now(core)<0 || li_now(core)>=view->expires_ms || li_ota_policy_validate(&ota->crypto,policy)!=LI_OK
        || candidate->issued_at<policy->not_before || candidate->expires_at>policy->expires_at
        || candidate->security_epoch<policy->minimum_security_epoch
        || strcmp(candidate->authentication.signing_key_id,policy->key->signing_key_id)) return false;
    for (size_t i=0;i<policy->revoked_count;i++) if (!strcmp(candidate->artifact_id,policy->revoked_artifact_ids[i])) return false;
    bool origin=false, product=false;
    for (size_t i=0;i<policy->origin_count;i++) {
        size_t n=strlen(policy->download_origins[i]);
        if (strlen(candidate->download_url)>n && !memcmp(candidate->download_url,policy->download_origins[i],n) && candidate->download_url[n]=='/') origin=true;
    }
    li_device_info_t info={0}; const li_device_info_t *initial=&g->initial;
    if (!device_info(core,&info)) return false;
    for (size_t i=0;i<policy->product_count;i++) if (same_text(info.product_id,policy->product_ids[i])) product=true;
    return origin&&product&&same_text(info.product_id,initial->product_id)&&same_text(info.architecture,initial->architecture)
        &&same_text(info.chip,initial->chip)&&same_text(info.board,initial->board)&&same_text(info.bootloader_version,initial->bootloader_version)
        &&info.security_epoch==initial->security_epoch && info.security_epoch==view->baseline.security_epoch
        &&info.safe_to_update&&!info.pending_update && candidate->size_bytes<=info.ota_capacity_bytes
        &&(info.external_power||(info.has_battery&&info.battery_percent<=100&&info.battery_percent>=policy->minimum_battery_percent));
}
static int64_t install_monotonic(void *context) { return ((install_guard_t *)context)->core->ports.monotonic_ms(((install_guard_t *)context)->core->ports.context); }
static li_error_t stop_install(li_core_t *core, const li_ota_log_view_t *original, li_ota_stage_t stage, const char *reason) {
    li_ota_baseline_t local;
    if (!running(core,&local) || strcmp(local.firmware_version,original->baseline.firmware_version)
        || strcmp(local.image_sha256,original->baseline.image_sha256) || local.security_epoch!=original->baseline.security_epoch) return LI_DRIVER;
    li_ota_outcome_t outcome={.security_epoch=local.security_epoch};
    strcpy(outcome.boot_id,core->boot); strcpy(outcome.firmware_version,local.firmware_version); strcpy(outcome.image_sha256,local.image_sha256);
    if (!reason || strlen(reason)>=sizeof(outcome.error)) return LI_INVALID;
    strcpy(outcome.error,reason);
    li_error_t error=li_ota_log_finish(core->ota->log,original->execution_id,stage,&outcome);
    const li_ota_log_view_t *view=NULL;
    if (error==LI_OK) error=li_ota_log_get(core->ota->log,original->execution_id,&view,NULL);
    return error==LI_OK?report(core,view):error;
}
typedef struct { install_guard_t guard; li_ota_candidate_t checked; } install_workspace_t;
static li_error_t run_install(li_core_t *core, const li_ota_log_view_t *parsed, const li_ota_candidate_t *candidate,
                           const char *manifest, size_t length, install_workspace_t *workspace) {
    /* parsed为原报文的独立副本；日志提交不会改变它。设备事实字符串也复制保存。 */
    const li_ota_log_view_t *original=parsed; install_guard_t *context=&workspace->guard;
    *context=(install_guard_t){.core=core,.original=original,.candidate=candidate};
    if (!device_info(core,&context->initial)) return stop_install(core,original,LI_OTA_REJECTED,"ota_device_unavailable");
    const char **names[]={&context->initial.product_id,&context->initial.architecture,&context->initial.chip,&context->initial.board,&context->initial.bootloader_version};
    for (size_t i=0;i<5;i++) {
        if (!*names[i] || strlen(*names[i])>=sizeof(context->facts[i])) return stop_install(core,original,LI_OTA_REJECTED,"ota_device_unavailable");
        strcpy(context->facts[i],*names[i]); *names[i]=context->facts[i];
    }
    li_error_t error=li_ota_log_advance(core->ota->log,original->execution_id,LI_OTA_INSTALLING);
    if (error!=LI_OK) return error;
    context->started=context->last=core->ports.monotonic_ms(core->ports.context);
    li_ota_transfer_guard_t guard={context,install_monotonic,install_current};
    if (!guard.authorize(guard.context)) return stop_install(core,original,LI_OTA_FAILED,"ota_install_authorization_lost");
    const li_ota_log_view_t *view=NULL;
    if (li_ota_log_get(core->ota->log,original->execution_id,&view,NULL)==LI_OK) (void)report(core,view);
    li_ota_transfer_result_t staged={0}; const char *issue=NULL;
    error=core->ota->installer.stage(core->ota->installer.context,candidate,&guard,&staged,&issue);
    if (error!=LI_OK) return stop_install(core,original,LI_OTA_FAILED,issue?issue:"ota_staging_failed");
    if (!staged.image_verified || !memchr(staged.image_sha256,0,sizeof(staged.image_sha256)) || strcmp(staged.image_sha256,candidate->image_sha256)
        || staged.bytes_received!=candidate->size_bytes || staged.bytes_written!=candidate->size_bytes || staged.bytes_verified!=candidate->size_bytes)
        return stop_install(core,original,LI_OTA_FAILED,"ota_staging_unverified");
    /* 耗时传输后完整重新预检；再确认运行基线没有变化，随后保存激活前记录。 */
    li_ota_environment_t environment={core,&core->config,device_info,clock_seconds};
    error=li_ota_preflight(&core->ota->crypto,core->ota->policy,&environment,manifest,length,&workspace->checked,&issue);
    li_ota_baseline_t local;
    if (error!=LI_OK || !guard.authorize(guard.context)) return stop_install(core,original,LI_OTA_FAILED,"ota_install_authorization_lost");
    if (!running(core,&local) || strcmp(local.image_sha256,original->baseline.image_sha256)
        || local.security_epoch!=original->baseline.security_epoch) return LI_DRIVER;
    error=li_ota_log_advance(core->ota->log,original->execution_id,LI_OTA_AWAITING_BOOT);
    if (error!=LI_OK) return error;
    /* 从此即使选择端口报错也不能生成failed，不假定引导状态没有改变。 */
    if (!guard.authorize(guard.context)) return LI_SESSION;
    char binding[LI_OTA_LOG_ID_SIZE]={0};
    if (!core->ota->installer.activate(core->ota->installer.context,candidate,&guard,binding)
        || !memchr(binding,0,sizeof(binding)) || !li_ota_identifier(binding)) return LI_DRIVER;
    error=li_ota_log_bind_boot(core->ota->log,original->execution_id,binding);
    if (error!=LI_OK) return error;
    if (li_ota_log_get(core->ota->log,original->execution_id,&view,NULL)==LI_OK) (void)report(core,view);
    core->ota->installer.restart(core->ota->installer.context); return LI_OK;
}
static li_error_t install(li_core_t *core, const li_ota_log_view_t *parsed, const li_ota_candidate_t *candidate,
                           const char *manifest, size_t length) {
    install_workspace_t *workspace=calloc(1,sizeof(*workspace));
    if (!workspace) return stop_install(core,parsed,LI_OTA_REJECTED,"ota_installer_capacity");
    li_error_t error=run_install(core,parsed,candidate,manifest,length,workspace); free(workspace); return error;
}
li_error_t li_ota_device_receive(li_core_t *core, const char *raw, size_t length, bool query) {
    if (!core->ota || !li_ready(core)) return LI_SESSION;
    li_ota_log_view_t parsed={0};
    cJSON *root=query?li_ota_document_parse(raw,length):li_ota_install_parse(&core->config,&core->ota->crypto,raw,length,&parsed);
    if (!root) return LI_INVALID;
    li_error_t error=LI_INVALID;
    if (!header(core,root,query?"ota_query":"ota_install")) goto finish;
    error=LI_SESSION;
    if (!equal(root,"boot_id",core->boot)||!equal(root,"session_id",core->session)) goto finish;
    const cJSON *body=field(root,"body"); const li_ota_log_view_t *old=NULL;
    if (query) {
        int64_t expires=0;
        error=LI_INVALID;
        if (!KEYS(body,"task_id","execution_id","request_digest","manifest_digest","expires_at")
            || !li_ota_identifier(text(body,"task_id")) || strncmp(text(body,"task_id"),"ota-",4)||!text(body,"task_id")[4]
            || !li_ota_identifier(text(body,"execution_id")) || !li_ota_digest_valid(text(body,"request_digest"))
            || !li_ota_digest_valid(text(body,"manifest_digest")) || !li_ota_deadline(text(body,"expires_at"),&expires)) goto finish;
        int64_t now=li_now(core); error=LI_CLOCK; if (now<0) goto finish;
        error=LI_EXPIRED; if (expires<=now||expires-now>30000) goto finish;
        error=li_ota_log_get(core->ota->log,text(body,"execution_id"),&old,NULL); if (error!=LI_OK) goto finish;
        error=LI_CONFLICT;
        if (strcmp(old->task_id,text(body,"task_id"))||strcmp(old->request_digest,text(body,"request_digest"))||strcmp(old->manifest_digest,text(body,"manifest_digest"))) goto finish;
        error=report(core,old); goto finish;
    }
    error=li_ota_log_get(core->ota->log,parsed.execution_id,&old,NULL);
    if (error==LI_OK) { error=strcmp(old->request_digest,parsed.request_digest)?LI_CONFLICT:report(core,old); goto finish; }
    if (error!=LI_IGNORED) goto finish;
    error=LI_INVALID; if (!core->ota->policy) goto finish;
    size_t manifest_length=0; char *manifest=li_ota_json_encode(field(body,"manifest"),LI_MAX_PACKET,&manifest_length);
    li_ota_authentication_t authentication;
    error=manifest?li_ota_authenticate(&core->ota->crypto,core->ota->policy->key,manifest,manifest_length,&authentication):LI_INVALID;
    if (error!=LI_OK) { free(manifest); goto finish; }
    li_ota_baseline_t local; if (!running(core,&local)) { free(manifest); error=LI_DRIVER; goto finish; }
    li_ota_environment_t environment={core,&core->config,device_info,clock_seconds};
    li_ota_candidate_t candidate; const char *issue=NULL;
    li_error_t checked=li_ota_preflight(&core->ota->crypto,core->ota->policy,&environment,manifest,manifest_length,&candidate,&issue);
    error=li_ota_log_prepare(core->ota->log,raw,length,&local);
    if (error!=LI_OK) { free(manifest); goto finish; }
    parsed.baseline=local;
    if (checked==LI_OK && core->ota->installer.stage) error=install(core,&parsed,&candidate,manifest,manifest_length);
    else error=stop_install(core,&parsed,LI_OTA_REJECTED,checked==LI_OK?"ota_installer_unavailable":issue);
    free(manifest);
finish:
    cJSON_Delete(root); return error;
}
