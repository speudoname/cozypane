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

const DEFAULT_SETTINGS: StoredSettings = { provider: 'anthropic', model: 'claude-sonnet-4-20250514', encryptedKey: '' };
let cachedSettings: StoredSettings | null = null;

function readSettings(): StoredSettings {
  if (cachedSettings) return cachedSettings;
  try {
    const data = fs.readFileSync(getSettingsPath(), 'utf-8');
    cachedSettings = JSON.parse(data);
    return cachedSettings!;
  } catch {
    cachedSettings = { ...DEFAULT_SETTINGS };
    return cachedSettings;
  }
}

function writeSettings(settings: StoredSettings) {
  cachedSettings = settings;
  const dir = path.dirname(getSettingsPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Write async to avoid blocking the main process event loop
  fs.promises.writeFile(getSettingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 })
    .catch(err => console.error('[CozyPane] Failed to persist settings:', err));
}

export async function callLlm(prompt: string, maxTokens: number): Promise<{ text?: string; error?: string }> {
  const settings = readSettings();
  const apiKey = decryptString(settings.encryptedKey);
  if (!apiKey) return { error: 'No API key configured. Add one in Settings.' };

  // Provider adapters — both Anthropic and OpenAI speak JSON chat over HTTPS
  // with essentially the same shape. Previously this function had two
  // ~25-line structurally-identical branches. The table below is the only
  // place the two providers differ.
  interface Adapter {
    url: string;
    headers: (key: string) => Record<string, string>;
    body: (model: string, prompt: string, max: number) => Record<string, unknown>;
    extract: (data: any) => string | undefined;
  }
  const ADAPTERS: Record<string, Adapter> = {
    anthropic: {
      url: 'https://api.anthropic.com/v1/messages',
      headers: (k) => ({
        'Content-Type': 'application/json',
        'x-api-key': k,
        'anthropic-version': '2023-06-01',
      }),
      body: (model, prompt, max) => ({
        model,
        max_tokens: max,
        messages: [{ role: 'user', content: prompt }],
      }),
      extract: (d) => d?.content?.[0]?.text,
    },
    openai: {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: (k) => ({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${k}`,
      }),
      body: (model, prompt, max) => ({
        model,
        max_tokens: max,
        messages: [{ role: 'user', content: prompt }],
      }),
      extract: (d) => d?.choices?.[0]?.message?.content,
    },
  };

  const adapter = ADAPTERS[settings.provider];
  if (!adapter) return { error: 'Unknown provider' };

  let response: Response;
  try {
    response = await fetch(adapter.url, {
      method: 'POST',
      headers: adapter.headers(apiKey),
      body: JSON.stringify(adapter.body(settings.model, prompt, maxTokens)),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err: any) {
    return { error: err.message || 'Network error' };
  }
  if (!response.ok) return { error: `API error: ${response.status} ${response.statusText}` };
  let data: any;
  try { data = await response.json(); } catch { return { error: 'Invalid response from API' }; }
  const text = adapter.extract(data);
  if (text) return { text: text.trim() };
  return { error: data?.error?.message || 'API error' };
}

export function registerSettingsHandlers() {
  ipcMain.handle('settings:get', () => {
    const settings = readSettings();
    const apiKey = decryptString(settings.encryptedKey);
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
        try {
          encryptedKey = encryptString(data.apiKey);
        } catch (err: any) {
          // M8: no keyring — return a clean error rather than crashing.
          return { error: err.message || 'Credential store unavailable' };
        }
      }

      writeSettings({
        ...current,
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
