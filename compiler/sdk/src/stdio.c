/*
 * stdio.c — C Bridge for Serial I/O
 *
 * Implements sim_printf/sim_puts by calling extern JS print function.
 * NOTE: We do NOT redefine printf — Emscripten provides its own.
 * Instead, we use Emscripten's built-in printf which routes through
 * the Module.print callback, which we wire to the serial bridge.
 */

#include "pico/stdio.h"

extern void js_stdio_init(void);

bool stdio_init_all(void) {
    js_stdio_init();
    return true;
}

/* printf, puts, putchar are provided by Emscripten's libc.
 * Output routes through Module.print callback which we set
 * to serial_bridge.print() in compile-client.js */
