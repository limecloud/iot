#include "limeiot_sht3x.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #x); exit(1); } } while (0)
typedef struct { int64_t now, delay; unsigned writes, reads; unsigned fault; uint8_t packet[6]; } fixture_t;
static bool write_packet(void *context, const uint8_t *packet, size_t size) {
    fixture_t *f = context; f->writes++; CHECK(size == 2 && packet[0] == 0x24 && packet[1] == 0);
    return f->fault != 1;
}
static bool read_packet(void *context, uint8_t *packet, size_t size) {
    fixture_t *f = context; f->reads++; CHECK(size == 6); memcpy(packet, f->packet, size); return f->fault != 2;
}
static bool wait_packet(void *context, uint32_t milliseconds) {
    fixture_t *f = context; CHECK(milliseconds == 16); f->now += f->delay; return f->fault != 3;
}
static int64_t clock_ms(void *context) { return ((fixture_t *)context)->now; }
int main(void) {
    /* 数据手册CRC参考0xBEEF→0x92，已知25.00℃及50.00%RH与量程端点。 */
    const uint8_t packet[] = {0x66, 0x66, 0x93, 0x80, 0x00, 0xa2};
    const uint8_t reference[] = {0xbe, 0xef, 0x92, 0xbe, 0xef, 0x92};
    li_sht3x_sample_t sample;
    CHECK(li_sht3x_decode(reference, &sample));
    CHECK(li_sht3x_decode(packet, &sample)); CHECK(sample.temperature == 2500 && sample.humidity == 5000);
    const uint8_t low[] = {0, 0, 0x81, 0, 0, 0x81}, high[] = {0xff, 0xff, 0xac, 0xff, 0xff, 0xac};
    CHECK(li_sht3x_decode(low, &sample) && sample.temperature == -4500 && sample.humidity == 0);
    CHECK(li_sht3x_decode(high, &sample) && sample.temperature == 13000 && sample.humidity == 10000);
    for (unsigned bit = 0; bit < 48; bit++) {
        uint8_t damaged[6]; memcpy(damaged, packet, 6); damaged[bit/8] ^= (uint8_t)(1u << (bit%8));
        CHECK(!li_sht3x_decode(damaged, &sample)); CHECK(sample.temperature == 0 && sample.humidity == 0);
    }
    CHECK(!li_sht3x_decode(NULL, &sample)); CHECK(!li_sht3x_decode(packet, NULL));
    fixture_t f = {.now = 100, .delay = 16}; memcpy(f.packet, packet, 6);
    li_sht3x_ports_t ports = {&f, write_packet, read_packet, wait_packet, clock_ms}; li_sht3x_t sensor;
    CHECK(li_sht3x_init(&sensor, &ports)); CHECK(li_sht3x_read(&sensor, &sample)); CHECK(sample.sampled_mono_ms == 116);
    f.now = 10099; CHECK(li_sht3x_read(&sensor, &sample)); CHECK(sample.sampled_mono_ms == 116 && f.writes == 1);
    f.now = 10100; CHECK(li_sht3x_read(&sensor, &sample)); CHECK(sample.sampled_mono_ms == 10116 && f.writes == 2);
    for (unsigned fault = 1; fault <= 6; fault++) {
        f.now += 10000; f.fault = fault; f.delay = fault == 4 ? 1001 : fault == 5 ? 0 : 16;
        if (fault == 6) f.packet[5] ^= 1;
        CHECK(!li_sht3x_read(&sensor, &sample)); CHECK(sample.sampled_mono_ms == 0 && !sensor.valid);
        unsigned writes = f.writes; CHECK(!li_sht3x_read(&sensor, &sample)); CHECK(f.writes == writes);
        f.now += 10000; f.fault = 0; f.delay = 16; memcpy(f.packet, packet, 6);
        CHECK(li_sht3x_read(&sensor, &sample)); CHECK(sample.temperature == 2500);
    }
    f.now = sensor.last_attempt - 1; CHECK(!li_sht3x_read(&sensor, &sample));
    CHECK(!li_sht3x_read(NULL, &sample)); CHECK(!li_sht3x_read(&sensor, NULL));
    puts("{\"sht3x_checks\":4,\"single_bit_crc_rejections\":48,\"io_clock_failures\":7,\"hardware\":false}"); return 0;
}
