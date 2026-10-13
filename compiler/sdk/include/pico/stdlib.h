/*
 * pico/stdlib.h — Master include for Pico SDK
 *
 * On real hardware, this pulls in GPIO, I/O, and timing.
 * For the simulator, it provides the same convenience:
 * include this one file and get all core SDK functions.
 */

#ifndef PICO_STDLIB_H
#define PICO_STDLIB_H

#include "pico/types.h"
#include "pico/stdio.h"
#include "pico/time.h"
#include "hardware/gpio.h"

/* A busy-wait body. Reading the clock is what lets virtual time (and so interrupts and the watchdog) advance. */
static inline void tight_loop_contents(void) { (void)time_us_64(); }

#endif /* PICO_STDLIB_H */
