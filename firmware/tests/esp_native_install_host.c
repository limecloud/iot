/* 同一进程运行生产worker/消费者/原生提供方；网络与文件系统底层仍为宿主端口。 */
#if !defined(LI_ESP_INSTALL_HOST) || !defined(LI_ESP_NATIVE_INSTALL_HOST)
#error "Use the native installation integration build entrypoint"
#endif
#include "esp_runtime_host.c"
#include "esp_native_ota_host.c"

/* 构建时仅重命名生产提供方符号；包装器只记录调用及注入返回边界，不替代生产实现。 */
li_error_t li_test_native_stage(const li_ota_candidate_t *,const char *,const li_ota_transfer_guard_t *,li_ota_transfer_result_t *,const char **);
bool li_test_native_activate(const li_ota_candidate_t *,const li_ota_transfer_guard_t *,char[LI_OTA_LOG_ID_SIZE]);
bool li_test_native_observe(const li_ota_log_view_t *,li_ota_stage_t *,li_ota_outcome_t *);
static struct {
    const char *credential, *checkpoint;
    char execution[LI_OTA_LOG_ID_SIZE];
    bool resumed, injected, consumed, staged_verified;
    unsigned commits, commit_failures, observations, publishes_at_gate;
} native_run;
static bool native_credentials_current(void) {
    return !runtime.adapter||li_credential_window_current(&runtime.adapter->credential_window,runtime.trusted);
}
static void native_checkpoint(const char *where) {
    if (native_run.resumed||native_run.injected) return;
    const char *checkpoint=!strcmp(where,"select")?"selected":where;
    if (strcmp(checkpoint,native_run.checkpoint)) return;
    native_run.injected=true;
    if (!strcmp(native_run.credential,"clock")) runtime.trusted=false;
    else {
        int64_t deadline=esp_timer_get_time()+12000000;
        while (native_credentials_current()) { assert(esp_timer_get_time()<deadline); pause_ms(10); }
    }
    assert(!native_credentials_current()); native_run.publishes_at_gate=runtime.publishes;
}
static void native_selection_saved(void) { durable_file("otadata.bin",host.entries,sizeof(host.entries)); }
static void native_ota_publishing(const char *data,int length) {
    cJSON *receipt=cJSON_ParseWithLength(data,(size_t)length); assert(receipt);
    char *raw=read_text("nvs-2-state.json"); cJSON *saved=cJSON_Parse(raw); free(raw); assert(saved);
    cJSON *record=cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(saved,"records"),0);
    cJSON *body=cJSON_GetObjectItemCaseSensitive(receipt,"body"); assert(record&&body);
    const char *stage=cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(record,"stage"));
    const char *status=cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(body,"status")); assert(stage&&status&&!strcmp(stage,status));
    cJSON *evidence=cJSON_CreateObject(); assert(evidence);
    assert(cJSON_AddItemToObject(evidence,"receipt",receipt)&&cJSON_AddItemToObject(evidence,"snapshot",saved));
    char *encoded=cJSON_PrintUnformatted(evidence), name[64]; assert(encoded);
    assert(snprintf(name,sizeof(name),"durable-receipt-%u.json",runtime.ota_results+1)>0);
    durable_file(name,encoded,strlen(encoded)); free(encoded); cJSON_Delete(evidence);
}
li_error_t li_espidf_ota_stage(const li_ota_candidate_t *candidate,const char *ca,const li_ota_transfer_guard_t *guard,
                              li_ota_transfer_result_t *result,const char **issue) {
    runtime.ota_stage_calls++; host.suite="stage";
    li_error_t error=li_test_native_stage(candidate,ca,guard,result,issue);
    host.suite="runtime"; native_run.staged_verified=result->image_verified;
    if (error==LI_OK) native_checkpoint("staged"); return error;
}
bool li_esp_ota_activate(const li_ota_candidate_t *candidate,const li_ota_transfer_guard_t *guard,char binding[LI_OTA_LOG_ID_SIZE]) {
    runtime.ota_activate_calls++; host.suite="activate";
    bool accepted=li_test_native_activate(candidate,guard,binding); host.suite="runtime";
    if (accepted) native_checkpoint("activated"); return accepted;
}
bool li_esp_ota_observe(const li_ota_log_view_t *view,li_ota_stage_t *stage,li_ota_outcome_t *outcome) {
    native_run.observations++; host.suite="observe";
    bool accepted=li_test_native_observe(view,stage,outcome); host.suite="runtime"; return accepted;
}
void esp_restart(void) { runtime.ota_restart_calls++; }
static bool install_commit_failure(nvs_handle_t handle,bool durable) {
    if (handle!=2) return false;
    if (!durable) native_run.commits++;
    if (native_run.resumed) return false;
    if (native_run.commits==3&&durable) native_checkpoint("awaiting");
    bool before=!strcmp(native_run.checkpoint,"bind-before"), after=!strcmp(native_run.checkpoint,"bind-after");
    if (native_run.commits==4&&((before&&!durable)||(after&&durable))) {
        native_checkpoint(native_run.checkpoint); native_run.commit_failures++; return true;
    }
    return false;
}
static bool native_device_info(void *context,li_device_info_t *info) {
    (void)context;
    *info=(li_device_info_t){.product_id="desk-node-lamp-host",.architecture="native",.chip="host",.board="host-fixture",
        .bootloader_version="0.0.1",.security_epoch=host.description[host.running].secure_version,.ota_capacity_bytes=1966080,
        .external_power=true,.safe_to_update=true,.pending_update=!strcmp(runtime.mode,"boot-pending")}; return true;
}
static void native_state(const char *name) {
    cJSON *result=cJSON_CreateObject(); assert(result);
#define NUMBER(key,value) assert(cJSON_AddNumberToObject(result,key,(double)(value)))
#define BOOL(key,value) assert(cJSON_AddBoolToObject(result,key,value))
#define STRING(key,value) assert(cJSON_AddStringToObject(result,key,value))
    NUMBER("stage_calls",runtime.ota_stage_calls); NUMBER("activate_calls",runtime.ota_activate_calls); NUMBER("observations",native_run.observations);
    NUMBER("selections",host.selections); NUMBER("restart_calls",runtime.ota_restart_calls); NUMBER("chosen",host.chosen); NUMBER("running",host.running);
    NUMBER("commits",native_run.commits); NUMBER("durable_commits",runtime.nvs_writes[2]); NUMBER("commit_failures",native_run.commit_failures);
    NUMBER("opens",host.opens); NUMBER("reads",host.reads); NUMBER("writes",host.writes); NUMBER("ends",host.ends); NUMBER("aborts",host.aborts);
    NUMBER("partition_reads",host.partition_reads); NUMBER("metadata_reads",host.metadata_reads); NUMBER("io_after_gate",host.io_after_loss);
    NUMBER("publishes_after_gate",native_run.injected?runtime.publishes-native_run.publishes_at_gate:0);
    NUMBER("ota_results",runtime.ota_results); NUMBER("ota_queries",runtime.ota_queries); NUMBER("ota_installs",runtime.ota_installs);
    NUMBER("effects",runtime.effects); NUMBER("queue_size",runtime.adapter->queue->size);
    BOOL("injected",native_run.injected); BOOL("staged_verified",native_run.staged_verified); BOOL("active_handle",host.active);
    BOOL("locked",atomic_load(&runtime.adapter->credential_window.blocked)); BOOL("blocked",li_ota_log_blocked(runtime.adapter->ota_log));
    const li_ota_log_view_t *view=NULL; const char *original=NULL;
    li_error_t error=li_ota_log_get(runtime.adapter->ota_log,native_run.execution,&view,&original); STRING("log_error",li_error_code(error));
    if (error==LI_OK) {
        assert(view&&original); STRING("stage",li_ota_stage_name(view->stage)); STRING("binding",view->boot_binding); BOOL("recovered",view->recovered);
        STRING("request_digest",view->request_digest); STRING("outcome_error",view->outcome.error); STRING("outcome_version",view->outcome.firmware_version);
        STRING("outcome_sha256",view->outcome.image_sha256); STRING("outcome_boot",view->outcome.boot_id);
    }
    char *encoded=cJSON_PrintUnformatted(result); assert(encoded); durable_file(name,encoded,strlen(encoded)); free(encoded); cJSON_Delete(result);
#undef NUMBER
#undef BOOL
#undef STRING
}
static void install_poll(void) {
    if (!native_run.execution[0]) {
        char path[PATH_MAX]; file_path(path,"execution.txt");
        if (access(path,F_OK)==0) {
            char *value=read_text("execution.txt"); assert(strlen(value)<sizeof(native_run.execution));
            strcpy(native_run.execution,value); free(value);
        }
    }
    if (native_run.execution[0]&&!runtime.adapter->queue->size&&runtime.ota_installs&&!native_run.consumed) {
        native_run.consumed=true; native_state("consumed.json");
    }
    char trigger[PATH_MAX]; file_path(trigger,"finish");
    if (!runtime.adapter->queue->size&&access(trigger,F_OK)==0) longjmp(finished,1);
}
int main(int argc,char **argv) {
    if (argc!=4) return 5;
    runtime.directory=argv[1]; runtime.mode=argv[3]; runtime.trusted=true; native_run.resumed=strcmp(runtime.mode,"install")!=0;
    char *raw=read_text("plan.json"); host.plan=cJSON_Parse(raw); free(raw); assert(host.plan);
    native_run.credential=text("credential"); native_run.checkpoint=text("checkpoint");
    const char *execution=text("execution"); assert(execution&&strlen(execution)<sizeof(native_run.execution)); strcpy(native_run.execution,execution);
    assert(native_run.credential&&native_run.checkpoint&&psa_crypto_init()==PSA_SUCCESS);
    initialize(runtime.directory); host.suite="runtime";
    file_path(runtime.ca_file,"ca.crt"); file_path(runtime.certificate_file,"device.crt"); file_path(runtime.key_file,"device.key");
    char *ca=read_text("ca.crt"), *certificate=read_text("device.crt"), *key=read_text("device.key"), *download_ca=read_text("download-ca.crt");
    raw=read_text("trust.json"); li_ota_crypto_t crypto={NULL,hash,verify}; li_ota_trust_t *trust=NULL;
    assert(li_ota_trust_decode(&crypto,raw,strlen(raw),&trust)==LI_OK); free(raw); const li_ota_policy_t *policy=li_ota_trust_policy(trust);
    li_espidf_options_t options={.core={.space_id="space-demo",.device_id="device-lamp",.model_revision=LI_LAMP_REVISION,
        .firmware_version=host.description[host.running].version,.hardware_revision="host-fixture",.properties=LI_LAMP_PROPERTIES,
        .property_count=LI_LAMP_PROPERTY_COUNT,.observation_source="host-fixture"},
        .broker_host="127.0.0.1",.broker_port=(uint16_t)strtoul(argv[2],NULL,10),.ca_pem=ca,.certificate_pem=certificate,.private_key_pem=key,
        .trusted_clock=driver_clock,.read_property=driver_read,.write_property=driver_write,.read_device_info=native_device_info,
        .ota_firmware_key=policy->key,.ota_policy=policy,.ota_https_ca_pem=download_ca};
    assert(options.broker_port&&mosquitto_lib_init()==MOSQ_ERR_SUCCESS);
    signal(SIGINT,on_signal); signal(SIGTERM,on_signal); signal(SIGPIPE,SIG_IGN);
    li_error_t error=li_espidf_start(&options,&runtime.adapter);
    if (error!=LI_OK) { fprintf(stderr,"native installer start: %s\n",li_error_code(error)); return 6; }
    assert(runtime.task); if (!setjmp(finished)) runtime.task(runtime.task_context);
    runtime.finishing=true; native_state("result.json");
    work_t queued; while (xQueueReceive(runtime.adapter->queue,&queued,0)==pdTRUE) free(queued.payload);
    reset_incoming(runtime.adapter); esp_mqtt_client_destroy(runtime.adapter->mqtt); vQueueDelete(runtime.adapter->queue);
    li_core_destroy(runtime.adapter->core); close_ota_log(runtime.adapter); nvs_close(runtime.adapter->journal); free(runtime.adapter);
    assert(close(host.files[0])==0&&close(host.files[1])==0);
    li_ota_trust_destroy(trust); cJSON_Delete(host.plan); mosquitto_lib_cleanup();
    OPENSSL_cleanse(key,strlen(key)); free(key); free(certificate); free(ca); free(download_ca); return stopping?7:0;
}
