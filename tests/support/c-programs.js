// Shared by the Vitest scenario tests and the Playwright browser tests (plain data, no test-framework import).

/** The includes nearly every C test program starts with. */
export const C_HEAD = '#include "pico/stdlib.h"\n#include "hardware/gpio.h"\n#include "hardware/pwm.h"\n#include "hardware/watchdog.h"\n';
