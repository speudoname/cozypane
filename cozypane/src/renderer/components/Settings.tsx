import React, { useState, useEffect } from 'react';

const THEMES = [
  { id: 'cozy-dark', name: 'Cozy Dark', bg: '#1a1b2e', fg: '#e4e4f0' },
  { id: 'ocean', name: 'Ocean', bg: '#0d1b2a', fg: '#e0e8f0' },
  { id: 'forest', name: 'Forest', bg: '#1a2318', fg: '#e0edd8' },
  { id: 'cozy-light', name: 'Light', bg: '#f5f3f0', fg: '#2c2a28' },
];

export default function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('claude-sonnet-4-20250514');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [defaultDir, setDefaultDir] = useState('');
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('cozyPane:theme') || 'cozy-dark'; } catch { return 'cozy-dark'; }
  });

  const handleThemeChange = (themeId: string) => {
    setTheme(themeId);
    document.documentElement.setAttribute('data-theme', themeId);
    try { localStorage.setItem('cozyPane:theme', themeId); } catch {}
    // Dispatch event so Terminal can update xterm theme
    window.dispatchEvent(new CustomEvent('cozyPane:themeChange', { detail: themeId }));
  };

  useEffect(() => {
    window.cozyPane.settings.get().then((data: SettingsData) => {
      setSettings(data);
      setProvider(data.provider);
      setModel(data.model);
      setDefaultDir(data.defaultProjectDir || '');
    }).catch(() => {
      setMessage({ type: 'error', text: 'Failed to load settings' });
    });
  }, []);

  const handleProviderChange = (newProvider: string) => {
    setProvider(newProvider);
    if (settings?.providers[newProvider]) {
      setModel(settings.providers[newProvider].models[0].id);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const payload: { provider: string; model: string; apiKey?: string } = { provider, model };
      if (apiKey) payload.apiKey = apiKey;
      await window.cozyPane.settings.set(payload);
      setApiKey('');
      setMessage({ type: 'success', text: 'Settings saved!' });
      // Refresh to update hasApiKey
      const data = await window.cozyPane.settings.get();
      setSettings(data);
    } catch {
      setMessage({ type: 'error', text: 'Failed to save settings' });
    }
    setSaving(false);
  };

  const handleClearKey = async () => {
    setSaving(true);
    try {
      await window.cozyPane.settings.set({ provider, model, apiKey: '' });
      const data = await window.cozyPane.settings.get();
      setSettings(data);
      setMessage({ type: 'success', text: 'API key removed' });
    } catch {
      setMessage({ type: 'error', text: 'Failed to clear API key' });
    }
    setSaving(false);
  };

  if (!settings) return <div className="settings-panel"><div className="settings-loading">Loading...</div></div>;

  const currentModels = settings.providers[provider]?.models || [];

  return (
    <div className="settings-panel">
      <div className="settings-header">Settings</div>
      <div className="settings-body">
        <div className="settings-section">
          <div className="settings-section-title">Theme</div>
          <div className="theme-picker">
            {THEMES.map(t => (
              <button
                key={t.id}
                className={`theme-swatch ${theme === t.id ? 'active' : ''}`}
                style={{ background: t.bg, color: t.fg }}
                onClick={() => handleThemeChange(t.id)}
                title={t.name}
                aria-pressed={theme === t.id}
                aria-label={t.name}
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Default Project Folder</div>
          <p className="settings-description">
            New projects will be created in this folder by default.
          </p>
          <div style={{ display: 'flex', gap: '0.5em', alignItems: 'center', marginTop: '0.5em' }}>
            <span className="settings-description" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
              {defaultDir || 'Not set (uses home directory)'}
            </span>
            <button className="btn settings-clear-btn" onClick={async () => {
              const result = await window.cozyPane.fs.pickDirectory();
              if (result.paths?.[0]) {
                setDefaultDir(result.paths[0]);
                await window.cozyPane.settings.setDefaultDir(result.paths[0]);
                setMessage({ type: 'success', text: 'Default folder updated' });
              }
            }}>
              Browse
            </button>
            {defaultDir && (
              <button className="btn settings-clear-btn" onClick={async () => {
                setDefaultDir('');
                await window.cozyPane.settings.setDefaultDir('');
                setMessage({ type: 'success', text: 'Default folder cleared' });
              }}>
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">AI Commit Messages</div>
          <p className="settings-description">
            Connect your own LLM API key to generate commit messages in the Git panel.
          </p>
        </div>

        <div className="settings-field">
          <label className="settings-label">Provider</label>
          <select
            className="settings-select"
            value={provider}
            onChange={e => handleProviderChange(e.target.value)}
          >
            {Object.entries(settings.providers).map(([key, info]) => (
              <option key={key} value={key}>{info.name}</option>
            ))}
          </select>
        </div>

        <div className="settings-field">
          <label className="settings-label">Model</label>
          <select
            className="settings-select"
            value={model}
            onChange={e => setModel(e.target.value)}
          >
            {currentModels.map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>

        <div className="settings-field">
          <label className="settings-label">
            API Key
            {settings.hasApiKey && <span className="settings-key-badge">configured</span>}
          </label>
          <input
            type="password"
            className="settings-input"
            value={apiKey}
            // L25: trim whitespace on paste — copy/pasted keys often come
            // with a trailing newline which silently breaks auth. Show a
            // provider-specific format hint in the placeholder.
            onChange={e => setApiKey(e.target.value.trim())}
            placeholder={
              settings.hasApiKey
                ? 'Enter new key to replace'
                : settings.provider === 'anthropic'
                  ? 'sk-ant-...'
                  : settings.provider === 'openai'
                    ? 'sk-...'
                    : 'Enter API key'
            }
          />
          {apiKey && settings.provider === 'anthropic' && !apiKey.startsWith('sk-ant-') && (
            <div className="settings-hint" style={{ color: 'var(--warning)', fontSize: 11, marginTop: 4 }}>
              Anthropic keys usually start with <code>sk-ant-</code>
            </div>
          )}
          {apiKey && settings.provider === 'openai' && !apiKey.startsWith('sk-') && (
            <div className="settings-hint" style={{ color: 'var(--warning)', fontSize: 11, marginTop: 4 }}>
              OpenAI keys usually start with <code>sk-</code>
            </div>
          )}
          {settings.hasApiKey && (
            <button className="btn settings-clear-btn" onClick={handleClearKey} disabled={saving}>
              Remove key
            </button>
          )}
        </div>

        <div className="settings-actions">
          <button className="btn settings-save-btn" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>

        {message && (
          <div className={`settings-message ${message.type}`}>
            {message.text}
          </div>
        )}

        <div className="settings-section">
          <div className="settings-section-title">Security</div>
          <p className="settings-description">
            API keys are encrypted using your operating system's secure storage (Keychain on macOS, DPAPI on Windows). Keys never leave your machine except when making API calls.
          </p>
        </div>
      </div>
    </div>
  );
}
