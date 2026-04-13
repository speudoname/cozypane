import { describe, it, expect } from 'vitest';
import { encryptToken, decryptToken } from './tokenCrypto.js';

describe('tokenCrypto', () => {
  it('round-trips a short token', () => {
    const plain = 'gho_abc123';
    const encrypted = encryptToken(plain);
    expect(decryptToken(encrypted)).toBe(plain);
  });

  it('round-trips a long token', () => {
    const plain = 'ghp_' + 'a'.repeat(200);
    const encrypted = encryptToken(plain);
    expect(decryptToken(encrypted)).toBe(plain);
  });

  it('round-trips an empty string', () => {
    const encrypted = encryptToken('');
    expect(decryptToken(encrypted)).toBe('');
  });

  it('round-trips unicode content', () => {
    const plain = 'token-with-emoji-\u{1F600}-and-kanji-\u6F22\u5B57';
    const encrypted = encryptToken(plain);
    expect(decryptToken(encrypted)).toBe(plain);
  });

  it('encrypted output differs from input', () => {
    const plain = 'gho_mytoken123';
    const encrypted = encryptToken(plain);
    expect(encrypted).not.toBe(plain);
  });

  it('encrypted output is valid base64', () => {
    const encrypted = encryptToken('test-token');
    expect(() => Buffer.from(encrypted, 'base64')).not.toThrow();
    // Round-trip base64 should equal the original
    expect(Buffer.from(encrypted, 'base64').toString('base64')).toBe(encrypted);
  });

  it('produces different ciphertexts for the same input (random IV)', () => {
    const plain = 'same-token';
    const a = encryptToken(plain);
    const b = encryptToken(plain);
    expect(a).not.toBe(b);
    // But both decrypt to the same value
    expect(decryptToken(a)).toBe(plain);
    expect(decryptToken(b)).toBe(plain);
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = encryptToken('secret');
    // Flip a byte in the middle
    const buf = Buffer.from(encrypted, 'base64');
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString('base64');
    expect(() => decryptToken(tampered)).toThrow();
  });

  it('rejects a too-short blob', () => {
    const short = Buffer.from('too-short').toString('base64');
    expect(() => decryptToken(short)).toThrow('Invalid encrypted token blob');
  });
});
