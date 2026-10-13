/*
 * hardware/watchdog.h — Watchdog API, compatible with the Raspberry Pi Pico SDK (hardware_watchdog)
 *
 * The watchdog runs on the program's virtual clock: if it is not updated within the timeout, the board resets at
 * exactly that virtual time and the program starts again from main(). Timeouts above 8388 ms are clamped.
 * watchdog_enable_caused_reboot() reports the same thing as watchdog_caused_reboot() here.
 */

#ifndef HARDWARE_WATCHDOG_H
#define HARDWARE_WATCHDOG_H

#include "pico/types.h"

void watchdog_reboot(uint32_t pc, uint32_t sp, uint32_t delay_ms);
void watchdog_enable(uint32_t delay_ms, bool pause_on_debug);
void watchdog_update(void);
bool watchdog_caused_reboot(void);
bool watchdog_enable_caused_reboot(void);

#endif /* HARDWARE_WATCHDOG_H */
