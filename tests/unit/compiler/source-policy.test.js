import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkSource, stripComments, containsInlineAsm, extractUserLines, MAX_SOURCE_BYTES,
} from '../../../compiler/lib/source-policy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../compiler');
const sdkDir = path.join(root, 'sdk', 'include');
const check = (code) => checkSource(code, { sdkDir });
const reason = (code) => { const r = check(code); return r.ok ? null : r.reason; };

describe('checkSource: accepts normal programs', () => {
  it('accepts the bundled blink example', () => {
    const blink = fs.readFileSync(path.join(root, '..', 'examples', 'c', 'blink.c'), 'utf8');
    expect(check(blink)).toEqual({ ok: true });
  });

  it('accepts standard headers and SDK headers in both include forms', () => {
    expect(check('#include <stdio.h>\n#include "pico/stdlib.h"\n#include <hardware/gpio.h>\nint main(){return 0;}')).toEqual({ ok: true });
  });

  it('ignores include-looking text in comments and string literals', () => {
    expect(check('// #include "/etc/passwd"\n/* #include <windows.h> */\nconst char *s = "#include \\"/etc/passwd\\"";\nint main(){return 0;}')).toEqual({ ok: true });
  });
});

describe('checkSource: rejects host-file and file-reading tricks', () => {
  it.each([
    ['unix absolute path', '#include "/etc/passwd"'],
    ['windows drive path', '#include "C:/Windows/win.ini"'],
    ['windows backslash path', '#include "C:\\\\Windows\\\\win.ini"'],
    ['parent directory', '#include "../server.js"'],
    ['parent directory in angle form', '#include <../../secrets.h>'],
    ['not an allowed header', '#include <sys/socket.h>'],
    ['unknown local header', '#include "secret.h"'],
    ['macro operand', '#define F "/etc/passwd"\n#include F'],
    ['include_next', '#include_next <stdio.h>'],
    ['#import', '#import "x.h"'],
    ['#embed', 'const char d[] = {\n#embed "/etc/passwd"\n};'],
    ['__has_include', '#if __has_include("/etc/passwd")\n#endif'],
    ['__has_embed', '#if __has_embed("x")\n#endif'],
  ])('%s', (_name, code) => {
    expect(check(code).ok).toBe(false);
  });

  it('sees through spacing, comments, digraphs and line splices', () => {
    expect(check('  #   include "/etc/passwd"').ok).toBe(false);
    expect(check('#/* hi */include "/etc/passwd"').ok).toBe(false);
    expect(check('%:include "/etc/passwd"').ok).toBe(false);
    expect(check('#inc\\\nlude "/etc/passwd"').ok).toBe(false);
    expect(check('#include\\\n "/etc/passwd"').ok).toBe(false);
    expect(check('??=include "/etc/passwd"').ok).toBe(false);
  });

  it('rejects empty, NUL-containing and oversize sources', () => {
    expect(check('').ok).toBe(false);
    expect(check('int x;\0').ok).toBe(false);
    expect(reason('x'.repeat(MAX_SOURCE_BYTES + 1))).toMatch(/larger than/);
  });
});

describe('inline assembly backstop (applied to preprocessed output)', () => {
  it('detects asm keywords but not words inside strings', () => {
    expect(containsInlineAsm('__asm__(".incbin \\"/etc/passwd\\"");')).toBe(true);
    expect(containsInlineAsm('asm volatile("" ::: "memory");')).toBe(true);
    expect(containsInlineAsm('__asm("nop");')).toBe(true);
    expect(containsInlineAsm('printf("asm is great");')).toBe(false);
    expect(containsInlineAsm('int assemble = 1;')).toBe(false);
  });

  it('extractUserLines keeps only the lines that came from the user file', () => {
    const pre = [
      '# 1 "C:\\\\tmp\\\\voltloom-build-x\\\\user_main.c"',
      'int a;',
      '# 1 "/emsdk/sysroot/include/stdio.h" 1',
      'extern int __asm__lib(void) __asm__("renamed");',
      '# 4 "C:\\\\tmp\\\\voltloom-build-x\\\\user_main.c" 2',
      'int b;',
    ].join('\n');
    expect(extractUserLines(pre, 'user_main.c')).toBe('int a;\nint b;');
  });
});

describe('stripComments', () => {
  it('removes comments but not comment markers inside strings', () => {
    expect(stripComments('a // x\nb /* y */ c "// z" \'/*\'')).toBe('a  \nb   c "// z" \'/*\'');
  });
});
