/*
 * gpio.c — C Bridge for GPIO operations
 *
 * Implements Pico SDK GPIO functions by calling extern JS functions.
 * Emscripten resolves these externs via the js-library.js file.
 *
 * Interrupts: the SDK has ONE global callback. JavaScript decides when an interrupt fires (at the virtual time of
 * the edge, see src/clock/virtual-clock.js) and calls sim_irq_dispatch(), exported from this module, which runs the callback.
 */

#include "hardware/gpio.h"

/* Extern JS functions (resolved by Emscripten js-library.js) */
extern void js_gpio_init(int pin);
extern void js_gpio_set_dir(int pin, int dir);
extern void js_gpio_put(int pin, int value);
extern int  js_gpio_get(int pin);
extern void js_gpio_pull_up(int pin);
extern void js_gpio_pull_down(int pin);
extern void js_gpio_disable_pulls(int pin);
extern void js_gpio_set_irq(int pin, int mask, int enabled);
extern void js_gpio_set_function(int pin, int fn);
extern int  js_gpio_get_function(int pin);
extern int  js_gpio_get_dir(int pin);
extern int  js_gpio_get_pull(int pin);
extern int  js_gpio_get_out(int pin);

#define NUM_GPIO 30

static gpio_irq_callback_t irq_callback = 0;

void gpio_init(uint gpio) {
    js_gpio_init((int)gpio);
}

void gpio_set_dir(uint gpio, bool out) {
    js_gpio_set_dir((int)gpio, out ? 1 : 0);
}

void gpio_put(uint gpio, bool value) {
    js_gpio_put((int)gpio, value ? 1 : 0);
}

bool gpio_get(uint gpio) {
    return js_gpio_get((int)gpio) ? true : false;
}

void gpio_pull_up(uint gpio) {
    js_gpio_pull_up((int)gpio);
}

void gpio_pull_down(uint gpio) {
    js_gpio_pull_down((int)gpio);
}

void gpio_disable_pulls(uint gpio) {
    js_gpio_disable_pulls((int)gpio);
}

void gpio_set_function(uint gpio, enum gpio_function fn) {
    js_gpio_set_function((int)gpio, (int)fn);
}

void gpio_set_pulls(uint gpio, bool up, bool down) {
    if (up && !down) js_gpio_pull_up((int)gpio);
    else if (down && !up) js_gpio_pull_down((int)gpio);
    else js_gpio_disable_pulls((int)gpio);
}

bool gpio_is_pulled_up(uint gpio) {
    return js_gpio_get_pull((int)gpio) == 1;
}

bool gpio_is_pulled_down(uint gpio) {
    return js_gpio_get_pull((int)gpio) == 2;
}

enum gpio_function gpio_get_function(uint gpio) {
    return (enum gpio_function)js_gpio_get_function((int)gpio);
}

uint gpio_get_dir(uint gpio) {
    return (uint)js_gpio_get_dir((int)gpio);
}

bool gpio_is_dir_out(uint gpio) {
    return js_gpio_get_dir((int)gpio) == 1;
}

bool gpio_get_out_level(uint gpio) {
    return js_gpio_get_out((int)gpio) ? true : false;
}

uint32_t gpio_get_all(void) {
    uint32_t all = 0;
    for (uint i = 0; i < NUM_GPIO; i++) {
        if (js_gpio_get((int)i)) all |= (1u << i);
    }
    return all;
}

void gpio_set_mask(uint32_t mask) {
    for (uint i = 0; i < NUM_GPIO; i++) if (mask & (1u << i)) js_gpio_put((int)i, 1);
}

void gpio_clr_mask(uint32_t mask) {
    for (uint i = 0; i < NUM_GPIO; i++) if (mask & (1u << i)) js_gpio_put((int)i, 0);
}

void gpio_xor_mask(uint32_t mask) {
    for (uint i = 0; i < NUM_GPIO; i++) if (mask & (1u << i)) js_gpio_put((int)i, js_gpio_get_out((int)i) ? 0 : 1);
}

void gpio_put_masked(uint32_t mask, uint32_t value) {
    for (uint i = 0; i < NUM_GPIO; i++) if (mask & (1u << i)) js_gpio_put((int)i, (value >> i) & 1u);
}

void gpio_put_all(uint32_t value) {
    gpio_put_masked((1u << NUM_GPIO) - 1u, value);
}

void gpio_init_mask(uint32_t gpio_mask) {
    for (uint i = 0; i < NUM_GPIO; i++) if (gpio_mask & (1u << i)) js_gpio_init((int)i);
}

void gpio_set_dir_masked(uint32_t mask, uint32_t value) {
    for (uint i = 0; i < NUM_GPIO; i++) if (mask & (1u << i)) js_gpio_set_dir((int)i, (value >> i) & 1u);
}

void gpio_set_dir_out_masked(uint32_t mask) {
    gpio_set_dir_masked(mask, 0xffffffffu);
}

void gpio_set_dir_in_masked(uint32_t mask) {
    gpio_set_dir_masked(mask, 0u);
}

void gpio_set_dir_all_bits(uint32_t values) {
    gpio_set_dir_masked((1u << NUM_GPIO) - 1u, values);
}

void gpio_set_irq_callback(gpio_irq_callback_t callback) {
    irq_callback = callback;
}

void gpio_set_irq_enabled(uint gpio, uint32_t event_mask, bool enabled) {
    js_gpio_set_irq((int)gpio, (int)event_mask, enabled ? 1 : 0);
}

void gpio_set_irq_enabled_with_callback(uint gpio, uint32_t event_mask, bool enabled, gpio_irq_callback_t callback) {
    irq_callback = callback;
    js_gpio_set_irq((int)gpio, (int)event_mask, enabled ? 1 : 0);
}

void gpio_acknowledge_irq(uint gpio, uint32_t event_mask) {
    /* Events are latched and cleared when the callback is dispatched; nothing to do here. */
    (void)gpio;
    (void)event_mask;
}

/* Called by the simulator (from JavaScript) when an interrupt fires. Exported: see LINK_FLAGS in compile.js. */
void sim_irq_dispatch(uint gpio, uint32_t events) {
    if (irq_callback) irq_callback(gpio, events);
}
