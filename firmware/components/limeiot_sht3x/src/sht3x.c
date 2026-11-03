#include "limeiot_sht3x.h"
#include <string.h>

static uint8_t crc(const uint8_t *data) {
    uint8_t value = 0xff;
    for (size_t i = 0; i < 2; i++) {
        value ^= data[i];
        for (unsigned bit = 0; bit < 8; bit++) value = (uint8_t)((value << 1) ^ ((value & 0x80) ? 0x31 : 0));
    }
    return value;
}
bool li_sht3x_decode(const uint8_t packet[6], li_sht3x_sample_t *sample) {
    if (!sample) return false;
    memset(sample, 0, sizeof(*sample));
    if (!packet || crc(packet) != packet[2] || crc(packet + 3) != packet[5]) return false;
    uint32_t temperature = ((uint32_t)packet[0] << 8) | packet[1];
    uint32_t humidity = ((uint32_t)packet[3] << 8) | packet[4];
    sample->temperature = -4500 + (int32_t)((17500 * temperature + 32767) / 65535);
    sample->humidity = (int32_t)((10000 * humidity + 32767) / 65535);
    return true;
}
bool li_sht3x_init(li_sht3x_t *sensor, const li_sht3x_ports_t *ports) {
    if (!sensor || !ports || !ports->write || !ports->read || !ports->wait_ms || !ports->monotonic_ms) return false;
    memset(sensor, 0, sizeof(*sensor)); sensor->ports = *ports; return true;
}
bool li_sht3x_read(li_sht3x_t *sensor, li_sht3x_sample_t *sample) {
    if (!sample) return false;
    memset(sample, 0, sizeof(*sample));
    if (!sensor || !sensor->ports.monotonic_ms) return false;
    const li_sht3x_ports_t *ports = &sensor->ports;
    int64_t now = ports->monotonic_ms(ports->context);
    if (now < 0 || (sensor->attempted && now < sensor->last_attempt)) { sensor->valid = false; return false; }
    if (sensor->attempted && now - sensor->last_attempt < 10000) {
        if (!sensor->valid) return false;
        *sample = sensor->sample; return true;
    }
    sensor->attempted = true; sensor->last_attempt = now; sensor->valid = false;
    const uint8_t command[] = {0x24, 0x00}; /* 高重复性，单次测量，不使用clock stretching。 */
    uint8_t packet[6]; li_sht3x_sample_t candidate;
    if (!ports->write(ports->context, command, sizeof(command)) || !ports->wait_ms(ports->context, 16)
        || !ports->read(ports->context, packet, sizeof(packet)) || !li_sht3x_decode(packet, &candidate)) return false;
    int64_t captured = ports->monotonic_ms(ports->context);
    if (captured < now || captured - now < 16 || captured - now > 1000) return false;
    candidate.sampled_mono_ms = captured; sensor->sample = candidate; sensor->valid = true;
    *sample = candidate; return true;
}
