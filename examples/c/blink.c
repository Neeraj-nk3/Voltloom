/**
 * blink.c — Test C Program for Voltloom
 *
 * This is a simple LED blink program that tests:
 *   - stdio_init_all() — serial initialization
 *   - printf()         — serial output
 *   - gpio_init()      — GPIO initialization
 *   - gpio_set_dir()   — GPIO direction setting
 *   - gpio_put()       — GPIO output
 *   - sleep_ms()       — timing (virtual clock)
 *
 * Expected behavior:
 *   - Serial Monitor shows "LED ON" / "LED OFF" alternating
 *   - LED on GP15 blinks with 500ms interval
 */

#include "pico/stdlib.h"
#include "hardware/gpio.h"

int main() {
    stdio_init_all();
    printf("=== Voltloom — C Blink Test ===\n");

    gpio_init(15);
    gpio_set_dir(15, GPIO_OUT);

    int count = 0;
    while (1) {
        gpio_put(15, 1);
        printf("[%d] LED ON\n", count);
        sleep_ms(500);

        gpio_put(15, 0);
        printf("[%d] LED OFF\n", count);
        sleep_ms(500);

        count++;
    }

    return 0;
}
