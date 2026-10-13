/*
 * pico/bootrom.h — Boot ROM API for Emscripten compilation
 */

#ifndef PICO_BOOTROM_H
#define PICO_BOOTROM_H

#include "pico/types.h"

void reset_usb_boot(uint32_t usb_activity_gpio_pin_mask, uint32_t disable_interface_mask);

#endif /* PICO_BOOTROM_H */
