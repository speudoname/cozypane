import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { AiAction, CostInfo } from '../lib/terminalAnalyzer';
import type { ConversationTurn } from './ConversationHistory';

export interface TerminalTab {
  id: string;
  ptyId: string | null;
  label: string;
  customLabel?: string;
  cwd: string;
  aiAction: AiAction;
  costInfo: CostInfo;
  conversationTurns: ConversationTurn[];
}

function getDisplayLabel(tab: TerminalTab): string {
  if (tab.customLabel) return tab.customLabel;
  if (tab.cwd) {
    const parts = tab.cwd.split('/');
    return parts[parts.length - 1] || tab.cwd;
  }
  return tab.label;
}

interface Props {
  tabs: TerminalTab[];
  activeId: string;
  splitId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  onToggleSplit: (id: string) => void;
  onRename: (id: string, name: string) => void;
  fontSize?: number;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
}

export default function TerminalTabBar({ tabs, activeId, splitId, onSelect, onClose, onAdd, onToggleSplit, onRename, fontSize, onZoomIn, onZoomOut, onZoomReset }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const commitRename = useCallback(() => {
    if (editingId) {
      onRename(editingId, editValue.trim());
      setEditingId(null);
    }
  }, [editingId, editValue, onRename]);

  return (
    <div className="terminal-tab-bar">
      {tabs.map(tab => {
        const isActive = tab.id === activeId;
        const isSplit = tab.id === splitId;
        const isRunning = tab.aiAction !== 'idle';
        const isEditing = editingId === tab.id;
        return (
          <div
            key={tab.id}
            className={`terminal-tab ${isActive ? 'active' : ''} ${isSplit ? 'split' : ''}`}
            onClick={() => onSelect(tab.id)}
            onContextMenu={(e) => { e.preventDefault(); onToggleSplit(tab.id); }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditValue(tab.customLabel || '');
              setEditingId(tab.id);
            }}
          >
            {isRunning && <span className="terminal-tab-dot" />}
            {isEditing ? (
              <input
                ref={inputRef}
                className="terminal-tab-rename"
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditingId(null);
                }}
                onClick={e => e.stopPropagation()}
                placeholder={getDisplayLabel(tab)}
                spellCheck={false}
              />
            ) : (
              <span className="terminal-tab-label" title={tab.cwd}>{getDisplayLabel(tab)}</span>
            )}
            {tabs.length > 1 && !isEditing && (
              <span
                className="terminal-tab-close"
                onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
              >
                x
              </span>
            )}
          </div>
        );
      })}
      <button className="terminal-tab-add" onClick={onAdd} title="New terminal (Cmd+T)">+</button>
      {onZoomIn && onZoomOut && (
        <div className="zoom-controls">
          <button className="zoom-btn" onClick={onZoomOut} title="Zoom out (Cmd+-)">−</button>
          <button className="zoom-label" onClick={onZoomReset} title="Reset zoom (Cmd+0)">{fontSize ?? 13}px</button>
          <button className="zoom-btn" onClick={onZoomIn} title="Zoom in (Cmd+=)">+</button>
        </div>
      )}
    </div>
  );
}
