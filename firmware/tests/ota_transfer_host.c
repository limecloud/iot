#include "ota_transfer_fixture.h"
static int64_t transfer_monotonic(void *context) {
    transfer_host_t *h=context; struct timespec now; if (clock_gettime(CLOCK_MONOTONIC,&now)) return -1;
    if (transfer_fault(h,"clock-negative")) return -1;
    int64_t value=(int64_t)now.tv_sec*1000+now.tv_nsec/1000000;
    if (h->reads&&transfer_fault(h,"clock-backwards")) value-=60000;
    if (h->reads&&transfer_fault(h,"timeout")) value+=30000;
    return value;
}
static bool transfer_authorize(void *context) {
    transfer_host_t *h=context; h->authorizations++;
    return !transfer_fault(h,"authorization")&&!(h->writes&&transfer_fault(h,"authorization-write"))&&!(h->verifies&&transfer_fault(h,"authorization-verify"));
}
int main(int argc, char **argv) {
    if (argc!=3) return 5; signal(SIGPIPE,SIG_IGN);
    FILE *file=fopen(argv[1],"rb"); if (!file) return 5;
    char raw[8192]; size_t length=fread(raw,1,sizeof(raw),file); fclose(file);
    cJSON *plan=cJSON_ParseWithLength(raw,length); if (!plan) return 5;
    transfer_host_t host={.plan=plan,.path=argv[2],.fault=transfer_text(plan,"fault"),.socket=-1,.file=-1};
    li_ota_candidate_t candidate={.size_bytes=(uint32_t)cJSON_GetNumberValue(cJSON_GetObjectItemCaseSensitive(plan,"size"))};
    const char *url=transfer_text(plan,"url"), *digest=transfer_text(plan,"sha256");
    if (!url||!digest||strlen(url)>=sizeof(candidate.download_url)||strlen(digest)>=sizeof(candidate.image_sha256)) { cJSON_Delete(plan); return 5; }
    strcpy(candidate.download_url,url); strcpy(candidate.image_sha256,digest);
    li_ota_source_t source={&host,open_http,read_http,close_http}; li_ota_sink_t sink={&host,begin_image,write_image,finish_image,read_image,abort_image};
    li_ota_hash_stream_t hash={&host,begin_hash,update_hash,finish_hash,abort_hash}; li_ota_transfer_guard_t guard={&host,transfer_monotonic,transfer_authorize};
    li_ota_transfer_result_t result; memset(&result,0xa5,sizeof(result)); const char *issue=NULL;
    li_error_t error=li_ota_transfer_run(&candidate,&source,&sink,&hash,&guard,&result,&issue);
    cJSON *output=cJSON_CreateObject();
    cJSON_AddNumberToObject(output,"code",error); cJSON_AddStringToObject(output,"issue",issue); cJSON_AddBoolToObject(output,"image_verified",result.image_verified);
    cJSON_AddStringToObject(output,"image_sha256",result.image_sha256); cJSON_AddNumberToObject(output,"bytes_received",result.bytes_received);
    cJSON_AddNumberToObject(output,"bytes_written",result.bytes_written); cJSON_AddNumberToObject(output,"bytes_verified",result.bytes_verified);
    cJSON_AddNumberToObject(output,"opens",host.opens); cJSON_AddNumberToObject(output,"reads",host.reads); cJSON_AddNumberToObject(output,"closes",host.closes);
    cJSON_AddNumberToObject(output,"begins",host.begins); cJSON_AddNumberToObject(output,"writes",host.writes); cJSON_AddNumberToObject(output,"finishes",host.finishes);
    cJSON_AddNumberToObject(output,"verifies",host.verifies); cJSON_AddNumberToObject(output,"aborts",host.aborts);
    char *encoded=cJSON_PrintUnformatted(output); if (encoded) puts(encoded); free(encoded); cJSON_Delete(output);
    if (host.file>=0) close(host.file);
    cJSON_Delete(plan); return 0;
}
