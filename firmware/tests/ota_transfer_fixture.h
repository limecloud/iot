#ifndef LI_OTA_TRANSFER_FIXTURE_H
#define LI_OTA_TRANSFER_FIXTURE_H
/* 仅宿主测试：回环HTTPS、临时备用文件及OpenSSL流式摘要。 */
#include "limeiot_ota_transfer.h"
#include "cJSON.h"
#include <openssl/ssl.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>
typedef struct {
    const cJSON *plan;
    void *owner;
    const char *path, *fault;
    SSL_CTX *tls; SSL *ssl; EVP_MD_CTX *hash;
    int socket, file;
    unsigned opens, reads, closes, begins, writes, finishes, verifies, aborts, authorizations;
} transfer_host_t;
static const char *transfer_text(const cJSON *root, const char *key) { return cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(root,key)); }
static bool transfer_fault(transfer_host_t *h, const char *name) { return h->fault&&!strcmp(h->fault,name); }
static bool open_http(void *context, const char *url, li_ota_http_response_t *response) {
    transfer_host_t *h=context; h->opens++; char host[256], path[1025], request[1400]; unsigned port=0;
    if (sscanf(url,"https://%255[^:/]:%u%1024s",host,&port,path)!=3 || !port || port>65535
        || (strcmp(host,"localhost")&&strcmp(host,"127.0.0.1")) || transfer_fault(h,"open")) return false;
    h->tls=SSL_CTX_new(TLS_client_method());
    if (!h->tls||SSL_CTX_load_verify_locations(h->tls,transfer_text(h->plan,"ca"),NULL)!=1) return false;
    SSL_CTX_set_verify(h->tls,SSL_VERIFY_PEER,NULL);
    h->socket=socket(AF_INET,SOCK_STREAM,0); if (h->socket<0) return false;
    struct timeval timeout={.tv_sec=1};
    (void)setsockopt(h->socket,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));
    (void)setsockopt(h->socket,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout));
    struct sockaddr_in address={.sin_family=AF_INET,.sin_port=htons((uint16_t)port),.sin_addr={htonl(INADDR_LOOPBACK)}};
    if (connect(h->socket,(struct sockaddr *)&address,sizeof(address))) return false;
    h->ssl=SSL_new(h->tls); if (!h->ssl||SSL_set_fd(h->ssl,h->socket)!=1) return false;
    if (!strcmp(host,"127.0.0.1")) { if (X509_VERIFY_PARAM_set1_ip_asc(SSL_get0_param(h->ssl),host)!=1) return false; }
    else if (X509_VERIFY_PARAM_set1_host(SSL_get0_param(h->ssl),host,0)!=1) return false;
    if (SSL_set_tlsext_host_name(h->ssl,host)!=1||SSL_connect(h->ssl)!=1) return false;
    int size=snprintf(request,sizeof(request),"GET %s HTTP/1.0\r\nHost: %s:%u\r\nConnection: close\r\nAccept-Encoding: identity\r\n\r\n",path,host,port);
    if (size<=0||(size_t)size>=sizeof(request)||SSL_write(h->ssl,request,size)!=size) return false;
    char headers[8192]; size_t used=0;
    while (used<sizeof(headers)-1) {
        if (SSL_read(h->ssl,headers+used,1)!=1) return false;
        used++; if (used>=4&&!memcmp(headers+used-4,"\r\n\r\n",4)) break;
    }
    if (used==sizeof(headers)-1) return false;
    headers[used]=0; char *save=NULL, *line=strtok_r(headers,"\r\n",&save); unsigned lengths=0;
    if (!line||sscanf(line,"HTTP/%*s %u",&response->status)!=1) return false;
    while ((line=strtok_r(NULL,"\r\n",&save))) {
        char *colon=strchr(line,':'); if (!colon) return false; *colon++=0; while (*colon==' ') colon++;
        if (!strcasecmp(line,"Content-Length")) {
            if (++lengths!=1||!*colon) return false;
            uint64_t length=0; for (const char *p=colon;*p;p++) { if (*p<'0'||*p>'9') return false; length=length*10+(unsigned)(*p-'0'); if (length>UINT32_MAX) return false; }
            response->has_length=true; response->content_length=(uint32_t)length;
        } else if (!strcasecmp(line,"Content-Encoding")&&strcasecmp(colon,"identity")) response->encoded=true;
        else if (!strcasecmp(line,"Transfer-Encoding")) return false;
    }
    response->redirected=response->status>=300&&response->status<400; return true;
}
static bool read_http(void *context, uint8_t *data, size_t capacity, size_t *received, bool *complete) {
    transfer_host_t *h=context; h->reads++;
    if (transfer_fault(h,"read")) return false;
    if (transfer_fault(h,"stalled")) { *received=0; *complete=false; return true; }
    if (transfer_fault(h,"oversized-read")) { *received=capacity+1; *complete=false; return true; }
    int count=SSL_read(h->ssl,data,(int)capacity);
    if (count>0) { *received=(size_t)count; *complete=false; return true; }
    *received=0; *complete=SSL_get_error(h->ssl,count)==SSL_ERROR_ZERO_RETURN; return *complete;
}
static void close_http(void *context) {
    transfer_host_t *h=context; h->closes++; SSL_free(h->ssl); h->ssl=NULL; SSL_CTX_free(h->tls); h->tls=NULL;
    if (h->socket>=0) { close(h->socket); h->socket=-1; }
}
static bool begin_image(void *context, uint32_t size) {
    (void)size; transfer_host_t *h=context; h->begins++; if (transfer_fault(h,"begin")) return false;
    h->file=open(h->path,O_RDWR|O_CREAT|O_EXCL,0600); return h->file>=0;
}
static bool write_image(void *context, uint32_t offset, const uint8_t *data, size_t length) {
    transfer_host_t *h=context; h->writes++; if (transfer_fault(h,"write")) return false;
    if (pwrite(h->file,data,length,(off_t)offset)!=(ssize_t)length) return false;
    if (transfer_fault(h,"corrupt-write")) { uint8_t byte=data[0]^1; return pwrite(h->file,&byte,1,(off_t)offset)==1; } return true;
}
static bool finish_image(void *context) { transfer_host_t *h=context; h->finishes++; return !transfer_fault(h,"finish")&&fsync(h->file)==0; }
static bool read_image(void *context, uint32_t offset, uint8_t *data, size_t length) {
    transfer_host_t *h=context; h->verifies++; return !transfer_fault(h,"verify")&&pread(h->file,data,length,(off_t)offset)==(ssize_t)length;
}
static void abort_image(void *context) { transfer_host_t *h=context; h->aborts++; }
static bool begin_hash(void *context) {
    transfer_host_t *h=context; h->hash=EVP_MD_CTX_new(); return !transfer_fault(h,"hash-begin")&&h->hash&&EVP_DigestInit_ex(h->hash,EVP_sha256(),NULL)==1;
}
static bool update_hash(void *context, const uint8_t *data, size_t length) { transfer_host_t *h=context; return !transfer_fault(h,"hash-update")&&EVP_DigestUpdate(h->hash,data,length)==1; }
static bool finish_hash(void *context, uint8_t digest[32]) {
    transfer_host_t *h=context; unsigned size=0; bool ok=!transfer_fault(h,"hash-finish")&&EVP_DigestFinal_ex(h->hash,digest,&size)==1&&size==32;
    EVP_MD_CTX_free(h->hash); h->hash=NULL; return ok;
}
static void abort_hash(void *context) { transfer_host_t *h=context; EVP_MD_CTX_free(h->hash); h->hash=NULL; }

#endif
