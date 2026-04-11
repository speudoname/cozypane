import React, { useRef, useEffect, useState, useCallback } from 'react';
import { shellEscape } from '../lib/shellUtils';

interface SlashCommand {
  cmd: string;
  desc: string;
}

interface Props {
  onSubmit: (command: string) => void;
  onRawKey?: (data: string) => void;
  visible: boolean;
  history: string[];
  onFocus?: () => void;
  isFocused?: boolean;
  showSlashCommands?: boolean;
  dynamicSlashCommands?: SlashCommand[];
  terminalId?: string;
  isChoicePrompt?: boolean;
  focusTick?: number;
  onTextChange?: (text: string) => void;
  fontSize?: number;
}


const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);

function getFileExt(name: string): string {
  return name.split('.').pop()?.toLowerCase() || '';
}

function isImageFile(name: string): boolean {
  return IMAGE_EXTS.has(getFileExt(name));
}

export default function CommandInput({ onSubmit, onRawKey, visible, history, onFocus, isFocused, showSlashCommands, dynamicSlashCommands, terminalId, isChoicePrompt, focusTick, onTextChange, fontSize }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedDraft, setSavedDraft] = useState('');
  const SLASH_COMMANDS = dynamicSlashCommands || [];
  const [suggestions, setSuggestions] = useState<SlashCommand[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [attachedPaths, setAttachedPaths] = useState<string[]>([]);

  // Insert path(s) at cursor position in textarea
  const insertPaths = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    const escaped = paths.map(p => shellEscape(p)).join(' ');
    setValue(prev => prev ? prev + ' ' + escaped : escaped);
    setAttachedPaths(prev => [...prev, ...paths]);
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (visible && isFocused && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [visible, isFocused]);

  // Re-focus textarea on tab switch (focusTick increments when tab becomes visible)
  useEffect(() => {
    if (focusTick && visible && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [focusTick, visible]);

  // Listen for file drops forwarded from terminal area (scoped to this terminal)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      // Support both old format (string[]) and new format ({ paths, terminalId })
      const paths: string[] = Array.isArray(detail) ? detail : detail?.paths;
      const dropTerminalId: string | undefined = Array.isArray(detail) ? undefined : detail?.terminalId;
      // Only handle drops targeted at this terminal (or unscoped drops)
      if (dropTerminalId && terminalId && dropTerminalId !== terminalId) return;
      if (paths && paths.length > 0) insertPaths(paths);
    };
    window.addEventListener('cozyPane:fileDrop', handler);
    return () => window.removeEventListener('cozyPane:fileDrop', handler);
  }, [insertPaths, terminalId]);

  // Sync inputTextRef for all setValue calls (H1: stale inputTextRef fix)
  useEffect(() => {
    onTextChange?.(value);
  }, [value, onTextChange]);

  // Auto-resize textarea — max ~10 lines then scroll
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const maxH = 200;
    const sh = ta.scrollHeight;
    ta.style.height = Math.min(sh, maxH) + 'px';
    ta.style.overflowY = sh > maxH ? 'auto' : 'hidden';
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

  // File picker via + button
  const handlePickFile = useCallback(async () => {
    const result = await window.cozyPane.fs.pickFile();
    if (result.paths.length > 0) {
      insertPaths(result.paths);
    }
  }, [insertPaths]);

  // Handle paste — intercept clipboard images and file copies
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    // Check for pasted files (e.g. images from clipboard)
    const items = e.clipboardData.items;
    let hasImage = false;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        hasImage = true;
        break;
      }
    }

    if (hasImage) {
      e.preventDefault();
      // Save clipboard image to temp file and insert path
      const result = await window.cozyPane.fs.saveClipboardImage();
      if (result.path) {
        insertPaths([result.path]);
      }
      return;
    }

    // Check for copied files (Cmd+C on files in Finder)
    try {
      const result = await window.cozyPane.fs.clipboardFilePaths();
      if (result.paths.length > 0) {
        e.preventDefault();
        insertPaths(result.paths);
        return;
      }
    } catch {
      // Fall through to normal paste
    }

    // Otherwise let normal text paste happen
  }, [insertPaths]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Choice prompt passthrough: when input is empty and terminal shows numbered choices,
    // forward number keys, arrow keys, and Enter directly to terminal
    if (isChoicePrompt && value === '' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        onRawKey?.(e.key);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        onRawKey?.('\x1b[A');
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        onRawKey?.('\x1b[B');
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onRawKey?.('\r');
        return;
      }
    }

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

    // Escape (no suggestions open) — clear input first, then forward ESC on second press
    if (e.key === 'Escape') {
      e.preventDefault();
      if (value !== '') {
        setValue('');
      } else {
        onRawKey?.('\x1b');
      }
      return;
    }

    // Enter = submit
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Intercept /deploy command — open deploy panel instead of sending to PTY
      if (value.trim() === '/deploy' || value.trim().startsWith('/deploy ')) {
        window.dispatchEvent(new CustomEvent('cozyPane:deploy'));
        setValue('');
        setAttachedPaths([]);
        setHistoryIndex(-1);
        setSavedDraft('');
        return;
      }
      onSubmit(value);
      setValue('');
      setAttachedPaths([]);
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

    // Ctrl+C — but let native copy happen if text is selected
    if (e.key === 'c' && e.ctrlKey) {
      const textarea = textareaRef.current;
      const hasSelection = textarea && textarea.selectionStart !== textarea.selectionEnd;
      if (hasSelection) {
        // Let native copy happen
        return;
      }
      if (value === '') {
        onSubmit('\x03');
      } else {
        setValue('');
        setHistoryIndex(-1);
      }
      e.preventDefault();
    }

    // Shift+Tab — forward to terminal (e.g. Claude Code mode switch)
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      onRawKey?.('\x1b[Z');
      return;
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
  }, [value, onSubmit, onRawKey, history, historyIndex, savedDraft, suggestions, selectedSuggestion, applySuggestion, isChoicePrompt]);

  const removeAttached = useCallback((pathToRemove: string) => {
    setAttachedPaths(prev => prev.filter(p => p !== pathToRemove));
    setValue(prev => {
      // Remove the path from the value text
      return prev.replace(pathToRemove, '').replace(/  +/g, ' ').trim();
    });
  }, []);

  if (!visible) return null;

  return (
    <div className={`command-input-container ${dragOver ? 'drag-over' : ''}`}>
      <button
        className="command-input-attach"
        onClick={handlePickFile}
        title="Attach file (inserts path)"
        aria-label="Attach file"
      >
        +
      </button>
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
        {attachedPaths.length > 0 && (
          <div className="attached-files">
            {attachedPaths.map((p, i) => {
              const name = p.split('/').pop() || p;
              const isImage = isImageFile(name);
              return (
                <span key={i} className={`attached-chip ${isImage ? 'image' : ''}`} title={p}>
                  <span className="attached-icon">{isImage ? '~' : '#'}</span>
                  <span className="attached-name">{name}</span>
                  <button
                    type="button"
                    className="attached-remove"
                    onClick={() => removeAttached(p)}
                    aria-label={`Remove ${name}`}
                  >x</button>
                </span>
              );
            })}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className={`command-input ${isFocused ? 'focused' : 'dimmed'} ${dragOver ? 'drag-over' : ''}`}
          style={fontSize ? { fontSize: `${fontSize}px` } : undefined}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            e.preventDefault();
            setDragOver(false);
            // Handle files dragged from Finder
            if (e.dataTransfer.files.length > 0) {
              const paths = Array.from(e.dataTransfer.files).map(f => window.cozyPane.getPathForFile(f)).filter(Boolean);
              if (paths.length > 0) {
                insertPaths(paths);
                return;
              }
            }
            // Handle text drag (e.g. from sidebar)
            const path = e.dataTransfer.getData('text/plain');
            if (path) {
              insertPaths([path]);
            }
          }}
          onPaste={handlePaste}
          value={value}
          onChange={e => {
            setValue(e.target.value);
            setHistoryIndex(-1);
          }}
          onKeyDown={handleKeyDown}
          onFocus={onFocus}
          role="textbox"
          aria-label="Command input"
          aria-multiline="true"
          placeholder={isChoicePrompt ? "Choice detected — press 1-9 or arrows to answer" : "Type a command... (/ for Claude commands)"}
          rows={1}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="command-input-hint">
          <span>Enter to run</span>
          {!value.includes('\n') && <span>Shift+Enter newline</span>}
        </div>
      </div>

      {dragOver && (
        <div className="drop-overlay">
          Drop file to add path
        </div>
      )}
    </div>
  );
}
