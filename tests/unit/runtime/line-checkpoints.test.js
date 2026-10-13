import { describe, it, expect } from 'vitest';
import { logicalLineStarts, injectCheckpoints, remapErrorLines } from '../../../src/runtime/python/line-checkpoints.js';

const startsOf = (code) => logicalLineStarts(code).map((b) => (b ? 1 : 0)).join('');
const injectedLines = (code) =>
  injectCheckpoints(code).code.split('\n').filter((l) => l.includes('sim_debug.checkpoint'))
    .map((l) => Number(l.match(/checkpoint\((\d+)\)/)[1]));

describe('logicalLineStarts', () => {
  it('marks every simple line as a statement start', () => {
    expect(startsOf('a = 1\nb = 2\nprint(a)')).toBe('111');
  });

  it('does not start a statement inside brackets', () => {
    expect(startsOf('x = [1,\n     2,\n     3]\nprint(x)')).toBe('1001');
    expect(startsOf('f(a,\n  b)\ng()')).toBe('101');
    expect(startsOf('d = {\n  "k": (1,\n         2),\n}\nz = 1')).toBe('10001');
  });

  it('does not start a statement inside triple-quoted strings', () => {
    expect(startsOf('s = """line one\nline two\n"""\nprint(s)')).toBe('1001');
    expect(startsOf("s = '''a\nb'''\nc = 1")).toBe('101');
  });

  it('handles backslash continuations', () => {
    expect(startsOf('x = 1 + \\\n    2\ny = 3')).toBe('101');
    expect(startsOf('x = 1 + \\\r\n    2\r\ny = 3')).toBe('101');
  });

  it('ignores brackets and quotes inside comments and strings', () => {
    expect(startsOf('a = 1  # ( [ { "\nb = 2')).toBe('11');
    expect(startsOf('s = "(["\nt = 1')).toBe('11');
    expect(startsOf("s = 'it\\'s'\nt = 1")).toBe('11');
    expect(startsOf('s = "say \\"hi\\" ("\nt = 1')).toBe('11');
  });

  it('keeps a backslash-continued single-quoted string together', () => {
    expect(startsOf('s = "abc\\\ndef"\nt = 1')).toBe('101');
  });

  it('recovers at the newline after an unterminated single-line string', () => {
    expect(startsOf('s = "oops\nt = 1')).toBe('11');
  });

  it('never goes negative on stray closing brackets', () => {
    expect(startsOf(')\nx = 1')).toBe('11');
  });
});

describe('injectCheckpoints', () => {
  it('injects before each statement with the original indentation', () => {
    const { code } = injectCheckpoints('while True:\n    x = 1\n');
    expect(code.split('\n').slice(0, 4)).toEqual([
      'import sim_debug; sim_debug.checkpoint(1)',
      'while True:',
      '    import sim_debug; sim_debug.checkpoint(2)',
      '    x = 1',
    ]);
  });

  it('does not inject into multi-line statements, strings or continuations', () => {
    expect(injectedLines('x = [1,\n 2,\n 3]\nprint(x)')).toEqual([1, 4]);
    expect(injectedLines('s = """a\nb"""\nprint(s)')).toEqual([1, 3]);
    expect(injectedLines('y = 1 + \\\n 2\nz = 3')).toEqual([1, 3]);
  });

  it('skips blank lines, comments, else/elif/except/finally and decorators', () => {
    const src = 'try:\n    a = 1\nexcept ValueError:\n    pass\nfinally:\n    b = 2\n\n# note\nif a:\n    pass\nelif b:\n    pass\nelse:\n    pass\n';
    expect(injectedLines(src)).toEqual([1, 2, 4, 6, 9, 10, 12, 14]);
  });

  it('does not put a checkpoint between a decorator and its def', () => {
    const src = '@decorator\ndef f():\n    return 1\nprint(f())\n';
    const lines = injectCheckpoints(src).code.split('\n');
    expect(lines[0]).toBe('@decorator');
    expect(lines[1]).toBe('def f():');
    expect(injectedLines(src)).toEqual([3, 4]);
  });

  it('maps instrumented line numbers back to the user\'s lines', () => {
    const { lineMap } = injectCheckpoints('a = 1\n\nb = [1,\n 2]\nc = 3');
    // out lines: 1 cp(1), 2 "a = 1", 3 "", 4 cp(3), 5 "b = [1,", 6 " 2]", 7 cp(5), 8 "c = 3"
    expect(lineMap).toEqual({ 1: 1, 2: 1, 3: 2, 4: 3, 5: 3, 6: 4, 7: 5, 8: 5 });
  });

  it('produces code with the same number of user lines and keeps all user text', () => {
    const src = 'x = [1,\n     2]\nprint(x)\n';
    const { code } = injectCheckpoints(src);
    const withoutCheckpoints = code.split('\n').filter((l) => !l.includes('sim_debug.checkpoint')).join('\n');
    expect(withoutCheckpoints).toBe(src);
  });
});

describe('remapErrorLines', () => {
  it('translates instrumented line numbers and leaves unknown ones alone', () => {
    const map = { 4: 3, 5: 3 };
    expect(remapErrorLines('File "<stdin>", line 5, in <module>', map)).toBe('File "<stdin>", line 3, in <module>');
    expect(remapErrorLines('line 99', map)).toBe('line 99');
  });
});
