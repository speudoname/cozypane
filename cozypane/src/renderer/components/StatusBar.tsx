import React from 'react';
import type { AiAction } from '../lib/terminalAnalyzer';

interface Props {
  cwd: string;
  layoutMode: string;
  onToggleLayout: () => void;
  panelsOpen: boolean;
  onTogglePanels: () => void;
  aiAction: AiAction;
  gitBranch?: string;
}

function getActionDisplay(action: AiAction) {
  switch (action) {
    case 'idle': return { label: 'Ready', dotClass: '' };
    case 'reading': return { label: 'Reading files', dotClass: 'info' };
    case 'writing': return { label: 'Editing files', dotClass: 'warning' };
    case 'executing': return { label: 'Running command', dotClass: 'error' };
    case 'thinking': return { label: 'Thinking...', dotClass: 'thinking' };
  }
}

export default function StatusBar({ cwd, layoutMode, onToggleLayout, panelsOpen, onTogglePanels, aiAction, gitBranch }: Props) {
  const { label, dotClass } = getActionDisplay(aiAction);

  return (
    <div className="status-bar">
      <div className="status-item">
        <span className={`status-dot ${dotClass}`} />
        <span>{label}</span>
      </div>
      <div className="status-item">
        <span>{cwd || '~'}</span>
      </div>
      {gitBranch && (
        <div className="status-item status-branch">
          <span>*</span>
          <span>{gitBranch}</span>
        </div>
      )}
      <div style={{ flex: 1 }} />
      <button className="btn status-btn" onClick={onTogglePanels} title="Toggle file panels">
        {panelsOpen ? 'Hide Panels' : 'Show Panels'}
      </button>
      {panelsOpen && (
        <button className="btn status-btn" onClick={onToggleLayout} title="Switch layout mode">
          {layoutMode === 'two-col' ? 'Split View' : 'Stacked View'}
        </button>
      )}
      <div className="status-item">
        <span>CozyPane v{__APP_VERSION__}</span>
      </div>
    </div>
  );
}
