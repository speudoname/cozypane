import React, { useState, useEffect } from 'react';

interface ProviderInfo {
  name: string;
  models: { id: string; name: string }[];
}

interface SettingsData {
  provider: string;
  model: string;
  hasApiKey: boolean;
  providers: Record<string, ProviderInfo>;
}

export default function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('claude-sonnet-4-20250514');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    window.cozyPane.settings.get().then((data: SettingsData) => {
      setSettings(data);
      setProvider(data.provider);
      setModel(data.model);
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
    await window.cozyPane.settings.set({ provider, model, apiKey: '' });
    const data = await window.cozyPane.settings.get();
    setSettings(data);
    setMessage({ type: 'success', text: 'API key removed' });
    setSaving(false);
  };

  if (!settings) return <div className="settings-panel"><div className="settings-loading">Loading...</div></div>;

  const currentModels = settings.providers[provider]?.models || [];

  return (
    <div className="settings-panel">
      <div className="settings-header">Settings</div>
      <div className="settings-body">
        <div className="settings-section">
          <div className="settings-section-title">AI Summaries</div>
          <p className="settings-description">
            Connect your own LLM API key to get plain English summaries of what Claude changed in your codebase.
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
            onChange={e => setApiKey(e.target.value)}
            placeholder={settings.hasApiKey ? 'Enter new key to replace' : 'Enter API key'}
          />
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
