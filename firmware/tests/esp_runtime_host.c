/* 运行生产适配器和C核心。队列/NVS/驱动为宿主夹具，传输为libmosquitto/OpenSSL。 */
#include "../components/limeiot_espidf/src/espidf.c"
#include "ota_host_crypto.h"
#include "lamp.h"
#include <mosquitto.h>
#include <mqtt_protocol.h>
#include <openssl/crypto.h>
#include <openssl/rand.h>
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <setjmp.h>
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>

struct runtime_queue { unsigned capacity, size, head; size_t item_size; unsigned char *items; };
struct runtime_mqtt {
    struct mosquitto *client;
    esp_event_handler_t callback; void *context;
    const char *host; unsigned port; int keepalive;
    enum { TRANSPORT_NEW, TRANSPORT_PENDING, TRANSPORT_CONNECTED, TRANSPORT_WAIT, TRANSPORT_STOPPED } state;
};
static struct {
    const char *directory, *mode;
    char ca_file[PATH_MAX], certificate_file[PATH_MAX], key_file[PATH_MAX];
    li_espidf_t *adapter;
    void (*task)(void *); void *task_context;
    bool trusted, power, disconnect_injected, finishing, gated;
    int64_t brightness, stopped_at;
    unsigned effects, effects_after, connects, reconnects, stops, publishes, fragments, commits;
    unsigned publishes_at_gate, reconnects_at_gate;
    unsigned command_messages, queued_before_gate, consumed_after_gate, stale_generation;
    unsigned ota_queries, ota_installs, ota_results, ota_stage_calls, ota_activate_calls, ota_restart_calls;
    unsigned nvs_writes[4];
    struct { char key[16]; void *data; size_t size; } pending[4];
} runtime;
#ifdef LI_ESP_RECOVERY_HOST
static void recovery_tls(esp_mqtt_client_handle_t, const esp_mqtt_client_config_t *);
static li_apply_result_t recovery_apply(const char *, li_value_t);
static void recovery_poll(void);
static bool recovery_read_failure(nvs_handle_t, const char *, const void *);
static bool recovery_commit_failure(nvs_handle_t, bool);
static unsigned recovery_mqtt_inits;
#endif
#ifdef LI_ESP_INSTALL_HOST
static bool install_commit_failure(nvs_handle_t, bool);
static void install_poll(void);
#endif
#ifdef LI_ESP_NATIVE_INSTALL_HOST
static void native_ota_publishing(const char *, int);
#endif
static volatile sig_atomic_t stopping;
static jmp_buf finished;
static void on_signal(int number) { (void)number; stopping=1; }
static void pause_ms(unsigned ms) { struct timespec delay={ms/1000,(long)(ms%1000)*1000000}; while (nanosleep(&delay,&delay) && errno==EINTR) {} }
static void file_path(char output[PATH_MAX], const char *name) {
    assert(snprintf(output,PATH_MAX,"%s/%s",runtime.directory,name)<PATH_MAX);
}
static void durable_file(const char *name, const void *data, size_t size) {
    char destination[PATH_MAX], temporary[PATH_MAX]; file_path(destination,name);
    assert(snprintf(temporary,sizeof(temporary),"%s.tmp",destination)<(int)sizeof(temporary));
    int fd=open(temporary,O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW,0600); assert(fd>=0);
    size_t offset=0;
    while (offset<size) { ssize_t written=write(fd,(const char *)data+offset,size-offset); assert(written>0); offset+=(size_t)written; }
    assert(fsync(fd)==0); assert(close(fd)==0); assert(rename(temporary,destination)==0);
    fd=open(runtime.directory,O_RDONLY); assert(fd>=0); assert(fsync(fd)==0); assert(close(fd)==0);
}
static char *read_text(const char *name) {
    char location[PATH_MAX]; file_path(location,name); FILE *file=fopen(location,"rb"); assert(file);
    char *result=calloc(65537,1); assert(result); size_t size=fread(result,1,65536,file);
    assert(!ferror(file)&&fgetc(file)==EOF&&size>0); assert(fclose(file)==0); return result;
}
int sodium_memcmp(const void *a, const void *b, size_t size) { return CRYPTO_memcmp(a,b,size); }
bool li_esp_sha256(void *context, const uint8_t *data, size_t size, uint8_t digest[32]) { return hash(context,data,size,digest); }
bool li_espidf_ota_crypto(li_ota_crypto_t *out) { *out=(li_ota_crypto_t){NULL,hash,verify}; return true; }
/* 本阶段不提供升级设备：所有分区/安装/重启端口明确失败。 */
#ifndef LI_ESP_INSTALL_HOST
const esp_partition_t *esp_ota_get_running_partition(void) { return NULL; }
#ifndef LI_ESP_RECOVERY_HOST
esp_err_t esp_partition_read(const esp_partition_t *p,size_t o,void *d,size_t s) { (void)p;(void)o;(void)d;(void)s;return ESP_FAIL; }
#endif
esp_err_t esp_image_verify(int m,const esp_partition_pos_t *p,esp_image_metadata_t *d) { (void)m;(void)p;(void)d;return ESP_FAIL; }
const esp_app_desc_t *esp_app_get_description(void) { static const esp_app_desc_t app={"0.2.0"};return &app; }
void esp_restart(void) { runtime.ota_restart_calls++; abort(); }
li_error_t li_espidf_ota_stage(const li_ota_candidate_t *c,const char *ca,const li_ota_transfer_guard_t *g,li_ota_transfer_result_t *r,const char **i) {
    runtime.ota_stage_calls++; (void)c;(void)ca;(void)g;(void)r; if (i) *i="host_ota_unavailable"; return LI_INVALID;
}
bool li_esp_ota_activate(const li_ota_candidate_t *c,const li_ota_transfer_guard_t *g,char b[LI_OTA_LOG_ID_SIZE]) { runtime.ota_activate_calls++;(void)c;(void)g;(void)b;return false; }
bool li_esp_ota_observe(const li_ota_log_view_t *v,li_ota_stage_t *s,li_ota_outcome_t *o) { (void)v;(void)s;(void)o;return false; }
#endif
void esp_fill_random(void *data,size_t size) { assert(size<=INT_MAX&&RAND_bytes(data,(int)size)==1); }
int64_t esp_timer_get_time(void) { struct timespec now; assert(clock_gettime(CLOCK_MONOTONIC,&now)==0);return (int64_t)now.tv_sec*1000000+now.tv_nsec/1000; }
#ifndef LI_ESP_RECOVERY_HOST
li_error_t li_espidf_storage_init_partition(const char *partition) { return !strcmp(partition,"journal")?LI_OK:LI_INVALID; }
#endif
esp_err_t nvs_open_from_partition(const char *partition,const char *name,int mode,nvs_handle_t *handle) {
    assert(!strcmp(partition,"journal")&&mode==NVS_READWRITE);
    if (!strcmp(name,"receipts")) *handle=1; else if (!strcmp(name,"ota")) *handle=2;
#ifdef LI_ESP_RECOVERY_HOST
    else if (!strcmp(name,"li-identity")) *handle=3;
#endif
    else return ESP_FAIL;
    return ESP_OK;
}
static void nvs_name(char name[48],nvs_handle_t handle,const char *key) {
#ifdef LI_ESP_RECOVERY_HOST
    if (handle==3) { assert(!strcmp(key,"identity")); strcpy(name,"identity.blob"); return; }
#endif
    assert(handle==1||handle==2); assert(strlen(key)<16);
    for (const char *p=key;*p;p++) assert((*p>='a'&&*p<='z')||(*p>='0'&&*p<='9'));
    assert(snprintf(name,48,"nvs-%u-%s.json",handle,key)<48);
}
esp_err_t nvs_get_blob(nvs_handle_t handle,const char *key,void *data,size_t *size) {
#ifdef LI_ESP_RECOVERY_HOST
    if (recovery_read_failure(handle,key,data)) return ESP_FAIL;
#endif
    char name[48],location[PATH_MAX]; nvs_name(name,handle,key); file_path(location,name);
    FILE *file=fopen(location,"rb"); if (!file) return errno==ENOENT?ESP_ERR_NVS_NOT_FOUND:ESP_FAIL;
    struct stat status; assert(fstat(fileno(file),&status)==0&&S_ISREG(status.st_mode)&&status.st_size>=0);
    size_t actual=(size_t)status.st_size; bool ok=!data||(*size>=actual&&fread(data,1,actual,file)==actual&&!ferror(file));
    *size=actual; assert(fclose(file)==0); return ok?ESP_OK:ESP_FAIL;
}
esp_err_t nvs_set_blob(nvs_handle_t handle,const char *key,const void *data,size_t size) {
    char name[48]; nvs_name(name,handle,key); free(runtime.pending[handle].data);
    runtime.pending[handle].data=malloc(size); assert(runtime.pending[handle].data);
    memcpy(runtime.pending[handle].data,data,size); runtime.pending[handle].size=size; strcpy(runtime.pending[handle].key,key); return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t handle) {
    assert(handle>0&&handle<sizeof(runtime.pending)/sizeof(runtime.pending[0])); assert(runtime.pending[handle].data);
#ifdef LI_ESP_RECOVERY_HOST
    if (recovery_commit_failure(handle,false)) return ESP_FAIL;
#endif
#ifdef LI_ESP_INSTALL_HOST
    if (install_commit_failure(handle,false)) return ESP_FAIL;
#endif
    char name[48]; nvs_name(name,handle,runtime.pending[handle].key);
    durable_file(name,runtime.pending[handle].data,runtime.pending[handle].size);
    runtime.nvs_writes[handle]++;
    if (handle==1&&++runtime.commits==3&&(!strcmp(runtime.mode,"expiry")||!strcmp(runtime.mode,"ca-expiry")||!strcmp(runtime.mode,"clock"))) {
        /* 第二条命令的真实intent已落盘；让生产驱动门禁面对失效身份。 */
        durable_file("pending-intent.json",runtime.pending[handle].data,runtime.pending[handle].size);
        runtime.gated=true; runtime.publishes_at_gate=runtime.publishes; runtime.reconnects_at_gate=runtime.reconnects;
        if (!strcmp(runtime.mode,"clock")) runtime.trusted=false;
        int64_t deadline=esp_timer_get_time()+20000000;
        while (li_credential_window_current(&runtime.adapter->credential_window,runtime.trusted)&&!stopping) {
            assert(esp_timer_get_time()<deadline); pause_ms(20);
        }
    }
    OPENSSL_cleanse(runtime.pending[handle].data,runtime.pending[handle].size);
    free(runtime.pending[handle].data); runtime.pending[handle].data=NULL;
#ifdef LI_ESP_RECOVERY_HOST
    if (recovery_commit_failure(handle,true)) return ESP_FAIL;
#endif
#ifdef LI_ESP_INSTALL_HOST
    if (install_commit_failure(handle,true)) return ESP_FAIL;
#endif
    return ESP_OK;
}
void nvs_close(nvs_handle_t handle) {
    assert(handle<sizeof(runtime.pending)/sizeof(runtime.pending[0]));
    if (runtime.pending[handle].data) OPENSSL_cleanse(runtime.pending[handle].data,runtime.pending[handle].size);
    free(runtime.pending[handle].data); runtime.pending[handle].data=NULL;
}
static void emit(esp_mqtt_client_handle_t mqtt,int event,esp_mqtt_event_t *data) { mqtt->callback(mqtt->context,"MQTT",event,data); }
static void on_connect(struct mosquitto *client,void *context,int reason,int flags,const mosquitto_property *properties) {
    (void)client;(void)flags;(void)properties; esp_mqtt_client_handle_t mqtt=context; assert(reason==0);
    mqtt->state=TRANSPORT_CONNECTED; runtime.connects++; esp_mqtt_event_t event={0}; emit(mqtt,MQTT_EVENT_CONNECTED,&event);
}
static void on_disconnect(struct mosquitto *client,void *context,int reason,const mosquitto_property *properties) {
    (void)client;(void)reason;(void)properties; esp_mqtt_client_handle_t mqtt=context;
    if (mqtt->state!=TRANSPORT_STOPPED) mqtt->state=TRANSPORT_WAIT;
    esp_mqtt_event_t event={0}; emit(mqtt,MQTT_EVENT_DISCONNECTED,&event);
}
static void on_subscribe(struct mosquitto *client,void *context,int mid,int count,const int *granted,const mosquitto_property *properties) {
    (void)client;(void)properties; assert(count==1); char qos=(char)granted[0]; esp_mqtt_event_t event={.msg_id=mid,.data=&qos,.data_len=1};
    emit(context,MQTT_EVENT_SUBSCRIBED,&event);
}
static void on_message(struct mosquitto *client,void *context,const struct mosquitto_message *message,const mosquitto_property *properties) {
    (void)client;(void)properties;
    if (strstr(message->topic,"/down/ota_query")) runtime.ota_queries++;
    if (strstr(message->topic,"/down/ota_install")) runtime.ota_installs++;
#ifdef LI_ESP_RECOVERY_HOST
    if (!strcmp(runtime.mode,"before")&&strstr(message->topic,"/down/command")&&!runtime.command_messages)
        durable_file("old-command.json",message->payload,(size_t)message->payloadlen);
#endif
    /* 每条报文分片，实际执行生产mqtt_event重组和队列入队。 */
    for (int offset=0;offset<message->payloadlen;) {
        int size=message->payloadlen-offset; if (size>31) size=31;
        esp_mqtt_event_t event={.topic=offset?NULL:message->topic,.topic_len=offset?0:(int)strlen(message->topic),.data=(char *)message->payload+offset,
            .data_len=size,.total_data_len=message->payloadlen,.current_data_offset=offset,.retain=message->retain};
        runtime.fragments++; emit(context,MQTT_EVENT_DATA,&event); offset+=size;
    }
    if (strstr(message->topic,"/down/command")&&++runtime.command_messages==2&&(!strcmp(runtime.mode,"expiry")||!strcmp(runtime.mode,"ca-expiry")||!strcmp(runtime.mode,"clock"))) {
        /* 同一有效请求在到期前排队；worker跨到期返回后必须丢弃它。 */
        work_t queued={.kind=WORK_MESSAGE,.generation=atomic_load(&runtime.adapter->generation),.length=(size_t)message->payloadlen,.retained=message->retain};
        assert(strlen(message->topic)<sizeof(queued.topic)); strcpy(queued.topic,message->topic);
        queued.payload=malloc(queued.length+1); assert(queued.payload); memcpy(queued.payload,message->payload,queued.length); queued.payload[queued.length]=0;
        assert(xQueueSend(runtime.adapter->queue,&queued,0)==pdTRUE); runtime.queued_before_gate++;
    }
}
esp_mqtt_client_handle_t esp_mqtt_client_init(const esp_mqtt_client_config_t *config) {
#ifdef LI_ESP_RECOVERY_HOST
    recovery_mqtt_inits++;
#endif
    assert(config->network.disable_auto_reconnect&&!config->session.disable_clean_session);
    assert(config->session.protocol_ver==MQTT_PROTOCOL_V_5&&config->broker.address.transport==MQTT_TRANSPORT_OVER_SSL);
    assert(!config->broker.verification.skip_cert_common_name_check&&!strcmp(config->broker.address.hostname,"127.0.0.1"));
    esp_mqtt_client_handle_t mqtt=calloc(1,sizeof(*mqtt)); assert(mqtt);
    mqtt->host=config->broker.address.hostname; mqtt->port=config->broker.address.port; mqtt->keepalive=config->session.keepalive;
    mqtt->client=mosquitto_new(config->credentials.client_id,true,mqtt); assert(mqtt->client);
    assert(mosquitto_int_option(mqtt->client,MOSQ_OPT_PROTOCOL_VERSION,MQTT_PROTOCOL_V5)==MOSQ_ERR_SUCCESS);
#ifdef LI_ESP_RECOVERY_HOST
    recovery_tls(mqtt,config);
#else
    assert(mosquitto_tls_set(mqtt->client,runtime.ca_file,NULL,runtime.certificate_file,runtime.key_file,NULL)==MOSQ_ERR_SUCCESS);
#endif
    assert(mosquitto_tls_insecure_set(mqtt->client,false)==MOSQ_ERR_SUCCESS);
    assert(mosquitto_tls_opts_set(mqtt->client,1,"tlsv1.2",NULL)==MOSQ_ERR_SUCCESS);
    mosquitto_connect_v5_callback_set(mqtt->client,on_connect); mosquitto_disconnect_v5_callback_set(mqtt->client,on_disconnect);
    mosquitto_subscribe_v5_callback_set(mqtt->client,on_subscribe); mosquitto_message_v5_callback_set(mqtt->client,on_message); return mqtt;
}
esp_err_t esp_mqtt5_client_set_connect_property(esp_mqtt_client_handle_t mqtt,const esp_mqtt5_connection_property_config_t *p) {
    (void)mqtt; assert(!p->session_expiry_interval&&p->receive_maximum==4&&p->maximum_packet_size==LI_MAX_PACKET+512); return ESP_OK;
}
esp_err_t esp_mqtt_client_register_event(esp_mqtt_client_handle_t mqtt,int id,esp_event_handler_t callback,void *context) {
    assert(id==ESP_EVENT_ANY_ID); mqtt->callback=callback; mqtt->context=context; return ESP_OK;
}
esp_err_t esp_mqtt_client_start(esp_mqtt_client_handle_t mqtt) {
    assert(mqtt->state==TRANSPORT_NEW); mqtt->state=TRANSPORT_PENDING;
    int result=mosquitto_connect(mqtt->client,mqtt->host,(int)mqtt->port,mqtt->keepalive);
    if (result!=MOSQ_ERR_SUCCESS) fprintf(stderr,"host MQTT start: %s\n",mosquitto_strerror(result));
    return result==MOSQ_ERR_SUCCESS?ESP_OK:ESP_FAIL;
}
esp_err_t esp_mqtt_client_reconnect(esp_mqtt_client_handle_t mqtt) {
    runtime.reconnects++; if (mqtt->state!=TRANSPORT_WAIT) return ESP_FAIL;
    mqtt->state=TRANSPORT_PENDING; return mosquitto_reconnect(mqtt->client)==MOSQ_ERR_SUCCESS?ESP_OK:ESP_FAIL;
}
esp_err_t esp_mqtt_client_disconnect(esp_mqtt_client_handle_t mqtt) { return mosquitto_disconnect(mqtt->client)==MOSQ_ERR_SUCCESS?ESP_OK:ESP_FAIL; }
esp_err_t esp_mqtt_client_stop(esp_mqtt_client_handle_t mqtt) {
    runtime.stops++; mqtt->state=TRANSPORT_STOPPED; runtime.stopped_at=esp_timer_get_time();
    (void)mosquitto_disconnect(mqtt->client); return ESP_OK;
}
esp_err_t esp_mqtt_client_destroy(esp_mqtt_client_handle_t mqtt) { mosquitto_destroy(mqtt->client); free(mqtt); return ESP_OK; }
int esp_mqtt_client_subscribe(esp_mqtt_client_handle_t mqtt,const char *topic,int qos) {
    int mid=-1; return mosquitto_subscribe_v5(mqtt->client,&mid,topic,qos,0,NULL)==MOSQ_ERR_SUCCESS?mid:-1;
}
int esp_mqtt_client_enqueue(esp_mqtt_client_handle_t mqtt,const char *topic,const char *data,int length,int qos,int retain,bool store) {
    assert(store&&qos==1&&!retain); runtime.publishes++;
    if (strstr(topic,"/up/ota_result")) {
#ifdef LI_ESP_NATIVE_INSTALL_HOST
        native_ota_publishing(data,length);
#endif
        runtime.ota_results++;
    }
    int mid=-1; return mosquitto_publish_v5(mqtt->client,&mid,topic,length,data,qos,retain,NULL)==MOSQ_ERR_SUCCESS?mid:-1;
}
QueueHandle_t xQueueCreate(unsigned capacity,unsigned size) {
    QueueHandle_t queue=calloc(1,sizeof(*queue)); assert(queue); queue->capacity=capacity; queue->item_size=size;
    queue->items=calloc(capacity,size); assert(queue->items); return queue;
}
int xQueueSend(QueueHandle_t queue,const void *item,TickType_t ticks) {
    assert(!ticks); if (queue->size==queue->capacity) return pdFALSE;
    memcpy(queue->items+((queue->head+queue->size)%queue->capacity)*queue->item_size,item,queue->item_size); queue->size++; return pdTRUE;
}
int xQueueReceive(QueueHandle_t queue,void *item,TickType_t ticks) {
    int64_t end=esp_timer_get_time()+(int64_t)ticks*1000;
    do {
        if (ticks&&!runtime.finishing) {
#ifdef LI_ESP_RECOVERY_HOST
            recovery_poll();
#endif
#ifdef LI_ESP_INSTALL_HOST
            install_poll();
#endif
            if (stopping||(runtime.stopped_at&&esp_timer_get_time()-runtime.stopped_at>=500000)) longjmp(finished,1);
            esp_mqtt_client_handle_t mqtt=runtime.adapter->mqtt;
            char trigger[PATH_MAX]; file_path(trigger,"disconnect");
            if (!runtime.disconnect_injected&&access(trigger,F_OK)==0) {
                runtime.disconnect_injected=true; assert(esp_mqtt_client_disconnect(mqtt)==ESP_OK);
            }
            if (mqtt->state==TRANSPORT_PENDING||mqtt->state==TRANSPORT_CONNECTED) {
                int error=mosquitto_loop(mqtt->client,0,10);
                if (error!=MOSQ_ERR_SUCCESS&&mqtt->state!=TRANSPORT_WAIT) on_disconnect(mqtt->client,mqtt,error,NULL);
            }
        }
        if (queue->size) {
            memcpy(item,queue->items+queue->head*queue->item_size,queue->item_size); queue->head=(queue->head+1)%queue->capacity; queue->size--;
            if (runtime.gated&&!runtime.finishing) {
                runtime.consumed_after_gate++;
                if (((work_t *)item)->generation!=atomic_load(&runtime.adapter->generation)) runtime.stale_generation++;
            }
            return pdTRUE;
        }
        if (ticks) pause_ms(5);
    } while (ticks&&esp_timer_get_time()<end);
    return pdFALSE;
}
void vQueueDelete(QueueHandle_t queue) { free(queue->items); free(queue); }
int xTaskCreate(void (*task)(void *),const char *name,unsigned stack,void *context,unsigned priority,void *handle) {
    (void)name;(void)stack;(void)priority;(void)handle; runtime.task=task; runtime.task_context=context; return pdPASS;
}
static bool driver_clock(void *context) { (void)context; return runtime.trusted; }
static bool driver_read(void *context,const char *path,li_value_t *value) {
    (void)context;
    if (!strcmp(path,"light.power")) *value=(li_value_t){.type=LI_BOOLEAN,.boolean=runtime.power};
    else if (!strcmp(path,"light.brightness")) *value=(li_value_t){.type=LI_INTEGER,.integer=runtime.brightness}; else return false;
    return true;
}
static li_apply_result_t driver_write(void *context,const char *path,li_value_t value) {
#ifdef LI_ESP_RECOVERY_HOST
    (void)context; return recovery_apply(path,value);
#else
    (void)context; runtime.effects++;
    if (!li_credential_window_current(&runtime.adapter->credential_window,runtime.trusted)) runtime.effects_after++;
    if (!strcmp(path,"light.power")) runtime.power=value.boolean;
    else if (!strcmp(path,"light.brightness")) runtime.brightness=value.integer; else return LI_NOT_APPLIED;
    char effect[128]; int size=snprintf(effect,sizeof(effect),"{\"effects\":%u,\"effects_after_invalidation\":%u}\n",runtime.effects,runtime.effects_after);
    durable_file("effects.json",effect,(size_t)size); return LI_APPLIED;
#endif
}
#if !defined(LI_ESP_RECOVERY_HOST) && !defined(LI_ESP_INSTALL_HOST)
int main(int argc,char **argv) {
    if (argc!=4||(strcmp(argv[3],"expiry")&&strcmp(argv[3],"ca-expiry")&&strcmp(argv[3],"clock"))) return 5;
    runtime.directory=argv[1]; runtime.mode=argv[3]; runtime.trusted=true;
    file_path(runtime.ca_file,"ca.crt"); file_path(runtime.certificate_file,"device.crt"); file_path(runtime.key_file,"device.key");
    char *ca=read_text("ca.crt"), *certificate=read_text("device.crt"), *key=read_text("device.key");
    li_espidf_options_t options={.core={.space_id="space-demo",.device_id="device-lamp",.model_revision=LI_LAMP_REVISION,.firmware_version="0.2.0",.hardware_revision="host-fixture",
        .properties=LI_LAMP_PROPERTIES,.property_count=LI_LAMP_PROPERTY_COUNT,.observation_source="host-fixture"},
        .broker_host="127.0.0.1",.broker_port=(uint16_t)strtoul(argv[2],NULL,10),.ca_pem=ca,.certificate_pem=certificate,.private_key_pem=key,
        .trusted_clock=driver_clock,.read_property=driver_read,.write_property=driver_write};
    assert(options.broker_port); assert(mosquitto_lib_init()==MOSQ_ERR_SUCCESS);
    signal(SIGINT,on_signal); signal(SIGTERM,on_signal);
    li_error_t error=li_espidf_start(&options,&runtime.adapter);
    if (error!=LI_OK) { fprintf(stderr,"adapter start: %s\n",li_error_code(error)); return 6; }
    assert(runtime.task); if (!setjmp(finished)) runtime.task(runtime.task_context);
    runtime.finishing=true;
    bool ready=li_espidf_ready(runtime.adapter), locked=atomic_load(&runtime.adapter->credential_window.blocked);
    /* 恢复可信时钟不能解除同一实例的锁定。 */
    runtime.trusted=true; bool restored=credentials_current(runtime.adapter);
    unsigned generation=atomic_load(&runtime.adapter->generation); char qos=1;
    esp_mqtt_event_t late={.msg_id=runtime.adapter->subscription,.data=&qos,.data_len=1};
    mqtt_event(runtime.adapter,"MQTT",MQTT_EVENT_SUBSCRIBED,&late);
    mqtt_event(runtime.adapter,"MQTT",MQTT_EVENT_CONNECTED,&late);
    char late_topic[]="limeiot/v1/space-demo/device-lamp/down/command";
    late=(esp_mqtt_event_t){.topic=late_topic,.topic_len=(int)strlen(late_topic),.data="{}",.data_len=2,.total_data_len=2};
    mqtt_event(runtime.adapter,"MQTT",MQTT_EVENT_DATA,&late);
    bool late_rejected=atomic_load(&runtime.adapter->generation)==generation&&!atomic_load(&runtime.adapter->connected)&&!runtime.adapter->queue->size&&!runtime.adapter->incoming.payload;
    /* 独立核对失效凭据，避免仅因connected=false而让后置门禁检查通过。 */
    atomic_store(&runtime.adapter->connected,true); runtime.adapter->executing_generation=atomic_load(&runtime.adapter->generation);
    bool publish_rejected=!publish(runtime.adapter,"limeiot/v1/space-demo/device-lamp/up/snapshot","{}",2);
    atomic_store(&runtime.adapter->connected,true); runtime.adapter->executing_generation=atomic_load(&runtime.adapter->generation);
    bool driver_rejected=write_property(runtime.adapter,"light.power",(li_value_t){.type=LI_BOOLEAN,.boolean=false})==LI_NOT_APPLIED;
    atomic_store(&runtime.adapter->connected,true); runtime.adapter->executing_generation=atomic_load(&runtime.adapter->generation);
    bool ota_rejected=!ota_current(runtime.adapter);
    char report[2048]; int size=snprintf(report,sizeof(report),
        "{\"effects_before_invalidation\":%u,\"effects_after_invalidation\":%u,\"connects\":%u,\"reconnects\":%u,\"stops\":%u,\"fragments\":%u,\"receipt_commits\":%u,"
        "\"publishes_after_gate\":%u,\"reconnects_after_gate\":%u,\"ready\":%s,\"locked\":%s,\"trusted_clock_restored_current\":%s,\"gated\":%s,"
        "\"queued_before_gate\":%u,\"consumed_after_gate\":%u,\"stale_generation\":%u,\"late_events_rejected\":%s,\"publish_guard_rejected\":%s,\"driver_guard_rejected\":%s,\"ota_current_guard_rejected\":%s,"
        "\"production_adapter_worker\":true,\"esp_mqtt_runtime\":false,\"hardware\":false}\n",
        runtime.effects-runtime.effects_after,runtime.effects_after,runtime.connects,runtime.reconnects,runtime.stops,runtime.fragments,runtime.commits,
        runtime.publishes-runtime.publishes_at_gate,runtime.reconnects-runtime.reconnects_at_gate,ready?"true":"false",locked?"true":"false",restored?"true":"false",runtime.gated?"true":"false",
        runtime.queued_before_gate,runtime.consumed_after_gate,runtime.stale_generation,late_rejected?"true":"false",publish_rejected?"true":"false",driver_rejected?"true":"false",ota_rejected?"true":"false");
    assert(size>0&&size<(int)sizeof(report)); durable_file("runtime-result.json",report,(size_t)size);
    work_t queued; while (xQueueReceive(runtime.adapter->queue,&queued,0)==pdTRUE) free(queued.payload);
    reset_incoming(runtime.adapter); esp_mqtt_client_destroy(runtime.adapter->mqtt); vQueueDelete(runtime.adapter->queue);
    li_core_destroy(runtime.adapter->core); close_ota_log(runtime.adapter); nvs_close(runtime.adapter->journal); free(runtime.adapter);
    mosquitto_lib_cleanup(); OPENSSL_cleanse(key,strlen(key)); free(key); free(certificate); free(ca); return stopping?7:0;
}
#endif
