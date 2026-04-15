import React, { useState } from 'react';

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
  const [checkState, setCheckState] = useState<'idle' | 'checking' | 'up-to-date' | 'update-available' | 'error'>('idle');
  const [checkMsg, setCheckMsg] = useState('');

  const runCheck = async () => {
    setCheckState('checking');
    setCheckMsg('');
    try {
      const res = await window.cozyPane.updates.checkApp();
      if (res.error) {
        setCheckState('error');
        setCheckMsg(res.error);
      } else if (res.upToDate) {
        setCheckState('up-to-date');
        setCheckMsg(`Up to date (v${res.current})`);
      } else {
        setCheckState('update-available');
        setCheckMsg(`Update ${res.latest} downloading...`);
      }
    } catch (err: any) {
      setCheckState('error');
      setCheckMsg(err?.message || 'Check failed');
    }
    // Clear status after 4s
    setTimeout(() => { setCheckState('idle'); setCheckMsg(''); }, 4000);
  };

  const checkLabel =
    checkState === 'checking' ? 'Checking...' :
    checkState === 'up-to-date' ? 'Up to date' :
    checkState === 'update-available' ? 'Update found' :
    checkState === 'error' ? 'Check failed' :
    'Check Updates';

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
      <button
        className="btn status-btn"
        onClick={runCheck}
        disabled={checkState === 'checking'}
        title={checkMsg || 'Check for app updates now'}
      >
        {checkLabel}
      </button>
      <div className="status-item">
        <span>CozyPane v{__APP_VERSION__}</span>
      </div>
    </div>
  );
}
