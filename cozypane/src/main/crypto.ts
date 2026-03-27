import { safeStorage } from 'electron';

export function encryptString(value: string): string {
  if (value && safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(value).toString('base64');
  }
  // NOTE: When safeStorage is unavailable (headless Linux, no keyring), credentials are stored
  // as base64 — this is encoding, not encryption. A future improvement should use a
  // software cipher (e.g. AES-GCM with a machine-derived key) for this fallback.
  console.warn('[CozyPane] safeStorage unavailable — credentials stored with base64 encoding only (not encrypted)');
  return value ? Buffer.from(value).toString('base64') : '';
}

export function decryptString(encrypted: string): string {
  if (!encrypted) return '';
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      try { return Buffer.from(encrypted, 'base64').toString('utf-8'); } catch { return ''; }
    }
  }
  console.warn('[CozyPane] safeStorage unavailable — credentials decrypted with base64 only (not encrypted)');
  try { return Buffer.from(encrypted, 'base64').toString('utf-8'); } catch { return ''; }
}
