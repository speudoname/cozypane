import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Settings from './Settings';

const mockSettingsData: SettingsData = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  hasApiKey: false,
  providers: {
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
  },
  defaultProjectDir: '',
};

describe('Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window.cozyPane.settings.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockSettingsData);
    (window.cozyPane.settings.set as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    // Mock localStorage
    Storage.prototype.getItem = vi.fn().mockReturnValue('cozy-dark');
    Storage.prototype.setItem = vi.fn();
  });

  it('shows loading state initially', () => {
    // Delay the settings response
    (window.cozyPane.settings.get as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    render(<Settings />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders settings after loading', async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });
    expect(screen.getByText('Theme')).toBeInTheDocument();
    expect(screen.getByText('AI Commit Messages')).toBeInTheDocument();
    expect(screen.getByText('Security')).toBeInTheDocument();
  });

  it('renders all theme options', async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Cozy Dark')).toBeInTheDocument();
    expect(screen.getByLabelText('Ocean')).toBeInTheDocument();
    expect(screen.getByLabelText('Forest')).toBeInTheDocument();
    expect(screen.getByLabelText('Light')).toBeInTheDocument();
  });

  it('handles theme selection', async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    const oceanButton = screen.getByLabelText('Ocean');
    fireEvent.click(oceanButton);

    expect(localStorage.setItem).toHaveBeenCalledWith('cozyPane:theme', 'ocean');
    expect(document.documentElement.getAttribute('data-theme')).toBe('ocean');
  });

  it('renders provider select with correct options', async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    // The label and select aren't associated via htmlFor, so query by text + sibling
    expect(screen.getByText('Provider')).toBeInTheDocument();
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
  });

  it('renders API key input as password type', async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('sk-ant-...') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.type).toBe('password');
  });

  it('shows "configured" badge when API key exists', async () => {
    (window.cozyPane.settings.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockSettingsData,
      hasApiKey: true,
    });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('configured')).toBeInTheDocument();
    });
  });

  it('shows "Remove key" button when API key exists', async () => {
    (window.cozyPane.settings.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockSettingsData,
      hasApiKey: true,
    });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('Remove key')).toBeInTheDocument();
    });
  });

  it('shows format warning for anthropic key without sk-ant- prefix', async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('sk-ant-...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'wrong-prefix-key' } });

    await waitFor(() => {
      expect(screen.getByText(/Anthropic keys usually start with/)).toBeInTheDocument();
    });
  });

  it('has a Save Settings button', async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('Save Settings')).toBeInTheDocument();
    });
  });

  it('calls settings.set on save', async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Save Settings'));

    await waitFor(() => {
      expect(window.cozyPane.settings.set).toHaveBeenCalledWith({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
      });
    });
  });

  it('shows success message after saving', async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Save Settings'));

    await waitFor(() => {
      expect(screen.getByText('Settings saved!')).toBeInTheDocument();
    });
  });
});
