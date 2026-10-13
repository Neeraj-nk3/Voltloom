#include <stdio.h>
#include "pico/stdlib.h"
#include "hardware/gpio.h"
#include "hardware/pwm.h"

#define LED_PIN 15

int main() {
    stdio_init_all();

    gpio_set_function(LED_PIN, GPIO_FUNC_PWM);
    uint slice = pwm_gpio_to_slice_num(LED_PIN);
    pwm_set_wrap(slice, 999);
    pwm_set_enabled(slice, true);

    for (int step = 0; step <= 8; step++) {
        uint level = step * 125;
        if (level > 999) level = 999;      // the counter wraps at 999, so 999 is the highest useful level
        pwm_set_gpio_level(LED_PIN, level);
        printf("level %u\n", level);
        sleep_ms(250);
    }

    printf("done\n");
    return 0;
}
