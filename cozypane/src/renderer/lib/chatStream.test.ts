import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StreamTokenizer } from './chatStream';
import type { ChatEvent } from './chatEvents';

describe('StreamTokenizer', () => {
  let events: ChatEvent[];
  let tok: StreamTokenizer;

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    tok = new StreamTokenizer();
    tok.subscribe(e => events.push(e));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function feed(text: string) {
    tok.feedRaw(text);
    vi.runAllTimers();
    tok.flush();
  }

  it('emits user-input on onUserInput', () => {
    tok.onUserInput('hello');
    const user = events.find(e => e.kind === 'user-input');
    expect(user).toBeTruthy();
    if (user && user.kind === 'user-input') {
      expect(user.text).toBe('hello');
      expect(user.turnId).toBe(1);
    }
  });

  it('parses status line and emits status event', () => {
    tok.onUserInput('hi');
    feed('quizme (main) | Opus 4.6 (1M context) | default\n');
    const status = events.find(e => e.kind === 'status');
    expect(status).toBeTruthy();
    if (status && status.kind === 'status') {
      expect(status.status.folder).toBe('quizme');
      expect(status.status.branch).toBe('main');
      expect(status.status.model).toBe('Opus 4.6');
      expect(status.status.contextSize).toBe('1M');
      expect(status.status.mode).toBe('default');
    }
  });

  it('emits tool-start and tool-result for Read', () => {
    tok.onUserInput('read foo');
    feed('\u23FA Read(src/App.tsx)\n');
    feed('some contents line\n');
    feed('\u276F\n'); // prompt — closes tool
    const start = events.find(e => e.kind === 'tool-start');
    expect(start).toBeTruthy();
    if (start && start.kind === 'tool-start') {
      expect(start.tool).toBe('read');
      expect(start.detail).toBe('src/App.tsx');
    }
    const result = events.find(e => e.kind === 'tool-result');
    expect(result).toBeTruthy();
  });

  it('emits prose-chunk for prose text', () => {
    tok.onUserInput('explain');
    feed('This is my answer.\n');
    const prose = events.find(e => e.kind === 'prose-chunk');
    expect(prose).toBeTruthy();
    if (prose && prose.kind === 'prose-chunk') {
      expect(prose.text).toContain('This is my answer.');
    }
  });

  it('detects Y/N interactive prompt', () => {
    tok.onUserInput('install?');
    feed('Proceed with install? [Y/n]\n');
    const prompt = events.find(e => e.kind === 'interactive-prompt');
    expect(prompt).toBeTruthy();
    if (prompt && prompt.kind === 'interactive-prompt') {
      expect(prompt.prompt.kind).toBe('yes-no');
    }
  });

  it('clears state on clear()', () => {
    tok.onUserInput('foo');
    tok.clear();
    expect(tok.getLastStatus()).toEqual({});
  });

  it('bumps turnId for each user input', () => {
    tok.onUserInput('one');
    tok.onUserInput('two');
    const inputs = events.filter(e => e.kind === 'user-input');
    expect(inputs).toHaveLength(2);
    if (inputs[0].kind === 'user-input' && inputs[1].kind === 'user-input') {
      expect(inputs[0].turnId).toBe(1);
      expect(inputs[1].turnId).toBe(2);
    }
  });
});
