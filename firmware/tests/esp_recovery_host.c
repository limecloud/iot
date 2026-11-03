/* 实际身份/存储接生产worker；硬件、文件NVS、驱动及OTA安装端口仍是宿主夹具。 */
#ifndef LI_ESP_RECOVERY_HOST
#error "Use the recovery build entrypoint"
#endif
#include "esp_runtime_host.c"
#include "limeiot_device_identity.h"
#include "cJSON.h"
#include <openssl/hmac.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>

static unsigned char identity_root[32], identity_binding[4096];
static unsigned total_effects;
static unsigned observed_commands;
static unsigned observed_queries;
static bool checked, seeded;
static nvs_handle_t failed_read_handle;
static bool failed_read_data;
static unsigned read_failures;
static unsigned failed_commit_number, receipt_commit_attempts, receipt_commit_failures;
static bool failed_commit_after;
static unsigned ota_fault_step, ota_commit_number, ota_commit_attempts, ota_commit_failures;
static bool ota_commit_after;
static char *ota_original;
static char ota_execution[LI_OTA_LOG_ID_SIZE], ota_original_boot[LI_OTA_LOG_ID_SIZE];
static li_ota_outcome_t ota_outcome;

static bool recovery_read_failure(nvs_handle_t handle,const char *key,const void *data) {
    if (handle!=failed_read_handle || (data!=NULL)!=failed_read_data
        || strcmp(key,handle==1?"r00":"state")) return false;
    read_failures++; return true;
}
static bool recovery_commit_failure(nvs_handle_t handle,bool durable) {
    if (handle==2) {
        if (!durable) ota_commit_attempts++;
        if (!ota_commit_number || ota_commit_attempts!=ota_commit_number || durable!=ota_commit_after) return false;
        ota_commit_failures++; return true;
    }
    if (handle!=1) return false;
    if (!durable) receipt_commit_attempts++;
    if (!failed_commit_number || receipt_commit_attempts!=failed_commit_number || durable!=failed_commit_after) return false;
    receipt_commit_failures++; return true;
}

static void load_exact(const char *name, unsigned char *output, size_t length) {
    char location[PATH_MAX]; file_path(location,name);
    FILE *file=fopen(location,"rb"); assert(file);
    assert(fread(output,1,length,file)==length&&!ferror(file)&&fgetc(file)==EOF);
    assert(fclose(file)==0);
}
esp_efuse_purpose_t esp_efuse_get_key_purpose(esp_efuse_block_t block) { return block==EFUSE_BLK_KEY0?ESP_EFUSE_KEY_PURPOSE_HMAC_UP:0; }
bool esp_efuse_get_key_dis_read(esp_efuse_block_t block) { return block==EFUSE_BLK_KEY0; }
bool esp_efuse_get_key_dis_write(esp_efuse_block_t block) { return block==EFUSE_BLK_KEY0; }
bool esp_efuse_get_keypurpose_dis_write(esp_efuse_block_t block) { return block==EFUSE_BLK_KEY0; }
const esp_partition_t *esp_partition_find_first(int type,int subtype,const char *label) {
    static const esp_partition_t partition={.size=4096,.readonly=true};
    return type==ESP_PARTITION_TYPE_DATA&&subtype==0x40&&!strcmp(label,"li-security")?&partition:NULL;
}
esp_err_t esp_partition_read(const esp_partition_t *partition,size_t offset,void *output,size_t length) {
    if (!partition||!partition->readonly||offset||length!=208) return ESP_FAIL;
    memcpy(output,identity_binding,length); return ESP_OK;
}
esp_err_t esp_hmac_calculate(hmac_key_id_t id,const void *data,size_t length,void *output) {
    unsigned actual=0;
    return id==0&&HMAC(EVP_sha256(),identity_root,sizeof(identity_root),data,length,output,&actual)&&actual==32?ESP_OK:ESP_FAIL;
}
nvs_sec_scheme_t *nvs_flash_get_default_security_scheme(void) { static nvs_sec_scheme_t scheme={NVS_SEC_SCHEME_HMAC}; return &scheme; }
esp_err_t nvs_flash_read_security_cfg_v2(nvs_sec_scheme_t *scheme,nvs_sec_cfg_t *keys) {
    if (!scheme||scheme->scheme_id!=NVS_SEC_SCHEME_HMAC) return ESP_FAIL;
    memset(keys,0,sizeof(*keys)); return ESP_OK;
}
esp_err_t nvs_flash_secure_init_partition(const char *name,nvs_sec_cfg_t *keys) { (void)keys;return !strcmp(name,"journal")?ESP_OK:ESP_FAIL; }
esp_err_t nvs_flash_init_partition(const char *name) { (void)name;abort(); }

/* 同进程消费生产options中的凭据，私钥不经文件或工具桥接。 */
static void recovery_tls(esp_mqtt_client_handle_t mqtt,const esp_mqtt_client_config_t *config) {
    SSL_CTX *tls=SSL_CTX_new(TLS_client_method()); assert(tls);
    BIO *ca_input=BIO_new_mem_buf(config->broker.verification.certificate,-1);
    BIO *certificate_input=BIO_new_mem_buf(config->credentials.authentication.certificate,-1);
    BIO *key_input=BIO_new_mem_buf(config->credentials.authentication.key,-1);
    assert(ca_input&&certificate_input&&key_input);
    X509 *ca=PEM_read_bio_X509(ca_input,NULL,NULL,NULL), *certificate=PEM_read_bio_X509(certificate_input,NULL,NULL,NULL);
    EVP_PKEY *key=PEM_read_bio_PrivateKey(key_input,NULL,NULL,NULL); assert(ca&&certificate&&key);
    assert(X509_STORE_add_cert(SSL_CTX_get_cert_store(tls),ca)==1);
    assert(SSL_CTX_use_certificate(tls,certificate)==1&&SSL_CTX_use_PrivateKey(tls,key)==1&&SSL_CTX_check_private_key(tls)==1);
    assert(SSL_CTX_set_min_proto_version(tls,TLS1_2_VERSION)==1);
    SSL_CTX_set_verify(tls,SSL_VERIFY_PEER,NULL);
    assert(X509_VERIFY_PARAM_set1_ip_asc(SSL_CTX_get0_param(tls),config->broker.address.hostname)==1);
    assert(mosquitto_void_option(mqtt->client,MOSQ_OPT_SSL_CTX,tls)==MOSQ_ERR_SUCCESS);
    /* CA、持钥、最低TLS及主机名均已配置，禁止库再要求文件式CA/私钥配置。 */
    assert(mosquitto_int_option(mqtt->client,MOSQ_OPT_SSL_CTX_WITH_DEFAULTS,0)==MOSQ_ERR_SUCCESS);
    SSL_CTX_free(tls); EVP_PKEY_free(key); X509_free(certificate); X509_free(ca);
    BIO_free(key_input); BIO_free(certificate_input); BIO_free(ca_input);
}
static li_apply_result_t recovery_apply(const char *path,li_value_t value) {
    char *fault=read_text("driver-mode");
    bool failed=!strcmp(fault,"failed\n"), unknown=!strcmp(fault,"unknown\n"); free(fault);
    if (failed) return LI_NOT_APPLIED;
    if (!strcmp(path,"light.power")) runtime.power=value.boolean;
    else if (!strcmp(path,"light.brightness")) runtime.brightness=value.integer; else return LI_NOT_APPLIED;
    runtime.effects++; total_effects++;
    if (!li_credential_window_current(&runtime.adapter->credential_window,runtime.trusted)) runtime.effects_after++;
    char record[192]; int size=snprintf(record,sizeof(record),"{\"total_effects\":%u,\"process_effects\":%u,\"effects_after_invalidation\":%u}\n",total_effects,runtime.effects,runtime.effects_after);
    assert(size>0&&size<(int)sizeof(record)); durable_file("effects-total.json",record,(size_t)size);
    return unknown?LI_EXECUTION_UNKNOWN:LI_APPLIED;
}
static li_ota_baseline_t baseline(void) {
    li_ota_baseline_t value={.firmware_version="0.2.0",.security_epoch=0};
    strcpy(value.image_sha256,"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); return value;
}
/* 仅通过生产日志API构造状态；版本/摘要是显式基线夹具，不运行镜像安装。 */
static void ota_input(void) {
    ota_original=read_text("ota-request.json");
    cJSON *root=cJSON_Parse(ota_original); assert(root);
    const cJSON *body=cJSON_GetObjectItemCaseSensitive(root,"body");
    const char *execution=cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(body,"execution_id"));
    const char *boot=cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(root,"boot_id"));
    assert(execution&&strlen(execution)<sizeof(ota_execution)&&boot&&strlen(boot)<sizeof(ota_original_boot));
    strcpy(ota_execution,execution); strcpy(ota_original_boot,boot); cJSON_Delete(root);
}
static void ota_frozen(void) {
    li_ota_log_t *log=runtime.adapter->ota_log;
    const li_ota_log_view_t *view=NULL; const char *original=NULL; li_ota_baseline_t running=baseline();
    unsigned attempts=ota_commit_attempts, writes=runtime.nvs_writes[2], effects=runtime.effects;
    assert(li_ota_log_blocked(log));
    assert(li_ota_log_get(log,ota_execution,&view,&original)==LI_STORAGE&&!view&&!original);
    assert(li_ota_log_pending(log,&view)==LI_STORAGE&&!view);
    assert(li_ota_log_prepare(log,ota_original,strlen(ota_original),&running)==LI_STORAGE);
    assert(li_ota_log_advance(log,ota_execution,LI_OTA_INSTALLING)==LI_STORAGE);
    assert(li_ota_log_bind_boot(log,ota_execution,"fixture-boot-binding")==LI_STORAGE);
    assert(li_ota_log_finish(log,ota_execution,LI_OTA_FAILED,&ota_outcome)==LI_STORAGE);
    assert(write_property(runtime.adapter,"light.power",(li_value_t){.type=LI_BOOLEAN,.boolean=true})==LI_NOT_APPLIED);
    assert(ota_commit_attempts==attempts&&runtime.nvs_writes[2]==writes&&runtime.effects==effects);
}
static void ota_before_error(void) {
    char location[PATH_MAX]; file_path(location,"nvs-2-state.json");
    if (access(location,F_OK)==0) { char *raw=read_text("nvs-2-state.json"); durable_file("ota-before-error.json",raw,strlen(raw)); free(raw); }
    else durable_file("ota-before-error.json","null\n",5);
}
static void ota_fail_commit(void) {
    ota_input(); li_ota_log_t *log=runtime.adapter->ota_log; li_ota_baseline_t running=baseline();
    li_error_t error; const li_ota_log_view_t *view=NULL;
    if (ota_fault_step==1) { ota_before_error(); error=li_ota_log_prepare(log,ota_original,strlen(ota_original),&running); }
    else {
        assert(li_ota_log_prepare(log,ota_original,strlen(ota_original),&running)==LI_OK);
        assert(li_ota_log_get(log,ota_execution,&view,NULL)==LI_OK);
        strcpy(ota_outcome.boot_id,ota_original_boot);
        strcpy(ota_outcome.firmware_version,running.firmware_version); strcpy(ota_outcome.image_sha256,running.image_sha256);
        ota_outcome.security_epoch=running.security_epoch; strcpy(ota_outcome.error,"fixture_failed");
        if (ota_fault_step!=5) {
            if (ota_fault_step==2) { ota_before_error(); error=li_ota_log_advance(log,ota_execution,LI_OTA_INSTALLING); goto complete; }
            assert(li_ota_log_advance(log,ota_execution,LI_OTA_INSTALLING)==LI_OK);
            if (ota_fault_step!=6) {
                if (ota_fault_step==3) { ota_before_error(); error=li_ota_log_advance(log,ota_execution,LI_OTA_AWAITING_BOOT); goto complete; }
                assert(li_ota_log_advance(log,ota_execution,LI_OTA_AWAITING_BOOT)==LI_OK);
                if (ota_fault_step==4) { ota_before_error(); error=li_ota_log_bind_boot(log,ota_execution,"fixture-boot-binding"); goto complete; }
                assert(li_ota_log_bind_boot(log,ota_execution,"fixture-boot-binding")==LI_OK);
                strcpy(ota_outcome.boot_id,"fixture-next-boot");
                if (ota_fault_step==7) {
                    strcpy(ota_outcome.firmware_version,view->target_version); strcpy(ota_outcome.image_sha256,view->target_image_sha256);
                    ota_outcome.security_epoch=view->target_security_epoch; ota_outcome.error[0]=0;
                }
            }
        }
        ota_before_error();
        li_ota_stage_t terminal=ota_fault_step==5?LI_OTA_REJECTED:ota_fault_step==6?LI_OTA_FAILED:ota_fault_step==7?LI_OTA_SUCCEEDED:LI_OTA_ROLLED_BACK;
        error=li_ota_log_finish(log,ota_execution,terminal,&ota_outcome);
    }
complete:
    assert(error==LI_STORAGE&&ota_commit_failures==1&&ota_commit_attempts==ota_commit_number);
    ota_frozen(); checked=true;
}
static void ota_check_recovered(void) {
    ota_input(); li_ota_log_t *log=runtime.adapter->ota_log;
    const li_ota_log_view_t *view=NULL; const char *original=NULL;
    li_error_t error=li_ota_log_get(log,ota_execution,&view,&original);
    cJSON *result=cJSON_CreateObject(); assert(result);
    assert(cJSON_AddStringToObject(result,"code",li_error_code(error)));
    assert(cJSON_AddBoolToObject(result,"blocked",li_ota_log_blocked(log)));
    if (error==LI_OK) {
        assert(view&&original); li_ota_baseline_t running=baseline();
        assert(li_ota_log_prepare(log,ota_original,strlen(ota_original),&running)==LI_IGNORED);
        if (view->recovered) {
            assert(li_ota_log_advance(log,ota_execution,LI_OTA_INSTALLING)==LI_CONFLICT);
            assert(li_ota_log_advance(log,ota_execution,LI_OTA_AWAITING_BOOT)==LI_CONFLICT);
            assert(li_ota_log_bind_boot(log,ota_execution,"fixture-boot-binding")== (view->boot_binding[0]?LI_IGNORED:LI_CONFLICT));
            assert(write_property(runtime.adapter,"light.power",(li_value_t){.type=LI_BOOLEAN,.boolean=true})==LI_NOT_APPLIED);
        }
        assert(cJSON_AddStringToObject(result,"stage",li_ota_stage_name(view->stage)));
        assert(cJSON_AddBoolToObject(result,"recovered",view->recovered));
        assert(cJSON_AddStringToObject(result,"request_digest",view->request_digest));
        assert(cJSON_AddStringToObject(result,"boot_binding",view->boot_binding));
    } else assert(error==LI_IGNORED&&!view&&!original&&!li_ota_log_blocked(log));
    assert(!runtime.nvs_writes[2]&&!runtime.commits&&!runtime.effects);
    char *raw=cJSON_PrintUnformatted(result); assert(raw); durable_file("ota-recovery-check.json",raw,strlen(raw));free(raw);cJSON_Delete(result); checked=true;
}
static void ota_observation(void) {
    if (!strcmp(runtime.mode,"ota-fault")) ota_frozen();
    char report[1024]; int size=snprintf(report,sizeof(report),
        "{\"ready\":%s,\"connects\":%u,\"reconnects\":%u,\"pending_messages\":%u,\"commands_received\":%u,\"ota_installs_received\":%u,\"ota_queries_received\":%u,\"process_effects\":%u,\"receipt_writes\":%u,\"ota_writes\":%u,\"identity_writes\":%u,\"ota_commit_attempts\":%u,\"ota_commit_failures\":%u,\"ota_stage_calls\":%u,\"ota_activate_calls\":%u,\"ota_restart_calls\":%u,\"ota_results\":%u,\"ota_blocked\":%s}\n",
        li_espidf_ready(runtime.adapter)?"true":"false",runtime.connects,runtime.reconnects,runtime.adapter->queue->size,runtime.command_messages,runtime.ota_installs,runtime.ota_queries,runtime.effects,runtime.commits,runtime.nvs_writes[2],runtime.nvs_writes[3],ota_commit_attempts,ota_commit_failures,runtime.ota_stage_calls,runtime.ota_activate_calls,runtime.ota_restart_calls,runtime.ota_results,li_ota_log_blocked(runtime.adapter->ota_log)?"true":"false");
    static char previous[1024]; assert(size>0&&size<(int)sizeof(report));
    if (strcmp(previous,report)) { durable_file("ota-observed.json",report,(size_t)size); strcpy(previous,report); }
}
static void recovery_poll(void) {
    if (!runtime.adapter||!li_espidf_ready(runtime.adapter)) return;
    if (!strncmp(runtime.mode,"ota-",4)) {
        if (!checked) {
            char location[PATH_MAX]; file_path(location,"ota-request.json");
            if (access(location,F_OK)!=0) return;
            if (!strcmp(runtime.mode,"ota-fault")) ota_fail_commit(); else ota_check_recovered();
        }
        ota_observation(); return;
    }
    if (!strcmp(runtime.mode,"after")&&checked&&(runtime.command_messages!=observed_commands||runtime.ota_queries!=observed_queries)) {
        char record[384]; int size=snprintf(record,sizeof(record),"{\"commands_received\":%u,\"ota_queries_received\":%u,\"process_effects\":%u,\"receipt_writes\":%u,\"ota_writes\":%u,\"receipt_commit_attempts\":%u,\"receipt_commit_failures\":%u}\n",runtime.command_messages,runtime.ota_queries,runtime.effects,runtime.commits,runtime.nvs_writes[2],receipt_commit_attempts,receipt_commit_failures);
        assert(size>0&&size<(int)sizeof(record)); durable_file("recovery-observed.json",record,(size_t)size); observed_commands=runtime.command_messages; observed_queries=runtime.ota_queries;
    }
    char location[PATH_MAX]; file_path(location,"prepare-ota.json");
    if (!strcmp(runtime.mode,"before")&&!seeded&&access(location,F_OK)==0) {
        char *raw=read_text("prepare-ota.json"); li_ota_baseline_t running=baseline();
        assert(li_ota_log_prepare(runtime.adapter->ota_log,raw,strlen(raw),&running)==LI_OK);
        const li_ota_log_view_t *view=NULL; assert(li_ota_log_pending(runtime.adapter->ota_log,&view)==LI_OK);
        assert(!view->recovered&&li_ota_log_advance(runtime.adapter->ota_log,view->execution_id,LI_OTA_INSTALLING)==LI_OK);
        const char result[]="{\"production_log_api\":true,\"installation_performed\":false}\n";
        durable_file("ota-seeded.json",result,sizeof(result)-1);
        free(raw); seeded=true;
    }
    if (!strcmp(runtime.mode,"after")&&!checked) {
        const li_ota_log_view_t *view=NULL; li_error_t result=li_ota_log_pending(runtime.adapter->ota_log,&view);
        bool blocked=li_ota_log_blocked(runtime.adapter->ota_log), recovered=false, read_only=false, old_rejected=false;
        unsigned before=runtime.nvs_writes[2];
        if (result==LI_OK) {
            assert(view&&view->recovered&&view->stage==LI_OTA_INSTALLING&&blocked); recovered=true;
            const char *original=NULL; const li_ota_log_view_t *queried=NULL;
            assert(li_ota_log_get(runtime.adapter->ota_log,view->execution_id,&queried,&original)==LI_OK&&queried==view);
            assert(li_ota_log_advance(runtime.adapter->ota_log,view->execution_id,LI_OTA_AWAITING_BOOT)==LI_CONFLICT);
            li_ota_baseline_t running=baseline();
            assert(li_ota_log_prepare(runtime.adapter->ota_log,original,strlen(original),&running)==LI_IGNORED);
            assert(write_property(runtime.adapter,"light.power",(li_value_t){.type=LI_BOOLEAN,.boolean=true})==LI_NOT_APPLIED);
            read_only=runtime.nvs_writes[2]==before;
        } else assert(result==LI_IGNORED&&!blocked);
        file_path(location,"old-command.json");
        if (access(location,F_OK)==0) {
            char *raw=read_text("old-command.json"); unsigned receipts=runtime.commits, effects=runtime.effects;
            assert(li_receive(runtime.adapter->core,"limeiot/v1/space-demo/device-lamp/down/command",raw,strlen(raw),false)==LI_SESSION);
            old_rejected=receipts==runtime.commits&&effects==runtime.effects; free(raw);
        }
        char report[512]; int size=snprintf(report,sizeof(report),"{\"ota_blocked\":%s,\"ota_recovered\":%s,\"ota_queries_read_only\":%s,\"old_session_rejected\":%s,\"effects_at_recovery\":%u,\"receipt_writes_at_recovery\":%u,\"ota_writes_at_recovery\":%u}\n",
            blocked?"true":"false",recovered?"true":"false",read_only?"true":"false",old_rejected?"true":"false",runtime.effects,runtime.commits,runtime.nvs_writes[2]);
        assert(size>0&&size<(int)sizeof(report)); durable_file("recovery-check.json",report,(size_t)size); checked=true;
    }
}
static void recovery_close(li_espidf_identity_t *identity,char *ca,char *key,size_t key_size) {
    runtime.finishing=true;
    if (runtime.adapter) {
        work_t queued; while (xQueueReceive(runtime.adapter->queue,&queued,0)==pdTRUE) free(queued.payload);
        reset_incoming(runtime.adapter); esp_mqtt_client_destroy(runtime.adapter->mqtt); vQueueDelete(runtime.adapter->queue);
        li_core_destroy(runtime.adapter->core); close_ota_log(runtime.adapter); nvs_close(runtime.adapter->journal); free(runtime.adapter);
    }
    li_espidf_identity_close(identity); mosquitto_lib_cleanup(); OPENSSL_cleanse(key,key_size); free(ota_original);
    OPENSSL_cleanse(identity_root,sizeof(identity_root)); free(ca);
}
int main(int argc,char **argv) {
    if ((argc!=4&&argc!=5)||(strcmp(argv[3],"before")&&strcmp(argv[3],"after")&&strcmp(argv[3],"start-check")&&strcmp(argv[3],"ota-fault")&&strcmp(argv[3],"ota-check"))) return 5;
    if (argc==5) {
        const char *ota_modes[]={"prepare","installing","awaiting_boot","bind_boot","rejected","failed","succeeded","rolled_back"};
        for (unsigned i=0;i<8;i++) {
            char before[48],after[48]; assert(snprintf(before,sizeof(before),"ota-%s-before",ota_modes[i])<(int)sizeof(before));
            assert(snprintf(after,sizeof(after),"ota-%s-after",ota_modes[i])<(int)sizeof(after));
            if (!strcmp(argv[4],before)||!strcmp(argv[4],after)) { static const unsigned counts[]={1,2,3,4,2,3,5,5}; ota_fault_step=i+1;ota_commit_number=counts[i];ota_commit_after=!strcmp(argv[4],after);break; }
        }
        if (ota_fault_step) { if (strcmp(argv[3],"ota-fault")) return 5; }
        else if (!strcmp(argv[4],"receipt-read-size")) failed_read_handle=1;
        else if (!strcmp(argv[4],"receipt-read-data")) { failed_read_handle=1; failed_read_data=true; }
        else if (!strcmp(argv[4],"ota-read-size")) failed_read_handle=2;
        else if (!strcmp(argv[4],"ota-read-data")) { failed_read_handle=2; failed_read_data=true; }
        else if (!strcmp(argv[4],"intent-before")) failed_commit_number=1;
        else if (!strcmp(argv[4],"intent-after")) { failed_commit_number=1; failed_commit_after=true; }
        else if (!strcmp(argv[4],"terminal-before")) failed_commit_number=2;
        else if (!strcmp(argv[4],"terminal-after")) { failed_commit_number=2; failed_commit_after=true; }
        else return 5;
    }
    signal(SIGPIPE,SIG_IGN); signal(SIGINT,on_signal); signal(SIGTERM,on_signal); umask(0077);
    runtime.directory=argv[1]; runtime.mode=argv[3]; runtime.trusted=true;
    load_exact("root.bin",identity_root,sizeof(identity_root)); load_exact("binding.bin",identity_binding,sizeof(identity_binding));
    char location[PATH_MAX]; file_path(location,"effects-total.json");
    if (access(location,F_OK)==0) { char *raw=read_text("effects-total.json"); cJSON *record=cJSON_Parse(raw); assert(record); total_effects=(unsigned)cJSON_GetObjectItemCaseSensitive(record,"total_effects")->valuedouble;cJSON_Delete(record);free(raw); }
    char *ca=read_text("ca.crt"), certificate[LI_IDENTITY_CERT_PEM_SIZE]={0}, key[LI_IDENTITY_KEY_PEM_SIZE]={0};
    li_espidf_identity_options_t identity_options={"space-demo","device-lamp",ca,NULL,driver_clock};
    li_espidf_identity_t *identity=NULL; assert(li_espidf_identity_open(&identity_options,&identity)==LI_OK);
    li_espidf_identity_status_t status={0}; assert(li_espidf_identity_status(identity,&status)==LI_OK);
    assert(li_espidf_identity_credentials(identity,certificate,sizeof(certificate),key,sizeof(key))==LI_OK);
    li_espidf_options_t options={.core={.space_id="space-demo",.device_id="device-lamp",.model_revision=LI_LAMP_REVISION,.firmware_version="0.2.0",.hardware_revision="host-fixture",
        .properties=LI_LAMP_PROPERTIES,.property_count=LI_LAMP_PROPERTY_COUNT,.observation_source="host-fixture"},
        .broker_host="127.0.0.1",.broker_port=(uint16_t)strtoul(argv[2],NULL,10),.ca_pem=ca,.certificate_pem=certificate,.private_key_pem=key,
        .trusted_clock=driver_clock,.read_property=driver_read,.write_property=driver_write};
    assert(options.broker_port&&mosquitto_lib_init()==MOSQ_ERR_SUCCESS);
    li_error_t started=li_espidf_start(&options,&runtime.adapter);
    if (started!=LI_OK||!strcmp(runtime.mode,"start-check")) {
        char report[512]; int size=snprintf(report,sizeof(report),"{\"start_code\":\"%s\",\"adapter_created\":%s,\"task_created\":%s,\"mqtt_inits\":%u,\"connects\":%u,\"process_effects\":%u,\"receipt_writes\":%u,\"ota_writes\":%u,\"identity_writes\":%u,\"read_failures\":%u}\n",
            li_error_code(started),runtime.adapter?"true":"false",runtime.task?"true":"false",recovery_mqtt_inits,runtime.connects,runtime.effects,runtime.commits,runtime.nvs_writes[2],runtime.nvs_writes[3],read_failures);
        assert(size>0&&size<(int)sizeof(report)); durable_file("start-result.json",report,(size_t)size); fputs(report,stdout);
        recovery_close(identity,ca,key,sizeof(key)); return !strcmp(runtime.mode,"start-check")?0:1;
    }
    assert(started==LI_OK&&runtime.task);
    if (!setjmp(finished)) runtime.task(runtime.task_context);
    runtime.finishing=true;
    char report[1024]; int size=snprintf(report,sizeof(report),"{\"phase\":\"%s\",\"identity_generation\":%u,\"public_key_fingerprint\":\"%s\",\"certificate_fingerprint\":\"%s\",\"process_effects\":%u,\"total_effects\":%u,\"effects_after_invalidation\":%u,\"ready\":%s,\"locked\":%s,\"connects\":%u,\"stops\":%u,\"receipt_writes\":%u,\"ota_writes\":%u,\"identity_writes\":%u,\"receipt_commit_attempts\":%u,\"receipt_commit_failures\":%u,\"same_process_identity_tls\":true,\"hardware\":false}\n",
        runtime.mode,status.generation,status.public_key_fingerprint,status.certificate_fingerprint,runtime.effects,total_effects,runtime.effects_after,
        li_espidf_ready(runtime.adapter)?"true":"false",atomic_load(&runtime.adapter->credential_window.blocked)?"true":"false",runtime.connects,runtime.stops,runtime.commits,runtime.nvs_writes[2],runtime.nvs_writes[3],receipt_commit_attempts,receipt_commit_failures);
    assert(size>0&&size<(int)sizeof(report)); char output[48]; assert(snprintf(output,sizeof(output),"recovery-%s-result.json",runtime.mode)<(int)sizeof(output)); durable_file(output,report,(size_t)size);
    recovery_close(identity,ca,key,sizeof(key)); return 0;
}
