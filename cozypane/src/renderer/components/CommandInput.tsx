import React, { useRef, useEffect, useState, useCallback } from 'react';

interface SlashCommand {
  cmd: string;
  desc: string;
}

interface Props {
  onSubmit: (command: string) => void;
  visible: boolean;
  history: string[];
  onFocus?: () => void;
  isFocused?: boolean;
  showSlashCommands?: boolean;
  dynamicSlashCommands?: SlashCommand[];
}

// Fallback slash commands
const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
  { cmd: '/help', desc: 'Show help and available commands' },
  { cmd: '/clear', desc: 'Clear conversation history' },
  { cmd: '/compact', desc: 'Compact conversation to save context' },
  { cmd: '/config', desc: 'View or modify configuration' },
  { cmd: '/cost', desc: 'Show token usage and cost' },
  { cmd: '/doctor', desc: 'Check Claude Code health' },
  { cmd: '/init', desc: 'Initialize project with CLAUDE.md' },
  { cmd: '/login', desc: 'Switch accounts or login' },
  { cmd: '/logout', desc: 'Sign out of current session' },
  { cmd: '/memory', desc: 'Edit CLAUDE.md memory file' },
  { cmd: '/model', desc: 'Switch AI model' },
  { cmd: '/permissions', desc: 'View or modify permissions' },
  { cmd: '/review', desc: 'Review a pull request' },
  { cmd: '/status', desc: 'Show current status' },
  { cmd: '/terminal-setup', desc: 'Install shell integration' },
  { cmd: '/vim', desc: 'Enter vim mode for editing' },
];

export default function CommandInput({ onSubmit, visible, history, onFocus, isFocused, showSlashCommands, dynamicSlashCommands }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedDraft, setSavedDraft] = useState('');
  const SLASH_COMMANDS = dynamicSlashCommands && dynamicSlashCommands.length > 0 ? dynamicSlashCommands : DEFAULT_SLASH_COMMANDS;
  const [suggestions, setSuggestions] = useState<SlashCommand[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (visible && isFocused && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [visible, isFocused]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      textareaRef.current.style.height = Math.min(scrollHeight, 200) + 'px';
    }
  }, [value]);

  // Update slash command suggestions
  useEffect(() => {
    if (showSlashCommands && value.startsWith('/') && !value.includes(' ')) {
      const query = value.toLowerCase();
      const matches = SLASH_COMMANDS.filter(s => s.cmd.startsWith(query));
      setSuggestions(matches);
      setSelectedSuggestion(0);
    } else {
      setSuggestions([]);
    }
  }, [value, showSlashCommands]);

  const applySuggestion = useCallback((cmd: string) => {
    setValue(cmd + ' ');
    setSuggestions([]);
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // If suggestions visible, handle navigation
    if (suggestions.length > 0) {
      if (e.key === 'Tab' || (e.key === 'ArrowDown' && suggestions.length > 0)) {
        e.preventDefault();
        setSelectedSuggestion(prev => (prev + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp' && suggestions.length > 0) {
        e.preventDefault();
        setSelectedSuggestion(prev => (prev - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && suggestions.length > 0 && value !== suggestions[selectedSuggestion]?.cmd) {
        e.preventDefault();
        applySuggestion(suggestions[selectedSuggestion].cmd);
        return;
      }
      if (e.key === 'Escape') {
        setSuggestions([]);
        return;
      }
    }

    // Enter = submit
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit(value);
      setValue('');
      setHistoryIndex(-1);
      setSavedDraft('');
      return;
    }

    // Up arrow at first line = history
    if (e.key === 'ArrowUp' && suggestions.length === 0) {
      const textarea = textareaRef.current;
      if (textarea) {
        const beforeCursor = value.substring(0, textarea.selectionStart);
        const isFirstLine = !beforeCursor.includes('\n');
        if (isFirstLine && history.length > 0) {
          e.preventDefault();
          const newIndex = historyIndex + 1;
          if (newIndex < history.length) {
            if (historyIndex === -1) setSavedDraft(value);
            setHistoryIndex(newIndex);
            setValue(history[newIndex]);
          }
        }
      }
    }

    // Down arrow at last line = history forward
    if (e.key === 'ArrowDown' && suggestions.length === 0) {
      const textarea = textareaRef.current;
      if (textarea) {
        const afterCursor = value.substring(textarea.selectionEnd);
        const isLastLine = !afterCursor.includes('\n');
        if (isLastLine && historyIndex >= 0) {
          e.preventDefault();
          const newIndex = historyIndex - 1;
          if (newIndex < 0) {
            setHistoryIndex(-1);
            setValue(savedDraft);
          } else {
            setHistoryIndex(newIndex);
            setValue(history[newIndex]);
          }
        }
      }
    }

    // Ctrl+C
    if (e.key === 'c' && e.ctrlKey) {
      if (value === '') {
        onSubmit('\x03');
      } else {
        setValue('');
        setHistoryIndex(-1);
      }
      e.preventDefault();
    }

    // Tab (when no suggestions) = insert spaces
    if (e.key === 'Tab' && suggestions.length === 0) {
      e.preventDefault();
      const textarea = textareaRef.current;
      if (textarea) {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const newValue = value.substring(0, start) + '  ' + value.substring(end);
        setValue(newValue);
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 2;
        }, 0);
      }
    }
  }, [value, onSubmit, history, historyIndex, savedDraft, suggestions, selectedSuggestion, applySuggestion]);

  if (!visible) return null;

  return (
    <div className="command-input-container">
      <div className="command-input-prompt">$</div>
      <div className="command-input-wrapper">
        {suggestions.length > 0 && (
          <div className="slash-suggestions">
            {suggestions.map((s, i) => (
              <div
                key={s.cmd}
                className={`slash-suggestion ${i === selectedSuggestion ? 'active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); applySuggestion(s.cmd); }}
              >
                <span className="slash-cmd">{s.cmd}</span>
                <span className="slash-desc">{s.desc}</span>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className={`command-input ${isFocused ? 'focused' : 'dimmed'} ${dragOver ? 'drag-over' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            e.preventDefault();
            setDragOver(false);
            const path = e.dataTransfer.getData('text/plain');
            if (path) {
              setValue(prev => prev ? prev + ' ' + path : path);
              textareaRef.current?.focus();
            }
          }}
          value={value}
          onChange={e => {
            setValue(e.target.value);
            setHistoryIndex(-1);
          }}
          onKeyDown={handleKeyDown}
          onFocus={onFocus}
          aria-label="Command input"
          placeholder="Type a command... (/ for Claude commands)"
          rows={1}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
      </div>
      <div className="command-input-hint">
        <span>Enter to run</span>
        <span>Shift+Enter newline</span>
      </div>
    </div>
  );
}
