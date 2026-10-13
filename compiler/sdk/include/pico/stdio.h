/*
 * pico/stdio.h — Serial I/O API for Emscripten compilation
 *
 * Only declares stdio_init_all().
 * printf/puts/putchar come from Emscripten's built-in libc.
 */

#ifndef PICO_STDIO_H
#define PICO_STDIO_H

#include "pico/types.h"
#include <stdio.h>  /* Emscripten's printf, puts, putchar */

bool stdio_init_all(void);

#endif /* PICO_STDIO_H */
