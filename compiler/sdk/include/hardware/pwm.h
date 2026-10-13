/*
 * hardware/pwm.h — PWM API, compatible with the Raspberry Pi Pico SDK (hardware_pwm)
 *
 * Frequency = 125 MHz / (clkdiv * (wrap + 1)); duty = level / (wrap + 1). pwm_config is the SDK's configuration
 * object (its fields are private there too). Phase-correct mode, input modes, counters and PWM interrupts are
 * not provided.
 */

#ifndef HARDWARE_PWM_H
#define HARDWARE_PWM_H

#include "pico/types.h"

typedef struct {
    float div;       /* clock divider, 1.0 .. 255.9375 */
    uint16_t top;    /* counter wrap value */
} pwm_config;

uint pwm_gpio_to_slice_num(uint gpio);
uint pwm_gpio_to_channel(uint gpio);

void pwm_set_wrap(uint slice_num, uint16_t wrap);
void pwm_set_chan_level(uint slice_num, uint chan, uint16_t level);
void pwm_set_both_levels(uint slice_num, uint16_t level_a, uint16_t level_b);
void pwm_set_gpio_level(uint gpio, uint16_t level);
void pwm_set_enabled(uint slice_num, bool enabled);
void pwm_set_clkdiv(uint slice_num, float divider);
void pwm_set_clkdiv_int_frac(uint slice_num, uint8_t integer, uint8_t fract);

pwm_config pwm_get_default_config(void);
void pwm_config_set_clkdiv(pwm_config *c, float div);
void pwm_config_set_clkdiv_int_frac(pwm_config *c, uint8_t integer, uint8_t fract);
void pwm_config_set_wrap(pwm_config *c, uint16_t wrap);
void pwm_init(uint slice_num, pwm_config *c, bool start);

/* gpio_set_function(gpio, GPIO_FUNC_PWM) is declared in hardware/gpio.h */

#endif /* HARDWARE_PWM_H */
