import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  decideFocus,
  analyzeAction,
  detectClaudeExit,
  detectDeployUrl,
  detectLocalUrls,
  classifyTerminalErrors,
} from './terminalAnalyzer';

describe('stripAnsi', () => {
  it('removes color codes', () => {
    expect(stripAnsi('\x1b[32mgreen\x1b[0m')).toBe('green');
  });

  it('removes cursor movement sequences', () => {
    expect(stripAnsi('\x1b[2Ahello\x1b[1B')).toBe('hello');
  });

  it('removes OSC sequences (title set, etc.)', () => {
    expect(stripAnsi('\x1b]0;Window Title\x07text')).toBe('text');
  });

  it('removes control characters', () => {
    expect(stripAnsi('hello\x00world\x7f')).toBe('helloworld');
  });

  it('returns plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('strips complex mixed ANSI sequences', () => {
    const input = '\x1b[1;34m~/project\x1b[0m \x1b[32m$\x1b[0m ls';
    expect(stripAnsi(input)).toBe('~/project $ ls');
  });
});

describe('decideFocus', () => {
  it('returns terminal for interactive Y/n prompts', () => {
    const result = decideFocus(['Do you want to continue? [Y/n]']);
    expect(result).toEqual({ target: 'terminal', isChoicePrompt: false });
  });

  it('returns terminal for password prompts', () => {
    const result = decideFocus(['Password:  ']);
    expect(result).toEqual({ target: 'terminal', isChoicePrompt: false });
  });

  it('returns input for shell prompts (bash/zsh)', () => {
    const result = decideFocus(['some output', '~/project$']);
    expect(result).toEqual({ target: 'input', isChoicePrompt: false });
  });

  it('returns input for Claude Code prompt', () => {
    const result = decideFocus(['some output', '❯ ']);
    expect(result).toEqual({ target: 'input', isChoicePrompt: false });
  });

  it('returns input with isChoicePrompt for numbered choices (3+)', () => {
    // Avoid words that match INTERACTIVE_PATTERNS:
    // - "Select:", "Choose:", "Pick:" match ^\s*select\s*:/i etc.
    // - "Accept", "Reject", "Yes", "No", "Skip" after a number match
    //   /\d+[\.\)]\s*(Yes|No|Accept|Reject|Skip)\b/
    const lines = [
      'some previous output',
      'Available frameworks:',
      '1. React',
      '2. Vue',
      '3. Svelte',
    ];
    const result = decideFocus(lines);
    expect(result).toEqual({ target: 'input', isChoicePrompt: true });
  });

  it('returns input with isChoicePrompt for 2 choices with question indicator', () => {
    const lines = [
      'Which framework do you prefer?',
      '',
      '1. React',
      '2. Vue',
    ];
    // "Which framework?" has a trailing "?" which triggers the prompt indicator check
    const result = decideFocus(lines);
    expect(result).toEqual({ target: 'input', isChoicePrompt: true });
  });

  it('returns null when nothing matches', () => {
    const result = decideFocus(['some random output', 'more output']);
    expect(result).toEqual({ target: null, isChoicePrompt: false });
  });

  it('interactive patterns take priority over shell prompts', () => {
    const lines = ['~/project$ ', 'Continue? [Y/n]'];
    const result = decideFocus(lines);
    expect(result).toEqual({ target: 'terminal', isChoicePrompt: false });
  });
});

describe('analyzeAction', () => {
  it('returns idle when claudeRunning is false', () => {
    expect(analyzeAction('some text', false)).toBe('idle');
  });

  it('returns idle when Claude prompt is showing', () => {
    expect(analyzeAction('some output\n❯ ', true)).toBe('idle');
  });

  it('detects writing action', () => {
    expect(analyzeAction('some output\nEdit(/path/to/file)', true)).toBe('writing');
  });

  it('detects reading action', () => {
    expect(analyzeAction('some output\nRead(/path/to/file)', true)).toBe('reading');
  });

  it('detects executing action', () => {
    expect(analyzeAction('some output\nBash(npm test)', true)).toBe('executing');
  });

  it('returns thinking when claude is running but no tool markers', () => {
    expect(analyzeAction('claude is processing something...', true)).toBe('thinking');
  });

  it('handles preStripped flag', () => {
    // With preStripped=true, should skip ANSI stripping
    expect(analyzeAction('Edit(/path)', true, true)).toBe('writing');
  });
});

describe('detectClaudeExit', () => {
  it('detects shell prompt after Claude exits', () => {
    const lines = ['done', '~/project$ '];
    expect(detectClaudeExit(lines)).toBe(true);
  });

  it('returns false when Claude prompt is still visible', () => {
    const lines = Array(20).fill('output');
    lines.push('❯ ');
    lines.push('~/project$ ');
    expect(detectClaudeExit(lines)).toBe(false);
  });

  it('returns false when no shell prompt', () => {
    expect(detectClaudeExit(['some random output'])).toBe(false);
  });
});

describe('detectDeployUrl', () => {
  it('detects cozypane.com deploy URLs', () => {
    const url = detectDeployUrl('Deployed to https://myapp-user.cozypane.com successfully');
    expect(url).toBe('https://myapp-user.cozypane.com');
  });

  it('returns null for non-cozypane URLs', () => {
    expect(detectDeployUrl('Visit https://example.com')).toBeNull();
  });

  it('strips ANSI before matching', () => {
    const url = detectDeployUrl('\x1b[32mhttps://app-user.cozypane.com\x1b[0m');
    expect(url).toBe('https://app-user.cozypane.com');
  });
});

describe('detectLocalUrls', () => {
  it('detects localhost URLs', () => {
    const urls = detectLocalUrls('Server running at http://localhost:3000');
    expect(urls).toContain('http://localhost:3000');
  });

  it('normalizes 0.0.0.0 to localhost', () => {
    const urls = detectLocalUrls('http://0.0.0.0:5173');
    expect(urls).toContain('http://localhost:5173');
  });

  it('normalizes 127.0.0.1 to localhost', () => {
    const urls = detectLocalUrls('http://127.0.0.1:8080');
    expect(urls).toContain('http://localhost:8080');
  });

  it('normalizes [::] to localhost', () => {
    const urls = detectLocalUrls('http://[::]:4200');
    expect(urls).toContain('http://localhost:4200');
  });

  it('deduplicates URLs', () => {
    const urls = detectLocalUrls('http://localhost:3000 and http://localhost:3000 again');
    expect(urls).toHaveLength(1);
  });

  it('returns empty array when no URLs found', () => {
    expect(detectLocalUrls('no urls here')).toEqual([]);
  });

  it('strips trailing punctuation', () => {
    const urls = detectLocalUrls('Visit http://localhost:3000.');
    expect(urls).toContain('http://localhost:3000');
  });
});

describe('classifyTerminalErrors', () => {
  it('classifies TypeScript errors', () => {
    const errors = classifyTerminalErrors(['src/App.tsx(42,5): error TS2304: Cannot find name Foo']);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('typescript');
    expect(errors[0].file).toBe('src/App.tsx');
    expect(errors[0].line).toBe(42);
  });

  it('classifies build errors', () => {
    const errors = classifyTerminalErrors(['Module not found: some-package']);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('build');
  });

  it('classifies runtime errors', () => {
    const errors = classifyTerminalErrors(['TypeError: Cannot read property x of undefined']);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('runtime');
  });

  it('classifies warnings', () => {
    const errors = classifyTerminalErrors(['WARNING: something deprecated']);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('warning');
  });

  it('deduplicates identical errors', () => {
    const errors = classifyTerminalErrors([
      'TypeError: oops',
      'TypeError: oops',
    ]);
    expect(errors).toHaveLength(1);
  });

  it('returns empty array for clean output', () => {
    expect(classifyTerminalErrors(['all good', 'no errors'])).toEqual([]);
  });

  it('classifies esbuild errors', () => {
    const errors = classifyTerminalErrors(['\u2718 [ERROR] something went wrong']);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('build');
  });
});
