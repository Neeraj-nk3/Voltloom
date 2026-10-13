# Pico SDK / MicroPython compatibility

C programs compile against the headers in `compiler/sdk/include/` (the only SDK copy), which follow the real Pico SDK
signatures, so code written for a Pico builds unchanged when it only uses what is listed here. Anything not listed is
**not provided** and fails to compile (or raises `AttributeError` in Python).

## C (`#include "pico/stdlib.h"` and `hardware/*.h`)

| Area | Provided | Notes |
|---|---|---|
| GPIO | `gpio_init`, `gpio_set_dir(uint, bool)`, `gpio_put(uint, bool)`, `bool gpio_get(uint)`, `gpio_pull_up/down`, `gpio_disable_pulls`, `gpio_set_pulls`, `gpio_is_pulled_up/down`, `gpio_get_dir`, `gpio_is_dir_out`, `gpio_get_out_level`, `gpio_set_function`/`gpio_get_function` with the real `enum gpio_function`, and the bulk calls `gpio_get_all`, `gpio_set_mask`, `gpio_clr_mask`, `gpio_xor_mask`, `gpio_put_masked`, `gpio_put_all`, `gpio_init_mask`, `gpio_set_dir_out/in_masked`, `gpio_set_dir_masked`, `gpio_set_dir_all_bits` | function select only has an effect for `GPIO_FUNC_PWM`: a pin with that function is driven by its PWM slice (held low at duty 0 or with the slice stopped); `gpio_init` and `Pin(id, mode)` return it to plain GPIO. A slice that is running on a pin that was never given the PWM function does nothing, as on the chip. `gpio_set_pulls(up, down)` with both true is treated as no pull |
| GPIO interrupts | `gpio_set_irq_enabled`, `gpio_set_irq_callback`, `gpio_set_irq_enabled_with_callback`, `gpio_acknowledge_irq`, `enum gpio_irq_level` (`LEVEL_LOW 0x1`, `LEVEL_HIGH 0x2`, `EDGE_FALL 0x4`, `EDGE_RISE 0x8`) | one global callback, as in the SDK; no `irq_set_exclusive_handler`/NVIC API |
| Time | `sleep_ms`, `sleep_us`, `time_us_64`, `time_us_32`, `busy_wait_us/ms`, `absolute_time_t` with `get_absolute_time`, `to_ms_since_boot`, `to_us_since_boot`, `delayed_by_*`, `make_timeout_time_*`, `absolute_time_diff_us`, `time_reached`, `sleep_until`, `tight_loop_contents` | virtual clock; no alarms, repeating timers or alarm pools |
| PWM | `pwm_gpio_to_slice_num`, `pwm_gpio_to_channel`, `pwm_set_wrap`, `pwm_set_chan_level`, `pwm_set_both_levels`, `pwm_set_gpio_level`, `pwm_set_enabled`, `pwm_set_clkdiv`, `pwm_set_clkdiv_int_frac`, `pwm_config` + `pwm_get_default_config`, `pwm_config_set_clkdiv[_int_frac]`, `pwm_config_set_wrap`, `pwm_init` | frequency = 125 MHz / (clkdiv × (wrap + 1)); no phase-correct mode, counters or PWM interrupts |
| Watchdog | `watchdog_enable`, `watchdog_update`, `watchdog_reboot` (with or without delay), `watchdog_caused_reboot`, `watchdog_enable_caused_reboot` | runs on the virtual clock; timeouts above 8388 ms are clamped; `watchdog_enable_caused_reboot()` reports the same as `watchdog_caused_reboot()` |
| Misc | `bool stdio_init_all()`, `printf`/`puts` (the toolchain's libc), `reset_usb_boot` (soft reset), `cyw43_arch_*` (always connects), `fs_*` | HTTP and MQTT were removed: including `net/http_client.h` or `net/mqtt_client.h` is a compile error | |
| Not provided | ADC, I2C, SPI, UART, PIO, DMA, multicore, `hardware/irq.h`, `hardware/timer.h`, `pico/multicore.h`, flash APIs | |

Interrupt handlers run at the **virtual time of the edge**, in the middle of a sleep if need be, and the sleep still ends
on schedule. Edges are detected at points where virtual time passes or pin state changes (every sleep slice, every pin or
clock read, every write by the program, every circuit change). A loop that does none of those (`while (!flag) {}` with
nothing in the body) never sees an interrupt; use `tight_loop_contents()` or any pin/clock read in the body.
Level interrupts are reported once when the condition becomes true.

## MicroPython (`from machine import ...`, `import time`)

| Provided | Notes |
|---|---|
| `Pin(id, mode, pull, value=)` where `id` is a number, `"GP15"`, `"GPIO15"` or `"LED"` (the Pico W's on-board LED, kept on GPIO 25 here), `.init()`, `.value()`, `pin()` / `pin(v)`, `.mode()`, `.pull()`, `.on/off/high/low/toggle()`, `str(pin)`, constants `IN OUT OPEN_DRAIN PULL_UP PULL_DOWN` | `OPEN_DRAIN` behaves as a plain output; an unknown name or a number outside 0-29 raises `ValueError`; `machine.PWM` also accepts a name |
| `Pin.irq(handler, trigger)` with `IRQ_LOW_LEVEL 1`, `IRQ_HIGH_LEVEL 2`, `IRQ_FALLING 4`, `IRQ_RISING 8` | handler gets the `Pin`; an exception in a handler is printed and the program continues; `priority`, `wake`, `hard` are accepted and ignored; `irq()` returns `None` |
| `PWM(pin, freq=, duty_u16=, duty_ns=)`, `.freq()`, `.duty_u16()`, `.duty_ns()`, `.deinit()` | same divider/wrap planning as MicroPython; `ValueError("freq too large")` / `("freq too small")`. A request that method lands more than 0.5 % off uses the largest counter range instead |
| `WDT(id, timeout)`, `.feed()` | timeout clamped to 8388 ms; cannot be disabled |
| `reset()`, `soft_reset()`, `reset_cause()` with `PWRON_RESET`, `WDT_RESET`, `SOFT_RESET`, `freq()`, `disable_irq()`, `enable_irq()` | the numeric values of `PWRON_RESET` (1), `WDT_RESET` (3) and `SOFT_RESET` (4) and `reset()` reporting `PWRON_RESET` are assumptions; `disable_irq()` holds handlers back and edges are latched meanwhile |
| `time.sleep/sleep_ms/sleep_us/ticks_ms/ticks_us/ticks_cpu/ticks_diff/ticks_add/time/time_ns/localtime/gmtime`, and `utime` | virtual clock; `time.time()` starts at 2025-01-01 UTC |
| Not provided | `ADC`, `I2C`, `SPI`, `UART`, `Timer`, `RTC`, `Signal`, `machine.mem*`, `network` |

## Reset behaviour
* A reset requested by the program (`machine.reset()`, `watchdog_reboot()`, an expired watchdog) restarts the program from
  the top on freshly reset hardware; the filesystem (flash) is kept. Virtual time restarts at 0.
* The restarted program can ask why (`machine.reset_cause()`, `watchdog_caused_reboot()`).
* A program you start yourself (Run) always begins from power-on: the cause of an earlier reset is forgotten.
* More than 10 resets in 5 seconds stops the simulation ("the program keeps resetting itself").
