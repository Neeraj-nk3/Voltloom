/*
 * pwm.c — C Bridge for PWM operations
 */

#include "hardware/pwm.h"

extern int  js_pwm_gpio_to_slice(int gpio);
extern void js_pwm_set_wrap(int slice, int wrap);
extern void js_pwm_set_level(int slice, int channel, int level);
extern void js_pwm_set_enabled(int slice, int enabled);
extern void js_pwm_set_clkdiv(int slice, double div);

uint pwm_gpio_to_slice_num(uint gpio) {
    return (uint)js_pwm_gpio_to_slice((int)gpio);
}

uint pwm_gpio_to_channel(uint gpio) {
    return gpio % 2;
}

void pwm_set_wrap(uint slice_num, uint16_t wrap) {
    js_pwm_set_wrap((int)slice_num, (int)wrap);
}

void pwm_set_chan_level(uint slice_num, uint chan, uint16_t level) {
    js_pwm_set_level((int)slice_num, (int)chan, (int)level);
}

void pwm_set_both_levels(uint slice_num, uint16_t level_a, uint16_t level_b) {
    js_pwm_set_level((int)slice_num, 0, (int)level_a);
    js_pwm_set_level((int)slice_num, 1, (int)level_b);
}

void pwm_set_gpio_level(uint gpio, uint16_t level) {
    int slice = js_pwm_gpio_to_slice((int)gpio);
    int channel = (int)(gpio % 2);
    js_pwm_set_level(slice, channel, (int)level);
}

void pwm_set_enabled(uint slice_num, bool enabled) {
    js_pwm_set_enabled((int)slice_num, enabled ? 1 : 0);
}

void pwm_set_clkdiv(uint slice_num, float divider) {
    js_pwm_set_clkdiv((int)slice_num, (double)divider);
}

void pwm_set_clkdiv_int_frac(uint slice_num, uint8_t integer, uint8_t fract) {
    js_pwm_set_clkdiv((int)slice_num, (double)integer + (double)(fract & 0xF) / 16.0);
}

pwm_config pwm_get_default_config(void) {
    pwm_config c;
    c.div = 1.0f;
    c.top = 0xffff;
    return c;
}

void pwm_config_set_clkdiv(pwm_config *c, float div) {
    c->div = div;
}

void pwm_config_set_clkdiv_int_frac(pwm_config *c, uint8_t integer, uint8_t fract) {
    c->div = (float)integer + (float)(fract & 0xF) / 16.0f;
}

void pwm_config_set_wrap(pwm_config *c, uint16_t wrap) {
    c->top = wrap;
}

void pwm_init(uint slice_num, pwm_config *c, bool start) {
    js_pwm_set_clkdiv((int)slice_num, (double)c->div);
    js_pwm_set_wrap((int)slice_num, (int)c->top);
    js_pwm_set_enabled((int)slice_num, start ? 1 : 0);
}
