import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';

export interface PaletteAction {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  action: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
}

export default function CommandPalette({ open, onClose, actions }: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!query) return actions;
    const q = query.toLowerCase();
    return actions.filter(a =>
      a.label.toLowerCase().includes(q) || a.category.toLowerCase().includes(q)
    );
  }, [query, actions]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  const run = useCallback((action: PaletteAction) => {
    onClose();
    // Defer to avoid state conflicts
    setTimeout(() => action.action(), 0);
  }, [onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected(prev => Math.min(prev + 1, filtered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected(prev => Math.max(prev - 1, 0));
      return;
    }
    if (e.key === 'Enter' && filtered.length > 0) {
      e.preventDefault();
      run(filtered[selected]);
      return;
    }
  }, [filtered, selected, run, onClose]);

  if (!open) return null;

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a command..."
          spellCheck={false}
        />
        <div className="palette-results">
          {filtered.length === 0 && (
            <div className="palette-empty">No matching commands</div>
          )}
          {filtered.map((action, i) => (
            <div
              key={action.id}
              className={`palette-item ${i === selected ? 'selected' : ''}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => run(action)}
            >
              <span className="palette-category">{action.category}</span>
              <span className="palette-label">{action.label}</span>
              {action.shortcut && <span className="palette-shortcut">{action.shortcut}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
