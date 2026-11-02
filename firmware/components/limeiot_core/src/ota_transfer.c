/* 传输、写入与实际回读有界执行；不选择启动分区，不自动重试。 */
#include "limeiot_ota_transfer.h"
#include "ota_internal.h"
#include <string.h>
typedef struct {
    const li_ota_transfer_guard_t *guard;
    int64_t started, last;
    const char *issue;
    li_error_t error;
} check_t;
static bool allowed(check_t *state) {
    int64_t now=state->guard->monotonic_ms(state->guard->context);
    if (now<0 || now<state->last) { state->issue="ota_transfer_clock_untrusted"; state->error=LI_CLOCK; return false; }
    state->last=now;
    if (now-state->started>=LI_OTA_TRANSFER_TIMEOUT_MS) { state->issue="ota_transfer_timeout"; state->error=LI_EXPIRED; return false; }
    if (!state->guard->authorize(state->guard->context)) { state->issue="ota_transfer_authorization_lost"; state->error=LI_SESSION; return false; }
    return true;
}
li_error_t li_ota_transfer_run(const li_ota_candidate_t *candidate, const li_ota_source_t *source, const li_ota_sink_t *sink,
                               const li_ota_hash_stream_t *hash, const li_ota_transfer_guard_t *guard,
                               li_ota_transfer_result_t *out, const char **issue) {
    if (out) memset(out,0,sizeof(*out));
    if (issue) *issue="invalid_ota_transfer";
    if (!candidate || !out || !source || !source->open || !source->read || !source->close || !sink || !sink->begin || !sink->write
        || !sink->finish || !sink->read || !sink->abort || !hash || !hash->begin || !hash->update || !hash->finish || !hash->abort
        || !guard || !guard->monotonic_ms || !guard->authorize || !candidate->size_bytes || candidate->size_bytes>UINT32_C(33554432)
        || !memchr(candidate->download_url,0,sizeof(candidate->download_url)) || strncmp(candidate->download_url,"https://",8)
        || !memchr(candidate->image_sha256,0,sizeof(candidate->image_sha256)) || !li_ota_digest_valid(candidate->image_sha256)) return LI_INVALID;
    int64_t started=guard->monotonic_ms(guard->context);
    check_t check={guard,started,started,"ota_transfer_clock_untrusted",LI_CLOCK};
    bool opened=false, begun=false, hashing=false, complete=false;
    li_error_t error=LI_CLOCK; const char *reason="ota_transfer_clock_untrusted"; uint8_t buffer[LI_OTA_TRANSFER_CHUNK], digest[32];
    if (started<0) goto finish;
#define CHECK() do { if (!allowed(&check)) { error=check.error; reason=check.issue; goto finish; } } while (0)
#define REQUIRE(test, result, message) do { if (!(test)) { error=(result); reason=(message); goto finish; } } while (0)
    CHECK(); opened=true; li_ota_http_response_t response={0};
    REQUIRE(source->open(source->context,candidate->download_url,&response),LI_TRANSPORT,"ota_http_unavailable"); CHECK();
    REQUIRE(response.status==200&&!response.redirected&&!response.encoded,LI_INVALID,"ota_http_response_rejected");
    REQUIRE(!response.has_length||response.content_length==candidate->size_bytes,LI_INVALID,"ota_http_length_mismatch");
    CHECK(); begun=true; REQUIRE(sink->begin(sink->context,candidate->size_bytes),LI_DRIVER,"ota_staging_unavailable"); CHECK();
    while (!complete) {
        size_t received=0; uint32_t remaining=candidate->size_bytes-out->bytes_written;
        size_t capacity=remaining<sizeof(buffer)?(size_t)remaining+1:sizeof(buffer);
        CHECK(); REQUIRE(source->read(source->context,buffer,capacity,&received,&complete),LI_TRANSPORT,"ota_http_read_failed"); CHECK();
        REQUIRE(received<=capacity,LI_TRANSPORT,"ota_http_read_invalid");
        out->bytes_received+=(uint32_t)received;
        REQUIRE(received<=remaining,LI_INVALID,"ota_image_too_long");
        REQUIRE(received||complete,LI_TRANSPORT,"ota_http_stalled");
        if (received) {
            CHECK(); REQUIRE(sink->write(sink->context,out->bytes_written,buffer,received),LI_DRIVER,"ota_staging_write_failed");
            out->bytes_written+=(uint32_t)received; CHECK();
        }
    }
    source->close(source->context); opened=false; CHECK();
    REQUIRE(out->bytes_written==candidate->size_bytes,LI_INVALID,"ota_image_truncated");
    REQUIRE(sink->finish(sink->context),LI_DRIVER,"ota_native_image_rejected"); CHECK();
    hashing=true; REQUIRE(hash->begin(hash->context),LI_DRIVER,"ota_hash_unavailable");
    for (uint32_t offset=0;offset<candidate->size_bytes;) {
        size_t length=candidate->size_bytes-offset; if (length>sizeof(buffer)) length=sizeof(buffer);
        CHECK(); REQUIRE(sink->read(sink->context,offset,buffer,length),LI_DRIVER,"ota_staging_read_failed"); CHECK();
        REQUIRE(hash->update(hash->context,buffer,length),LI_DRIVER,"ota_hash_failed"); CHECK();
        offset+=(uint32_t)length; out->bytes_verified=offset;
    }
    REQUIRE(hash->finish(hash->context,digest),LI_DRIVER,"ota_hash_failed"); hashing=false; CHECK();
    char computed[72]="sha256:";
    static const char hex[]="0123456789abcdef";
    for (size_t i=0;i<32;i++) { computed[7+2*i]=hex[digest[i]>>4]; computed[8+2*i]=hex[digest[i]&15]; }
    REQUIRE(!strcmp(computed,candidate->image_sha256),LI_INVALID,"ota_image_hash_mismatch");
    CHECK(); memcpy(out->image_sha256,computed,sizeof(computed)); out->image_verified=true;
    error=LI_OK; reason="ok";
finish:
    if (opened) source->close(source->context);
    if (hashing) hash->abort(hash->context);
    if (begun&&error!=LI_OK) sink->abort(sink->context);
    if (issue) *issue=reason;
    return error;
#undef CHECK
#undef REQUIRE
}
