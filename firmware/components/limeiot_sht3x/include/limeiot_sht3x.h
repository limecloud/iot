#ifndef LIMEIOT_SHT3X_H
#define LIMEIOT_SHT3X_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct { int32_t temperature, humidity; int64_t sampled_mono_ms; } li_sht3x_sample_t;
typedef struct {
    void *context;
    bool (*write)(void *, const uint8_t *, size_t);
    bool (*read)(void *, uint8_t *, size_t);
    bool (*wait_ms)(void *, uint32_t);
    int64_t (*monotonic_ms)(void *);
} li_sht3x_ports_t;
typedef struct {
    li_sht3x_ports_t ports;
    li_sht3x_sample_t sample;
    int64_t last_attempt;
    bool attempted, valid;
} li_sht3x_t;

/* 纯C驱动；I2C、延时和时钟由端口隔离。温度/湿度分别为摄氏度/%RH的100倍整数。 */
bool li_sht3x_init(li_sht3x_t *, const li_sht3x_ports_t *);
bool li_sht3x_decode(const uint8_t packet[6], li_sht3x_sample_t *);
/* 同一设备任务串行调用，10秒采样；缓存保留原时刻。CRC/IO/时钟失败不返回旧样本。
 * 每次总预算1秒，端口须有独立有界超时；没有后台重试或自动复位/加热。 */
bool li_sht3x_read(li_sht3x_t *, li_sht3x_sample_t *);
#endif
