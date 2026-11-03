/* 生产ESP worker/安装消费者/传输/凭据窗口；分区、启动选择和重启是显式宿主端口。 */
#ifndef LI_ESP_INSTALL_HOST
#error "Use the installer credential build entrypoint"
#endif
#include "esp_runtime_host.c"
#include "ota_transfer_fixture.h"

static struct {
    transfer_host_t transfer;
    cJSON *plan;
    const char *credential, *checkpoint;
    bool injected, snapshot_saved, resumed, staged_verified;
    unsigned io_after_gate, commits, commit_failures, selections, observations;
    unsigned reads_at_gate, writes_at_gate, verifies_at_gate, publishes_at_gate;
    char execution[LI_OTA_LOG_ID_SIZE], spare[PATH_MAX];
} installation;
static const char baseline_bytes[]="LimeIoT complete installer baseline fixture\n";
static const esp_partition_t baseline_partition={.address=0x10000,.size=1966080};
const esp_partition_t *esp_ota_get_running_partition(void) { return &baseline_partition; }
esp_err_t esp_partition_read(const esp_partition_t *partition,size_t offset,void *data,size_t size) {
    if (partition!=&baseline_partition||offset>sizeof(baseline_bytes)-1||size>sizeof(baseline_bytes)-1-offset) return ESP_FAIL;
    memcpy(data,baseline_bytes+offset,size); return ESP_OK;
}
esp_err_t esp_image_verify(int mode,const esp_partition_pos_t *position,esp_image_metadata_t *metadata) {
    if (mode!=ESP_IMAGE_VERIFY_SILENT||position->offset!=baseline_partition.address||position->size!=baseline_partition.size) return ESP_FAIL;
    metadata->image_len=sizeof(baseline_bytes)-1; return ESP_OK;
}
const esp_app_desc_t *esp_app_get_description(void) { static const esp_app_desc_t app={"0.2.0"}; return &app; }
static bool install_info(void *context,li_device_info_t *info) {
    (void)context;
    *info=(li_device_info_t){.product_id="desk-node-lamp-host",.architecture="native",.chip="host",.board="host-fixture",
        .bootloader_version="0.0.1",.security_epoch=0,.ota_capacity_bytes=1966080,.external_power=true,.safe_to_update=true};
    return true;
}
static void inject(const char *checkpoint) {
    if (installation.resumed||installation.injected||strcmp(checkpoint,installation.checkpoint)) return;
    installation.injected=true;
    if (!strcmp(installation.credential,"clock")) runtime.trusted=false;
    else {
        int64_t deadline=esp_timer_get_time()+12000000;
        while (li_credential_window_current(&runtime.adapter->credential_window,true)) {
            assert(esp_timer_get_time()<deadline); pause_ms(10);
        }
    }
    assert(!li_credential_window_current(&runtime.adapter->credential_window,runtime.trusted));
    installation.reads_at_gate=installation.transfer.reads;
    installation.writes_at_gate=installation.transfer.writes;
    installation.verifies_at_gate=installation.transfer.verifies;
    installation.publishes_at_gate=runtime.publishes;
}
static void note_io(void) {
    /* 端口只观测，生产guard负责拒绝后续I/O。 */
    if (!li_credential_window_current(&runtime.adapter->credential_window,runtime.trusted)) installation.io_after_gate++;
}
static bool install_read(void *context,uint8_t *data,size_t capacity,size_t *received,bool *complete) {
    note_io(); bool ok=read_http(context,data,capacity,received,complete);
    if (ok&&*received) inject("read"); return ok;
}
static bool install_write(void *context,uint32_t offset,const uint8_t *data,size_t size) {
    note_io(); bool ok=write_image(context,offset,data,size); if (ok) inject("write"); return ok;
}
static bool install_verify(void *context,uint32_t offset,uint8_t *data,size_t size) {
    note_io(); bool ok=read_image(context,offset,data,size); if (ok) inject("verify"); return ok;
}
li_error_t li_espidf_ota_stage(const li_ota_candidate_t *candidate,const char *ca,const li_ota_transfer_guard_t *guard,
                              li_ota_transfer_result_t *result,const char **issue) {
    assert(ca&&*ca); runtime.ota_stage_calls++;
    li_ota_source_t source={&installation.transfer,open_http,install_read,close_http};
    li_ota_sink_t sink={&installation.transfer,begin_image,install_write,finish_image,install_verify,abort_image};
    li_ota_hash_stream_t stream={&installation.transfer,begin_hash,update_hash,finish_hash,abort_hash};
    li_error_t error=li_ota_transfer_run(candidate,&source,&sink,&stream,guard,result,issue);
    installation.staged_verified=result->image_verified;
    if (error==LI_OK) inject("staged");
    return error;
}
bool li_esp_ota_activate(const li_ota_candidate_t *candidate,const li_ota_transfer_guard_t *guard,char binding[LI_OTA_LOG_ID_SIZE]) {
    (void)candidate; runtime.ota_activate_calls++; *binding=0;
    if (!guard->authorize(guard->context)) return false;
    /* 模拟外部选择已生效；消费者必须保留未知或耐久保存实际返回的绑定。 */
    const char selected[]="{\"binding\":\"host-selected-image\"}\n";
    installation.selections++; durable_file("selection.json",selected,sizeof(selected)-1);
    inject("selected");
    if (!strcmp(installation.checkpoint,"selected")) return false;
    strcpy(binding,"host-selected-image"); inject("activated"); return true;
}
bool li_esp_ota_observe(const li_ota_log_view_t *view,li_ota_stage_t *stage,li_ota_outcome_t *outcome) {
    (void)view;(void)stage;(void)outcome; installation.observations++; return false;
}
void esp_restart(void) { runtime.ota_restart_calls++; }
static bool install_commit_failure(nvs_handle_t handle,bool durable) {
    if (handle!=2) return false;
    if (!durable) installation.commits++;
    if (installation.resumed) return false;
    if (installation.commits==3&&durable) inject("awaiting");
    bool before=!strcmp(installation.checkpoint,"bind-before"), after=!strcmp(installation.checkpoint,"bind-after");
    if (installation.commits==4&&((before&&!durable)||(after&&durable))) {
        inject(installation.checkpoint); installation.commit_failures++; return true;
    }
    return false;
}
static void save_state(const char *name) {
    cJSON *result=cJSON_CreateObject(); assert(result);
#define NUMBER(key,value) assert(cJSON_AddNumberToObject(result,key,(double)(value)))
#define BOOLEAN(key,value) assert(cJSON_AddBoolToObject(result,key,value))
    NUMBER("stage_calls",runtime.ota_stage_calls); NUMBER("activate_calls",runtime.ota_activate_calls);
    NUMBER("selections",installation.selections); NUMBER("restart_calls",runtime.ota_restart_calls);
    NUMBER("observations",installation.observations); NUMBER("commits",installation.commits);
    NUMBER("durable_commits",runtime.nvs_writes[2]);
    NUMBER("commit_failures",installation.commit_failures); NUMBER("io_after_gate",installation.io_after_gate);
    NUMBER("opens",installation.transfer.opens); NUMBER("reads",installation.transfer.reads); NUMBER("writes",installation.transfer.writes);
    NUMBER("verifies",installation.transfer.verifies); NUMBER("finishes",installation.transfer.finishes); NUMBER("aborts",installation.transfer.aborts);
    NUMBER("reads_at_gate",installation.reads_at_gate); NUMBER("writes_at_gate",installation.writes_at_gate); NUMBER("verifies_at_gate",installation.verifies_at_gate);
    NUMBER("publishes_after_gate",installation.injected?runtime.publishes-installation.publishes_at_gate:0);
    NUMBER("ota_results",runtime.ota_results); NUMBER("ota_queries",runtime.ota_queries); NUMBER("ota_installs",runtime.ota_installs);
    NUMBER("effects",runtime.effects); NUMBER("queue_size",runtime.adapter->queue->size);
    BOOLEAN("injected",installation.injected); BOOLEAN("staged_verified",installation.staged_verified);
    BOOLEAN("locked",atomic_load(&runtime.adapter->credential_window.blocked));
    BOOLEAN("blocked",li_ota_log_blocked(runtime.adapter->ota_log));
    const li_ota_log_view_t *view=NULL; const char *original=NULL;
    li_error_t error=li_ota_log_get(runtime.adapter->ota_log,installation.execution,&view,&original);
    assert(cJSON_AddStringToObject(result,"log_error",li_error_code(error)));
    if (error==LI_OK) {
        assert(view&&original); assert(cJSON_AddStringToObject(result,"stage",li_ota_stage_name(view->stage)));
        assert(cJSON_AddStringToObject(result,"binding",view->boot_binding)); BOOLEAN("recovered",view->recovered);
        assert(cJSON_AddStringToObject(result,"request_digest",view->request_digest));
        assert(cJSON_AddStringToObject(result,"outcome_error",view->outcome.error));
    }
    char *raw=cJSON_PrintUnformatted(result); assert(raw); durable_file(name,raw,strlen(raw)); free(raw); cJSON_Delete(result);
#undef NUMBER
#undef BOOLEAN
}
static void install_poll(void) {
    if (!runtime.adapter->queue->size&&runtime.ota_installs&&!installation.snapshot_saved) {
        installation.snapshot_saved=true; save_state("consumed.json");
    }
    char trigger[PATH_MAX]; file_path(trigger,"finish");
    if (access(trigger,F_OK)==0&&!runtime.adapter->queue->size) longjmp(finished,1);
}
int main(int argc,char **argv) {
    if (argc!=4) return 5;
    runtime.directory=argv[1]; runtime.mode=argv[3]; runtime.trusted=true;
    installation.resumed=!strcmp(runtime.mode,"resume");
    char *raw=read_text("plan.json"); installation.plan=cJSON_Parse(raw); free(raw); assert(installation.plan);
    installation.credential=transfer_text(installation.plan,"credential"); installation.checkpoint=transfer_text(installation.plan,"checkpoint");
    const char *execution=transfer_text(installation.plan,"execution"); assert(execution&&strlen(execution)<sizeof(installation.execution)); strcpy(installation.execution,execution);
    assert(installation.credential&&installation.checkpoint); file_path(installation.spare,"spare.bin");
    installation.transfer=(transfer_host_t){.plan=installation.plan,.path=installation.spare,.socket=-1,.file=-1};
    file_path(runtime.ca_file,"ca.crt"); file_path(runtime.certificate_file,"device.crt"); file_path(runtime.key_file,"device.key");
    char *ca=read_text("ca.crt"), *certificate=read_text("device.crt"), *key=read_text("device.key"), *download_ca=read_text("download-ca.crt");
    raw=read_text("trust.json"); li_ota_crypto_t crypto={NULL,hash,verify}; li_ota_trust_t *trust=NULL;
    assert(li_ota_trust_decode(&crypto,raw,strlen(raw),&trust)==LI_OK); free(raw);
    const li_ota_policy_t *policy=li_ota_trust_policy(trust);
    li_espidf_options_t options={.core={.space_id="space-demo",.device_id="device-lamp",.model_revision=LI_LAMP_REVISION,
        .firmware_version="0.2.0",.hardware_revision="host-fixture",.properties=LI_LAMP_PROPERTIES,.property_count=LI_LAMP_PROPERTY_COUNT,.observation_source="host-fixture"},
        .broker_host="127.0.0.1",.broker_port=(uint16_t)strtoul(argv[2],NULL,10),.ca_pem=ca,.certificate_pem=certificate,.private_key_pem=key,
        .trusted_clock=driver_clock,.read_property=driver_read,.write_property=driver_write,.read_device_info=install_info,
        .ota_firmware_key=policy->key,.ota_policy=policy,.ota_https_ca_pem=download_ca};
    assert(options.broker_port&&mosquitto_lib_init()==MOSQ_ERR_SUCCESS);
    signal(SIGINT,on_signal); signal(SIGTERM,on_signal); signal(SIGPIPE,SIG_IGN);
    li_error_t error=li_espidf_start(&options,&runtime.adapter);
    if (error!=LI_OK) { fprintf(stderr,"installer adapter start: %s\n",li_error_code(error)); return 6; }
    assert(runtime.task); if (!setjmp(finished)) runtime.task(runtime.task_context);
    runtime.finishing=true; save_state("result.json");
    if (installation.injected) {
        assert(!li_credential_window_check(&runtime.adapter->credential_window,runtime.trusted));
        runtime.trusted=true; assert(!credentials_current(runtime.adapter));
    }
    work_t queued; while (xQueueReceive(runtime.adapter->queue,&queued,0)==pdTRUE) free(queued.payload);
    reset_incoming(runtime.adapter); esp_mqtt_client_destroy(runtime.adapter->mqtt); vQueueDelete(runtime.adapter->queue);
    li_core_destroy(runtime.adapter->core); close_ota_log(runtime.adapter); nvs_close(runtime.adapter->journal); free(runtime.adapter);
    if (installation.transfer.file>=0) assert(close(installation.transfer.file)==0);
    li_ota_trust_destroy(trust); cJSON_Delete(installation.plan); mosquitto_lib_cleanup();
    OPENSSL_cleanse(key,strlen(key)); free(key); free(certificate); free(ca); free(download_ca); return stopping?7:0;
}
