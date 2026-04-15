import { describe, it, expect } from 'vitest';
import {
  parseStatusLine, parsePermissionLine, parseUsageLine, parseMcpLine, parseAllStatus,
} from './chatStatus';

describe('parseStatusLine', () => {
  it('parses folder, branch, model with context, mode', () => {
    const r = parseStatusLine('quizme (main) | Opus 4.6 (1M context) | default');
    expect(r).toEqual({
      folder: 'quizme',
      branch: 'main',
      model: 'Opus 4.6',
      contextSize: '1M',
      mode: 'default',
    });
  });

  it('parses without branch', () => {
    const r = parseStatusLine('myproj | Sonnet 4 | plan');
    expect(r?.folder).toBe('myproj');
    expect(r?.branch).toBeUndefined();
    expect(r?.model).toBe('Sonnet 4');
    expect(r?.mode).toBe('plan');
  });

  it('returns null for non-matching line', () => {
    expect(parseStatusLine('just some text')).toBeNull();
  });
});

describe('parsePermissionLine', () => {
  it('parses bypass + effort', () => {
    const r = parsePermissionLine('\u23F5\u23F5 bypass permissions on (shift+tab to cycle)  \u25D0 medium \u00B7 /effort');
    expect(r?.permissionMode).toBe('bypass');
    expect(r?.effort).toBe('medium');
  });

  it('parses accept edits', () => {
    const r = parsePermissionLine('accept edits on');
    expect(r?.permissionMode).toBe('accept-edits');
  });
});

describe('parseUsageLine', () => {
  it('parses percent and reset', () => {
    const r = parseUsageLine("You've used 91% of your weekly limit \u00B7 resets Apr 17 at 10pm");
    expect(r?.usagePercent).toBe(91);
    expect(r?.usageReset).toMatch(/Apr 17/);
  });

  it('parses without reset', () => {
    const r = parseUsageLine("You've used 42% of your limit");
    expect(r?.usagePercent).toBe(42);
  });
});

describe('parseMcpLine', () => {
  it('parses failure count', () => {
    const r = parseMcpLine('1 MCP server failed \u00B7 /mcp');
    expect(r?.mcpFailures).toBe(1);
  });
});

describe('parseAllStatus', () => {
  it('combines all rows into one Status', () => {
    const blob = [
      'quizme (main) | Opus 4.6 (1M context) | default',
      '\u23F5\u23F5 bypass permissions on (shift+tab to cycle)  \u25D0 medium \u00B7 /effort',
      "You've used 91% of your weekly limit \u00B7 resets Apr 17",
      '2 MCP servers failed \u00B7 /mcp',
    ].join('\n');
    const r = parseAllStatus(blob);
    expect(r.folder).toBe('quizme');
    expect(r.branch).toBe('main');
    expect(r.model).toBe('Opus 4.6');
    expect(r.permissionMode).toBe('bypass');
    expect(r.effort).toBe('medium');
    expect(r.usagePercent).toBe(91);
    expect(r.mcpFailures).toBe(2);
  });
});
