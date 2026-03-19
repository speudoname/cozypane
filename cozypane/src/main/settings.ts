import { ipcMain, app } from 'electron';
import path from 'path';
import fs from 'fs';
import { encryptString, decryptString } from './crypto';

interface StoredSettings {
  provider: string;
  model: string;
  encryptedKey: string;
  defaultProjectDir?: string;
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

// Use shared encrypt/decrypt from crypto.ts
const encryptKey = encryptString;
const decryptKey = decryptString;

export async function callLlm(prompt: string, maxTokens: number): Promise<{ text?: string; error?: string }> {
  const settings = readSettings();
  const apiKey = decryptKey(settings.encryptedKey);
  if (!apiKey) return { error: 'No API key configured. Add one in Settings.' };

  if (settings.provider === 'anthropic') {
    let response: Response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: settings.model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err: any) {
      return { error: err.message || 'Network error' };
    }
    if (!response.ok) return { error: `API error: ${response.status} ${response.statusText}` };
    let data: any;
    try { data = await response.json(); } catch { return { error: 'Invalid response from API' }; }
    if (data.content?.[0]?.text) return { text: data.content[0].text.trim() };
    return { error: data.error?.message || 'API error' };
  } else if (settings.provider === 'openai') {
    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: settings.model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err: any) {
      return { error: err.message || 'Network error' };
    }
    if (!response.ok) return { error: `API error: ${response.status} ${response.statusText}` };
    let data: any;
    try { data = await response.json(); } catch { return { error: 'Invalid response from API' }; }
    if (data.choices?.[0]?.message?.content) return { text: data.choices[0].message.content.trim() };
    return { error: data.error?.message || 'API error' };
  }
  return { error: 'Unknown provider' };
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
      defaultProjectDir: settings.defaultProjectDir || '',
    };
  });

  ipcMain.handle('settings:setDefaultDir', (_event, dir: string) => {
    try {
      const current = readSettings();
      current.defaultProjectDir = dir;
      writeSettings(current);
      return { success: true };
    } catch (err: any) {
      return { error: err.message || 'Failed to save default directory' };
    }
  });

  ipcMain.handle('settings:set', (_event, data: { provider: string; model: string; apiKey?: string }) => {
    try {
      // Validate provider
      if (!Object.keys(PROVIDERS).includes(data.provider)) {
        return { error: `Invalid provider: ${data.provider}` };
      }
      // Validate model belongs to the selected provider
      const providerModels = PROVIDERS[data.provider].models.map(m => m.id);
      if (!providerModels.includes(data.model)) {
        return { error: `Invalid model "${data.model}" for provider "${data.provider}"` };
      }

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
    } catch (err: any) {
      return { error: err.message || 'Failed to save settings' };
    }
  });

}
