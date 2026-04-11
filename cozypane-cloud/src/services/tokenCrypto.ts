import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

// AES-256-GCM with a key derived from the env var GITHUB_TOKEN_ENCRYPTION_KEY.
// GCM's IV should be random 12 bytes; we store iv + tag + ciphertext together
// as a single base64 blob for simple round-tripping via TEXT columns.
//
// Layout of the persisted string:  base64(iv || tag || ciphertext)
//
// The encryption key is derived via SHA-256 from the env var so the caller
// can use any passphrase length. In production set
// GITHUB_TOKEN_ENCRYPTION_KEY to 32+ random bytes (e.g. `openssl rand -hex 32`).

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const raw = process.env.GITHUB_TOKEN_ENCRYPTION_KEY;
  if (!raw || raw.length < 16) {
    throw new Error('GITHUB_TOKEN_ENCRYPTION_KEY env var is missing or too short (min 16 chars)');
  }
  return createHash('sha256').update(raw).digest();
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptToken(stored: string): string {
  const key = getKey();
  const buf = Buffer.from(stored, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('Invalid encrypted token blob');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
