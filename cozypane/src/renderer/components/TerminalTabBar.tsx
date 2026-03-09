import React from 'react';
import type { AiAction, CostInfo } from '../lib/terminalAnalyzer';
import type { ConversationTurn } from './ConversationHistory';

export interface TerminalTab {
  id: string;
  ptyId: string | null;
  label: string;
  cwd: string;
  aiAction: AiAction;
  costInfo: CostInfo;
  conversationTurns: ConversationTurn[];
}

interface Props {
  tabs: TerminalTab[];
  activeId: string;
  splitId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  onToggleSplit: (id: string) => void;
}

export default function TerminalTabBar({ tabs, activeId, splitId, onSelect, onClose, onAdd, onToggleSplit }: Props) {
  return (
    <div className="terminal-tab-bar">
      {tabs.map(tab => {
        const isActive = tab.id === activeId;
        const isSplit = tab.id === splitId;
        const isRunning = tab.aiAction !== 'idle';
        return (
          <div
            key={tab.id}
            className={`terminal-tab ${isActive ? 'active' : ''} ${isSplit ? 'split' : ''}`}
            onClick={() => onSelect(tab.id)}
            onContextMenu={(e) => { e.preventDefault(); onToggleSplit(tab.id); }}
          >
            {isRunning && <span className="terminal-tab-dot" />}
            <span className="terminal-tab-label">{tab.label}</span>
            {tabs.length > 1 && (
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
    </div>
  );
}
