import { safeStorage } from 'electron';

// Credential storage helpers. On macOS + Windows these use the OS keychain
// via Electron's safeStorage. On Linux without a real keyring (headless /
// no libsecret) safeStorage falls back to silent plaintext, which is not
// a safe place to store `repo`-scoped GitHub tokens or cozypane deploy
// tokens — audit M8.
//
// Policy: refuse to persist when a real keyring is unavailable. Throwing
// back to the caller means the user will need to re-authenticate each
// session rather than leaving tokens sitting in base64 on disk.
//
// Reading a previously-stored value still tries its best: if an older
// version of CozyPane (or a CI build) wrote a base64 fallback, we can
// still decode it. But we won't WRITE new values that way.

class UnencryptedCredentialStoreError extends Error {
  constructor() {
    super(
      'Credential store not available: Electron safeStorage reports no real keyring. ' +
      'On Linux this usually means libsecret / GNOME Keyring / KWallet is missing. ' +
      'Install a keyring, or set COZYPANE_ALLOW_UNENCRYPTED_CREDENTIALS=1 to continue ' +
      'with plaintext-on-disk fallback (not recommended).',
    );
    this.name = 'UnencryptedCredentialStoreError';
  }
}

function allowFallback(): boolean {
  return process.env.COZYPANE_ALLOW_UNENCRYPTED_CREDENTIALS === '1';
}

export function encryptString(value: string): string {
  if (!value) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(value).toString('base64');
  }
  if (allowFallback()) {
    console.warn(
      '[CozyPane] safeStorage unavailable — storing credentials as base64 ' +
      '(COZYPANE_ALLOW_UNENCRYPTED_CREDENTIALS=1 set). This is NOT encryption.',
    );
    return Buffer.from(value).toString('base64');
  }
  throw new UnencryptedCredentialStoreError();
}

export function decryptString(encrypted: string): string {
  if (!encrypted) return '';
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      // Legacy fallback: value may have been base64 from an older CozyPane
      // build. Decode for read compatibility, but writes still refuse.
      try { return Buffer.from(encrypted, 'base64').toString('utf-8'); } catch { return ''; }
    }
  }
  // No keyring. Accept old base64 reads for compatibility; writes will
  // refuse via encryptString().
  try { return Buffer.from(encrypted, 'base64').toString('utf-8'); } catch { return ''; }
}
