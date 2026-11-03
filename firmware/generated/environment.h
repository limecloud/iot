/* 由 firmware/tools/generate-bindings.py 生成，请修改 contracts/models 中的事实源。 */
#ifndef LI_ENVIRONMENT_BINDINGS_H
#define LI_ENVIRONMENT_BINDINGS_H
#include "limeiot.h"
#define LI_ENVIRONMENT_REVISION "sha256:2c8f8412b8ca513286c6975f5b887166dbb1b364ee800b74e528e279fa6c3348"
static const li_property_t LI_ENVIRONMENT_PROPERTIES[] = {
    {"environment.temperature", LI_INTEGER, false, INT64_C(-4500), INT64_C(13000)},
    {"environment.humidity", LI_INTEGER, false, INT64_C(0), INT64_C(10000)},
};
#define LI_ENVIRONMENT_PROPERTY_COUNT 2
#define LI_ENVIRONMENT_EVENT_COUNT 0
#endif
