/*
 * hardware/gpio.h — GPIO API, compatible with the Raspberry Pi Pico SDK (hardware_gpio)
 *
 * Signatures and constants follow the real SDK, so code written for a Pico compiles here unchanged.
 * Interrupt event values are the SDK's: LEVEL_LOW 0x1, LEVEL_HIGH 0x2, EDGE_FALL 0x4, EDGE_RISE 0x8.
 *
 * Differences from the real chip (see docs): there is one global callback, as in the SDK; level interrupts are
 * reported once when the condition becomes true instead of continuously; function select is accepted but only
 * GPIO_FUNC_PWM has an effect.
 */

#ifndef HARDWARE_GPIO_H
#define HARDWARE_GPIO_H

#include "pico/types.h"

#define GPIO_OUT 1
#define GPIO_IN  0

enum gpio_function {
    GPIO_FUNC_XIP = 0,
    GPIO_FUNC_SPI = 1,
    GPIO_FUNC_UART = 2,
    GPIO_FUNC_I2C = 3,
    GPIO_FUNC_PWM = 4,
    GPIO_FUNC_SIO = 5,
    GPIO_FUNC_PIO0 = 6,
    GPIO_FUNC_PIO1 = 7,
    GPIO_FUNC_GPCK = 8,
    GPIO_FUNC_USB = 9,
    GPIO_FUNC_NULL = 0x1f
};

enum gpio_irq_level {
    GPIO_IRQ_LEVEL_LOW = 0x1u,
    GPIO_IRQ_LEVEL_HIGH = 0x2u,
    GPIO_IRQ_EDGE_FALL = 0x4u,
    GPIO_IRQ_EDGE_RISE = 0x8u
};

typedef void (*gpio_irq_callback_t)(uint gpio, uint32_t event_mask);

void gpio_init(uint gpio);
void gpio_set_dir(uint gpio, bool out);
void gpio_put(uint gpio, bool value);
bool gpio_get(uint gpio);
void gpio_pull_up(uint gpio);
void gpio_pull_down(uint gpio);
void gpio_disable_pulls(uint gpio);
void gpio_set_pulls(uint gpio, bool up, bool down);   /* both true is not modelled: it disables the pulls */
bool gpio_is_pulled_up(uint gpio);
bool gpio_is_pulled_down(uint gpio);
void gpio_set_function(uint gpio, enum gpio_function fn);
enum gpio_function gpio_get_function(uint gpio);

/* direction and output-level queries */
uint gpio_get_dir(uint gpio);                         /* GPIO_OUT (1) or GPIO_IN (0) */
bool gpio_is_dir_out(uint gpio);
bool gpio_get_out_level(uint gpio);

/* all 30 pins at once: bit n is GPn */
uint32_t gpio_get_all(void);
void gpio_set_mask(uint32_t mask);
void gpio_clr_mask(uint32_t mask);
void gpio_xor_mask(uint32_t mask);
void gpio_put_masked(uint32_t mask, uint32_t value);
void gpio_put_all(uint32_t value);
void gpio_init_mask(uint32_t gpio_mask);
void gpio_set_dir_out_masked(uint32_t mask);
void gpio_set_dir_in_masked(uint32_t mask);
void gpio_set_dir_masked(uint32_t mask, uint32_t value);
void gpio_set_dir_all_bits(uint32_t values);

void gpio_set_irq_enabled(uint gpio, uint32_t event_mask, bool enabled);
void gpio_set_irq_callback(gpio_irq_callback_t callback);
void gpio_set_irq_enabled_with_callback(uint gpio, uint32_t event_mask, bool enabled, gpio_irq_callback_t callback);
void gpio_acknowledge_irq(uint gpio, uint32_t event_mask);

#endif /* HARDWARE_GPIO_H */
