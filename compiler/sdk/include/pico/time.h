/*
 * pico/time.h — time API, compatible with the Raspberry Pi Pico SDK (pico_time)
 *
 * The clock is the simulator's virtual clock: it only moves when the program sleeps, busy-waits, or reads a pin or
 * the clock (each read costs 1 microsecond). absolute_time_t is the SDK's opaque struct; the helpers below work on it.
 * Alarms, repeating timers and the alarm pool are not provided.
 */

#ifndef PICO_TIME_H
#define PICO_TIME_H

#include "pico/types.h"

typedef struct {
    uint64_t _private_us_since_boot;
} absolute_time_t;

void     sleep_ms(uint32_t ms);
void     sleep_us(uint64_t us);
uint64_t time_us_64(void);
void     busy_wait_us(uint64_t us);

static inline uint32_t time_us_32(void) { return (uint32_t)time_us_64(); }
static inline void busy_wait_ms(uint32_t ms) { busy_wait_us((uint64_t)ms * 1000u); }

static inline absolute_time_t get_absolute_time(void) {
    absolute_time_t t;
    t._private_us_since_boot = time_us_64();
    return t;
}
static inline absolute_time_t from_us_since_boot(uint64_t us) {
    absolute_time_t t;
    t._private_us_since_boot = us;
    return t;
}
static inline uint64_t to_us_since_boot(absolute_time_t t) { return t._private_us_since_boot; }
static inline uint32_t to_ms_since_boot(absolute_time_t t) { return (uint32_t)(t._private_us_since_boot / 1000u); }

static inline absolute_time_t delayed_by_us(absolute_time_t t, uint64_t us) {
    return from_us_since_boot(t._private_us_since_boot + us);
}
static inline absolute_time_t delayed_by_ms(absolute_time_t t, uint32_t ms) {
    return delayed_by_us(t, (uint64_t)ms * 1000u);
}
static inline absolute_time_t make_timeout_time_us(uint64_t us) { return delayed_by_us(get_absolute_time(), us); }
static inline absolute_time_t make_timeout_time_ms(uint32_t ms) { return delayed_by_ms(get_absolute_time(), ms); }

static inline int64_t absolute_time_diff_us(absolute_time_t from, absolute_time_t to) {
    return (int64_t)(to._private_us_since_boot - from._private_us_since_boot);
}
static inline bool time_reached(absolute_time_t t) { return time_us_64() >= t._private_us_since_boot; }

static inline void sleep_until(absolute_time_t t) {
    uint64_t now = time_us_64();
    if (t._private_us_since_boot > now) sleep_us(t._private_us_since_boot - now);
}

#endif /* PICO_TIME_H */
