/* 由 firmware/tools/generate-bindings.py 生成，请修改 contracts/models 中的事实源。 */
#ifndef LI_BUTTON_BINDINGS_H
#define LI_BUTTON_BINDINGS_H
#include "limeiot.h"
#define LI_BUTTON_REVISION "sha256:c557e81af48798cd354c4a3558e822aed3d732f78ecdfb481d46883d13a7366d"
static const li_event_t LI_BUTTON_EVENTS[] = {
    {"button.pressed", "count", INT64_C(1), INT64_C(3)},
};
#define LI_BUTTON_PROPERTY_COUNT 0
#define LI_BUTTON_EVENT_COUNT 1
#endif
