/*
 * cyw43_arch.c — C Bridge for Wi-Fi operations
 */

#include "pico/cyw43_arch.h"

extern int  js_wifi_init(void);
extern void js_wifi_deinit(void);
extern void js_wifi_enable_sta(void);
extern int  js_wifi_connect(const char *ssid, const char *pw, int timeout);
extern void js_wifi_set_led(int gpio, int value);

int cyw43_arch_init(void) {
    return js_wifi_init();
}

void cyw43_arch_deinit(void) {
    js_wifi_deinit();
}

void cyw43_arch_enable_sta_mode(void) {
    js_wifi_enable_sta();
}

int cyw43_arch_wifi_connect_timeout_ms(const char *ssid, const char *pw, uint32_t auth, uint32_t timeout_ms) {
    return js_wifi_connect(ssid, pw, (int)timeout_ms);
}

void cyw43_arch_gpio_put(int wl_gpio, bool value) {
    js_wifi_set_led(wl_gpio, value ? 1 : 0);
}
