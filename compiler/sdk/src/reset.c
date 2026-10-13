/*
 * reset.c — C Bridge for Reset and Watchdog operations
 */

#include "pico/bootrom.h"
#include "hardware/watchdog.h"

extern void js_reset(int type);
extern void js_watchdog_enable(int delay_ms);
extern void js_watchdog_update(void);
extern void js_watchdog_reboot(int delay_ms);
extern int  js_watchdog_caused_reboot(void);

void reset_usb_boot(uint32_t usb_activity_gpio_pin_mask, uint32_t disable_interface_mask) {
    (void)usb_activity_gpio_pin_mask;
    (void)disable_interface_mask;
    js_reset(0); /* RESET_SOFT */
}

void watchdog_reboot(uint32_t pc, uint32_t sp, uint32_t delay_ms) {
    (void)pc;
    (void)sp;
    js_watchdog_reboot((int)delay_ms);
}

void watchdog_enable(uint32_t delay_ms, bool pause_on_debug) {
    (void)pause_on_debug;
    js_watchdog_enable((int)delay_ms);
}

void watchdog_update(void) {
    js_watchdog_update();
}

bool watchdog_caused_reboot(void) {
    return js_watchdog_caused_reboot() ? true : false;
}

bool watchdog_enable_caused_reboot(void) {
    return js_watchdog_caused_reboot() ? true : false;
}
