#ifndef LI_INTERNAL_H
#define LI_INTERNAL_H
#include "limeiot.h"

#define LI_REVISION_SIZE 72
#define LI_TOPIC_SIZE 256
#define LI_STORAGE_BYTES 1024
#define LI_MAX_SEQUENCE UINT64_C(9007199254740991)

typedef enum { LI_DOWN_WELCOME, LI_DOWN_COMMAND } li_down_kind_t;
typedef struct {
    li_down_kind_t kind;
    char device[LI_ID_SIZE], revision[LI_REVISION_SIZE], session[LI_ID_SIZE], message[LI_ID_SIZE];
    char challenge[LI_ID_SIZE], command[LI_ID_SIZE], path[LI_PATH_SIZE];
    int64_t time_ms, issued_ms, expires_ms;
    li_value_t value;
    char *canonical;
} li_down_t;
typedef enum { LI_INTENT = 1, LI_CONFIRMED = 2, LI_FAILED = 3 } li_receipt_stage_t;
typedef struct {
    char command[LI_ID_SIZE], fingerprint[65], session[LI_ID_SIZE], path[LI_PATH_SIZE];
    char error[32];
    int64_t expires_ms, observed_ms;
    li_value_t value;
    li_receipt_stage_t stage;
} li_receipt_t;
struct li_core {
    li_config_t config;
    li_ports_t ports;
    char boot[LI_ID_SIZE], challenge[LI_ID_SIZE], session[LI_ID_SIZE];
    uint64_t seq, snapshot_revision;
    bool connected, ready;
    int64_t anchor_unix, anchor_mono, last_snapshot, last_hello;
    li_receipt_t receipts[LI_RECEIPT_SLOTS];
    bool occupied[LI_RECEIPT_SLOTS];
    bool unreported[LI_RECEIPT_SLOTS];
};

bool li_identifier(const char *);
bool li_value_valid(const li_property_t *, li_value_t);
int64_t li_now(li_core_t *);
li_error_t li_codec_decode(const char *, size_t, li_down_t *);
void li_codec_down_free(li_down_t *);
char *li_codec_hello(li_core_t *);
char *li_codec_snapshot(li_core_t *, int64_t, const li_value_t *);
char *li_codec_event(li_core_t *, int64_t, const li_event_t *, int64_t);
char *li_codec_result(li_core_t *, const li_receipt_t *);
char *li_codec_receipt_encode(const li_receipt_t *);
bool li_codec_receipt_decode(const char *, size_t, li_receipt_t *);
void li_codec_free(char *);
bool li_new_id(li_core_t *, char[LI_ID_SIZE]);
#endif
