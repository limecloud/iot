/* 由 firmware/tools/generate-bindings.py 生成，请修改 contracts/models 中的事实源。 */
#ifndef LI_LAMP_BINDINGS_H
#define LI_LAMP_BINDINGS_H
#include "limeiot.h"
#define LI_LAMP_REVISION "sha256:aaf9fc9ba87187643ab777cda43658e09603fc1c0e51dc6ec1acde160d4aecfc"
static const li_property_t LI_LAMP_PROPERTIES[] = {
    {"light.power", LI_BOOLEAN, true, INT64_C(0), INT64_C(0)},
    {"light.brightness", LI_INTEGER, true, INT64_C(0), INT64_C(100)},
};
#define LI_LAMP_PROPERTY_COUNT 2
#define LI_LAMP_EVENT_COUNT 0
#endif
