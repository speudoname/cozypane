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

  // Chat mode: format raw terminal output into clean markdown via LLM.
  // Always uses Haiku (fast, cheap) regardless of the user's model setting.
  ipcMain.handle('chat:format', async (_event, rawOutput: string) => {
    const settings = readSettings();
    const apiKey = decryptString(settings.encryptedKey);
    if (!apiKey) return { error: 'No API key' };

    const provider = settings.provider;
    // Pick the fastest/cheapest model for the provider
    const model = provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-4o-mini';

    const prompt = `You are a chat formatter. You receive raw terminal output from Claude Code (an AI coding CLI tool). Your job is to extract ONLY the assistant's actual response and reformat it as clean, well-structured markdown.

Rules:
- Extract only Claude's actual response text (the meaningful answer to the user's question)
- Remove ALL terminal UI elements: spinners, status bars, progress indicators, prompts, box drawing characters, ANSI remnants, model info, token counts, cost info
- Remove tool call headers (Read(), Edit(), Bash(), etc.) — just mention what was done briefly if relevant
- Keep code blocks, lists, and formatting that was part of the actual response
- If Claude edited files, briefly mention which files were changed
- If Claude ran commands, briefly mention the outcome
- Output clean markdown only — no explanations about what you're doing
- If the input is mostly noise with no real response, output just: "(no response yet)"

Raw terminal output:
\`\`\`
${rawOutput.slice(0, 8000)}
\`\`\`

Clean markdown response:`;

    // Build request directly using Haiku, bypassing callLlm which uses user's model
    const adapters: Record<string, any> = {
      anthropic: {
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: { model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] },
        extract: (d: any) => d?.content?.[0]?.text,
      },
      openai: {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: { model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] },
        extract: (d: any) => d?.choices?.[0]?.message?.content,
      },
    };
    const adapter = adapters[provider];
    if (!adapter) return { error: 'Unknown provider' };

    try {
      const res = await fetch(adapter.url, {
        method: 'POST',
        headers: adapter.headers,
        body: JSON.stringify(adapter.body),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) return { error: `API ${res.status}` };
      const data = await res.json();
      const text = adapter.extract(data);
      return text ? { text: text.trim() } : { error: 'Empty response' };
    } catch (err: any) {
      return { error: err.message || 'Format failed' };
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
