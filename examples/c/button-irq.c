#include <stdio.h>
#include "pico/stdlib.h"
#include "hardware/gpio.h"

#define LED_PIN 15
#define BUTTON_PIN 0

static volatile int presses = 0;

void on_button(uint gpio, uint32_t events) {
    presses++;
    gpio_put(LED_PIN, !gpio_get_out_level(LED_PIN));
    printf("press %d\n", presses);
}

int main() {
    stdio_init_all();

    gpio_init(LED_PIN);
    gpio_set_dir(LED_PIN, GPIO_OUT);

    gpio_init(BUTTON_PIN);
    gpio_set_dir(BUTTON_PIN, GPIO_IN);
    gpio_pull_up(BUTTON_PIN);        // the button connects the pin to GND

    gpio_set_irq_enabled_with_callback(BUTTON_PIN, GPIO_IRQ_EDGE_FALL, true, &on_button);

    while (true) {
        sleep_ms(100);
    }
}
