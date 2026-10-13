/*
 * fs.c — C Bridge for Filesystem operations
 */

#include "fs/fs.h"

extern int js_fs_init(void);
extern int js_fs_write(const char *filename, const char *data);
extern int js_fs_read(const char *filename, char *buffer, int max_len);
extern int js_fs_exists(const char *filename);
extern int js_fs_delete(const char *filename);

int fs_init(void) {
    return js_fs_init();
}

int fs_write(const char *filename, const char *data) {
    return js_fs_write(filename, data);
}

int fs_read(const char *filename, char *buffer, int max_len) {
    return js_fs_read(filename, buffer, max_len);
}

int fs_exists(const char *filename) {
    return js_fs_exists(filename);
}

int fs_delete(const char *filename) {
    return js_fs_delete(filename);
}
