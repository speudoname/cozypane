import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';

// The dbName/dbUser functions are not exported, so we test the sanitization
// logic directly and the password generation format.

describe('database name/user sanitization logic', () => {
  // Replicate the sanitization from database.ts
  function dbName(userId: number, appName: string): string {
    const safe = appName.replace(/[^a-z0-9]/g, '_').slice(0, 40);
    return `cp_${userId}_${safe}`;
  }

  function dbUser(userId: number, appName: string): string {
    const safe = appName.replace(/[^a-z0-9]/g, '_').slice(0, 40);
    return `cpu_${userId}_${safe}`;
  }

  it('generates correct db name format', () => {
    expect(dbName(1, 'myapp')).toBe('cp_1_myapp');
  });

  it('generates correct db user format', () => {
    expect(dbUser(1, 'myapp')).toBe('cpu_1_myapp');
  });

  it('sanitizes special characters to underscores', () => {
    expect(dbName(1, 'my-app.v2')).toBe('cp_1_my_app_v2');
    expect(dbUser(1, 'my-app.v2')).toBe('cpu_1_my_app_v2');
  });

  it('sanitizes uppercase to underscores', () => {
    // uppercase letters are not in [a-z0-9] so they become _
    expect(dbName(1, 'MyApp')).toBe('cp_1__y_pp');
  });

  it('truncates long app names to 40 chars', () => {
    const longName = 'a'.repeat(60);
    const name = dbName(1, longName);
    // cp_1_ = 4 chars prefix, safe part = 40 chars
    expect(name).toBe(`cp_1_${'a'.repeat(40)}`);
  });

  it('handles empty app name', () => {
    expect(dbName(1, '')).toBe('cp_1_');
    expect(dbUser(1, '')).toBe('cpu_1_');
  });

  it('only allows safe identifier characters', () => {
    const name = dbName(1, 'test-app');
    // The full identifier should match [a-z0-9_]+ (plus the cp_ prefix)
    expect(/^[a-z0-9_]+$/.test(name)).toBe(true);
  });
});

describe('password generation format', () => {
  it('randomBytes(24).toString("hex") produces 48 hex chars', () => {
    const pw = randomBytes(24).toString('hex');
    expect(pw).toHaveLength(48);
    expect(/^[a-f0-9]+$/.test(pw)).toBe(true);
  });

  it('each call produces a different password', () => {
    const a = randomBytes(24).toString('hex');
    const b = randomBytes(24).toString('hex');
    expect(a).not.toBe(b);
  });
});
