/*
 * fs/fs.h — Filesystem API for Emscripten compilation
 */

#ifndef PICO_FS_H
#define PICO_FS_H

#include "pico/types.h"

#define FS_OK              0
#define FS_ERR_NOT_FOUND  -1
#define FS_ERR_WRITE      -2
#define FS_ERR_INIT       -3

int fs_init(void);
int fs_write(const char *filename, const char *data);
int fs_read(const char *filename, char *buffer, int max_len);
int fs_exists(const char *filename);
int fs_delete(const char *filename);

#endif /* PICO_FS_H */
