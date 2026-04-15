import { describe, it, expect } from 'vitest';
import {
  parseBashResult, parseEditResult, parseReadResult, parseGrepResult, detectTool,
} from './chatToolRenderers';

describe('parseBashResult', () => {
  it('parses exit code', () => {
    const r = parseBashResult('some output\n[exit 1]');
    expect(r.exitCode).toBe(1);
  });
  it('returns stdout even without exit code', () => {
    const r = parseBashResult('hello world');
    expect(r.stdout).toBe('hello world');
    expect(r.exitCode).toBeUndefined();
  });
});

describe('parseEditResult', () => {
  it('counts additions and removals from diff', () => {
    const r = parseEditResult('+new line\n-old line\n+another new', 'foo.ts');
    expect(r.additions).toBe(2);
    expect(r.removals).toBe(1);
    expect(r.file).toBe('foo.ts');
  });
  it('falls back to summary line', () => {
    const r = parseEditResult('edited things (+3 -1)', 'a.ts');
    expect(r.additions).toBe(3);
    expect(r.removals).toBe(1);
  });
});

describe('parseReadResult', () => {
  it('extracts line count', () => {
    const r = parseReadResult('Read 42 lines from foo', 'foo.ts');
    expect(r.lines).toBe(42);
    expect(r.file).toBe('foo.ts');
  });
});

describe('parseGrepResult', () => {
  it('parses file:line:preview matches', () => {
    const out = [
      'src/foo.ts:12:const x = 1',
      'src/bar.ts:99:const y = 2',
      'not a match line',
    ].join('\n');
    const r = parseGrepResult(out, '"pattern"');
    expect(r.matches).toHaveLength(2);
    expect(r.matches[0].file).toBe('src/foo.ts');
    expect(r.matches[0].line).toBe(12);
    expect(r.pattern).toBe('pattern');
  });
});

describe('detectTool', () => {
  it('matches a Read tool invocation', () => {
    const r = detectTool('\u23FA Read(src/App.tsx)');
    expect(r?.type).toBe('read');
    expect(r?.detail).toBe('src/App.tsx');
  });
  it('matches a Bash tool invocation', () => {
    const r = detectTool('\u23FA Bash(npm test)');
    expect(r?.type).toBe('bash');
    expect(r?.name).toBe('Bash');
  });
  it('returns null for non-tool line', () => {
    expect(detectTool('hello world')).toBeNull();
  });
});
