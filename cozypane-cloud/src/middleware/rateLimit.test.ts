import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkUserRateLimit } from './rateLimit.js';

describe('checkUserRateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests under the limit', () => {
    expect(checkUserRateLimit(1, 'deploy', 3, 60_000)).toBe(true);
    expect(checkUserRateLimit(1, 'deploy', 3, 60_000)).toBe(true);
    expect(checkUserRateLimit(1, 'deploy', 3, 60_000)).toBe(true);
  });

  it('blocks requests at the limit', () => {
    expect(checkUserRateLimit(2, 'deploy', 2, 60_000)).toBe(true);
    expect(checkUserRateLimit(2, 'deploy', 2, 60_000)).toBe(true);
    expect(checkUserRateLimit(2, 'deploy', 2, 60_000)).toBe(false);
  });

  it('allows requests after window expires', () => {
    expect(checkUserRateLimit(3, 'deploy', 1, 10_000)).toBe(true);
    expect(checkUserRateLimit(3, 'deploy', 1, 10_000)).toBe(false);

    // Advance time past the window
    vi.advanceTimersByTime(11_000);

    expect(checkUserRateLimit(3, 'deploy', 1, 10_000)).toBe(true);
  });

  it('uses separate buckets per user', () => {
    expect(checkUserRateLimit(10, 'deploy', 1, 60_000)).toBe(true);
    expect(checkUserRateLimit(10, 'deploy', 1, 60_000)).toBe(false);
    // Different user — should be allowed
    expect(checkUserRateLimit(11, 'deploy', 1, 60_000)).toBe(true);
  });

  it('uses separate buckets per action', () => {
    expect(checkUserRateLimit(20, 'deploy', 1, 60_000)).toBe(true);
    expect(checkUserRateLimit(20, 'deploy', 1, 60_000)).toBe(false);
    // Different bucket — should be allowed
    expect(checkUserRateLimit(20, 'upload', 1, 60_000)).toBe(true);
  });
});
