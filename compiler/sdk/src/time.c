/*
 * time.c — C Bridge for Timing operations
 *
 * Programs run on a program-owned virtual clock (src/clock/virtual-clock.js in the worker). A sleep is a plain BLOCKING
 * call into JavaScript: it advances the clock by exactly the requested time and, in real-time mode, waits
 * until the wall clock catches up. There is no Asyncify: the program never yields, and Stop is
 * Worker.terminate(), which also ends a worker that is blocked inside a sleep.
 */

#include "pico/time.h"

extern void js_sleep_us(double us);
extern double js_time_us_64(void);

void sleep_ms(uint32_t ms) {
    js_sleep_us((double)ms * 1000.0);
}

void sleep_us(uint64_t us) {
    js_sleep_us((double)us);
}

uint64_t time_us_64(void) {
    return (uint64_t)js_time_us_64();
}

void busy_wait_us(uint64_t us) {
    /* Busy-waiting on a virtual clock is the same as sleeping: the clock only moves when the program says so. */
    js_sleep_us((double)us);
}
