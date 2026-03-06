import { ipcMain, safeStorage, app } from 'electron';
import path from 'path';
import fs from 'fs';

interface StoredSettings {
  provider: string;
  model: string;
  encryptedKey: string;
}

const PROVIDERS: Record<string, { name: string; models: { id: string; name: string }[] }> = {
  anthropic: {
    name: 'Anthropic',
    models: [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ],
  },
  openai: {
    name: 'OpenAI',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    ],
  },
};

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings(): StoredSettings {
  try {
    const data = fs.readFileSync(getSettingsPath(), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { provider: 'anthropic', model: 'claude-sonnet-4-20250514', encryptedKey: '' };
  }
}

function writeSettings(settings: StoredSettings) {
  const dir = path.dirname(getSettingsPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
}

function encryptKey(key: string): string {
  if (key && safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(key).toString('base64');
  }
  // Fallback: base64 only (not truly secure, but userData is per-user)
  return key ? Buffer.from(key).toString('base64') : '';
}

function decryptKey(encrypted: string): string {
  if (!encrypted) return '';
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      // Might be base64-only fallback from before encryption was available
      try { return Buffer.from(encrypted, 'base64').toString('utf-8'); } catch { return ''; }
    }
  }
  try { return Buffer.from(encrypted, 'base64').toString('utf-8'); } catch { return ''; }
}

export function getDecryptedApiKey(): string {
  const settings = readSettings();
  return decryptKey(settings.encryptedKey);
}

export function getSettings(): StoredSettings & { provider: string; model: string } {
  return readSettings();
}

export function registerSettingsHandlers() {
  ipcMain.handle('settings:get', () => {
    const settings = readSettings();
    const apiKey = decryptKey(settings.encryptedKey);
    return {
      provider: settings.provider,
      model: settings.model,
      hasApiKey: !!apiKey,
      providers: PROVIDERS,
    };
  });

  ipcMain.handle('settings:set', (_event, data: { provider: string; model: string; apiKey?: string }) => {
    const current = readSettings();
    let encryptedKey = current.encryptedKey;

    if (data.apiKey !== undefined) {
      encryptedKey = encryptKey(data.apiKey);
    }

    writeSettings({
      provider: data.provider,
      model: data.model,
      encryptedKey,
    });

    return { success: true };
  });

  ipcMain.handle('settings:summarize', async (_event, changes: { type: string; name: string }[]) => {
    const settings = readSettings();
    const apiKey = decryptKey(settings.encryptedKey);
    if (!apiKey) return { error: 'No API key configured. Add one in Settings.' };

    const prompt = `Summarize what happened in this coding session based on these file changes. Be concise (1-2 sentences), friendly, and use plain English. Focus on what was accomplished, not individual file names.\n\nChanges:\n${changes.map(c => `- ${c.name}: ${c.type}`).join('\n')}`;

    try {
      if (settings.provider === 'anthropic') {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: settings.model,
            max_tokens: 200,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const data: any = await response.json();
        if (data.content?.[0]?.text) return { summary: data.content[0].text };
        return { error: data.error?.message || 'API error' };
      } else if (settings.provider === 'openai') {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: settings.model,
            max_tokens: 200,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const data: any = await response.json();
        if (data.choices?.[0]?.message?.content) return { summary: data.choices[0].message.content };
        return { error: data.error?.message || 'API error' };
      }
      return { error: 'Unknown provider' };
    } catch (err: any) {
      return { error: err.message || 'API call failed' };
    }
  });
}
