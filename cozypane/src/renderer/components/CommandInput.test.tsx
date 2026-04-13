import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CommandInput from './CommandInput';

// Mock shellUtils
vi.mock('../lib/shellUtils', () => ({
  shellEscape: vi.fn((s: string) => s),
}));

describe('CommandInput', () => {
  const defaultProps = {
    onSubmit: vi.fn(),
    visible: true,
    history: [] as string[],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock the preload bridge methods used by CommandInput
    (window.cozyPane.fs.pickFile as ReturnType<typeof vi.fn>).mockResolvedValue({ paths: [] });
    (window.cozyPane.fs.getSlashCommands as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('renders the textarea', () => {
    render(<CommandInput {...defaultProps} />);
    const textarea = screen.getByRole('textbox', { name: 'Command input' });
    expect(textarea).toBeInTheDocument();
  });

  it('returns null when not visible', () => {
    const { container } = render(<CommandInput {...defaultProps} visible={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('submits on Enter key', () => {
    const onSubmit = vi.fn();
    render(<CommandInput {...defaultProps} onSubmit={onSubmit} />);
    const textarea = screen.getByRole('textbox', { name: 'Command input' });

    fireEvent.change(textarea, { target: { value: 'ls -la' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSubmit).toHaveBeenCalledWith('ls -la');
  });

  it('does not submit on Shift+Enter (allows newline)', () => {
    const onSubmit = vi.fn();
    render(<CommandInput {...defaultProps} onSubmit={onSubmit} />);
    const textarea = screen.getByRole('textbox', { name: 'Command input' });

    fireEvent.change(textarea, { target: { value: 'line1' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clears input after submission', () => {
    render(<CommandInput {...defaultProps} />);
    const textarea = screen.getByRole('textbox', { name: 'Command input' }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: 'npm test' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(textarea.value).toBe('');
  });

  it('shows hint text', () => {
    render(<CommandInput {...defaultProps} />);
    expect(screen.getByText('Enter to run')).toBeInTheDocument();
  });

  it('shows choice prompt placeholder when isChoicePrompt is true', () => {
    render(<CommandInput {...defaultProps} isChoicePrompt={true} />);
    const textarea = screen.getByRole('textbox', { name: 'Command input' });
    expect(textarea).toHaveAttribute('placeholder', expect.stringContaining('Choice detected'));
  });

  it('shows default placeholder when isChoicePrompt is false', () => {
    render(<CommandInput {...defaultProps} isChoicePrompt={false} />);
    const textarea = screen.getByRole('textbox', { name: 'Command input' });
    expect(textarea).toHaveAttribute('placeholder', expect.stringContaining('Type a command'));
  });

  it('sends Ctrl+C as signal character when input is empty', () => {
    const onSubmit = vi.fn();
    render(<CommandInput {...defaultProps} onSubmit={onSubmit} />);
    const textarea = screen.getByRole('textbox', { name: 'Command input' });

    fireEvent.keyDown(textarea, { key: 'c', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledWith('\x03');
  });

  it('clears input on Escape', () => {
    render(<CommandInput {...defaultProps} />);
    const textarea = screen.getByRole('textbox', { name: 'Command input' }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: 'some text' } });
    fireEvent.keyDown(textarea, { key: 'Escape' });

    expect(textarea.value).toBe('');
  });

  it('forwards Escape to onRawKey when input is already empty', () => {
    const onRawKey = vi.fn();
    render(<CommandInput {...defaultProps} onRawKey={onRawKey} />);
    const textarea = screen.getByRole('textbox', { name: 'Command input' });

    // First Escape clears (already empty), second should forward
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onRawKey).toHaveBeenCalledWith('\x1b');
  });

  it('has the attach button', () => {
    render(<CommandInput {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Attach file' })).toBeInTheDocument();
  });

  it('applies custom fontSize', () => {
    render(<CommandInput {...defaultProps} fontSize={16} />);
    const textarea = screen.getByRole('textbox', { name: 'Command input' });
    expect(textarea).toHaveStyle({ fontSize: '16px' });
  });
});
