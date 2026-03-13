import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { AiAction, CostInfo } from '../lib/terminalAnalyzer';

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
  onReorder: (fromIndex: number, toIndex: number) => void;
  fontSize?: number;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
}

export default function TerminalTabBar({ tabs, activeId, splitId, onSelect, onClose, onAdd, onToggleSplit, onRename, onReorder, fontSize, onZoomIn, onZoomOut, onZoomReset }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dragIndexRef = useRef<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);

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
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeId;
        const isSplit = tab.id === splitId;
        const isRunning = tab.aiAction !== 'idle';
        const isEditing = editingId === tab.id;
        const isDropTarget = dropTargetIndex === index && dragIndexRef.current !== index;
        return (
          <div
            key={tab.id}
            className={`terminal-tab ${isActive ? 'active' : ''} ${isSplit ? 'split' : ''} ${isDropTarget ? 'drop-target' : ''}`}
            draggable={!isEditing}
            onClick={() => onSelect(tab.id)}
            onContextMenu={(e) => { e.preventDefault(); onToggleSplit(tab.id); }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditValue(tab.customLabel || '');
              setEditingId(tab.id);
            }}
            onDragStart={(e) => {
              dragIndexRef.current = index;
              e.dataTransfer.effectAllowed = 'move';
              // Make the drag ghost semi-transparent
              if (e.currentTarget instanceof HTMLElement) {
                e.currentTarget.style.opacity = '0.5';
              }
            }}
            onDragEnd={(e) => {
              dragIndexRef.current = null;
              setDropTargetIndex(null);
              if (e.currentTarget instanceof HTMLElement) {
                e.currentTarget.style.opacity = '';
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDropTargetIndex(index);
            }}
            onDragLeave={() => {
              setDropTargetIndex(prev => prev === index ? null : prev);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragIndexRef.current;
              if (from !== null && from !== index) {
                onReorder(from, index);
              }
              dragIndexRef.current = null;
              setDropTargetIndex(null);
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
