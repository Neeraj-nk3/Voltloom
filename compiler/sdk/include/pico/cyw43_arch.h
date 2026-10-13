/*
 * pico/cyw43_arch.h — Wi-Fi API for Emscripten compilation
 */

#ifndef PICO_CYW43_ARCH_H
#define PICO_CYW43_ARCH_H

#include "pico/types.h"

int  cyw43_arch_init(void);
void cyw43_arch_deinit(void);
void cyw43_arch_enable_sta_mode(void);
int  cyw43_arch_wifi_connect_timeout_ms(const char *ssid, const char *pw, uint32_t auth, uint32_t timeout_ms);
void cyw43_arch_gpio_put(int wl_gpio, bool value);

#define CYW43_AUTH_WPA2_AES_PSK  0x00400004
#define CYW43_AUTH_OPEN          0x00000000
#define CYW43_WL_GPIO_LED_PIN    0

#endif /* PICO_CYW43_ARCH_H */
