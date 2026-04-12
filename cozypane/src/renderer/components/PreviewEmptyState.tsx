import React from 'react';

interface PreviewEmptyStateProps {
  viewMode: 'local' | 'production' | 'split';
  staticError: string | null;
  projectInfo: { type: string | null; devCommand: string | null } | null;
  suggestedPort: number | null;
  startingDev: boolean;
  onStartDevServer: () => void;
  manualUrlInput: string;
  onManualUrlInputChange: (value: string) => void;
  onManualUrlSubmit: () => void;
}

export default function PreviewEmptyState({
  viewMode,
  staticError,
  projectInfo,
  suggestedPort,
  startingDev,
  onStartDevServer,
  manualUrlInput,
  onManualUrlInputChange,
  onManualUrlSubmit,
}: PreviewEmptyStateProps) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', color: 'var(--text-secondary, #888)', gap: '1em', padding: '2em',
    }}>
      {staticError && (
        <div style={{
          fontSize: '0.82em', color: 'var(--danger, #f06c7e)', textAlign: 'center', maxWidth: 380,
          background: 'rgba(240, 108, 126, 0.1)', padding: '0.6em 1em', borderRadius: 6,
        }}>
          {staticError}
        </div>
      )}
      {viewMode === 'production' ? (
        <>
          <div style={{ fontSize: '1.1em', color: 'var(--text-primary, #e0e0e0)', textAlign: 'center' }}>
            No production URL
          </div>
          <div style={{ fontSize: '0.82em', color: 'var(--text-secondary, #888)', textAlign: 'center', maxWidth: 380 }}>
            Deploy your project to see the production preview, or enter a URL below.
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: '1.1em', color: 'var(--text-primary, #e0e0e0)', textAlign: 'center' }}>
            No dev server running
          </div>
          {projectInfo?.devCommand ? (
            <>
              <div style={{ fontSize: '0.82em', color: 'var(--text-secondary, #888)', textAlign: 'center', maxWidth: 380 }}>
                Detected <span style={{ color: 'var(--accent, #7c6fe0)', fontWeight: 600 }}>{projectInfo.type}</span> project
                {suggestedPort ? <> — port <span style={{ color: 'var(--text-primary, #e0e0e0)', fontWeight: 600 }}>{suggestedPort}</span> is available</> : null}
              </div>
              <button
                onClick={onStartDevServer}
                disabled={startingDev}
                style={{
                  padding: '10px 24px', borderRadius: 8, border: 'none',
                  backgroundColor: 'var(--accent, #7c6fe0)', color: '#fff',
                  fontSize: '0.9em', fontWeight: 600, cursor: startingDev ? 'wait' : 'pointer',
                  opacity: startingDev ? 0.7 : 1, marginTop: '0.3em',
                }}
              >
                {startingDev ? 'Starting...' : `Start Dev Server`}
              </button>
              <div style={{ fontSize: '0.72em', color: 'var(--text-muted, #666)', fontFamily: 'var(--font-mono)' }}>
                {projectInfo.devCommand}{suggestedPort ? ` (port ${suggestedPort})` : ''}
              </div>
            </>
          ) : (
            <div style={{ fontSize: '0.82em', color: 'var(--text-secondary, #888)', textAlign: 'center', maxWidth: 380 }}>
              Run your dev server in the terminal — preview will auto-connect when it starts.
            </div>
          )}
        </>
      )}
      <div style={{ display: 'flex', gap: '0.3em', width: '100%', maxWidth: 400, marginTop: '0.5em' }}>
        <input
          type="text"
          value={manualUrlInput}
          onChange={e => onManualUrlInputChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && manualUrlInput.trim()) {
              onManualUrlSubmit();
            }
          }}
          placeholder={viewMode === 'production' ? 'https://yourapp.com' : 'http://localhost:3000'}
          spellCheck={false}
          style={urlInputStyle}
        />
      </div>
    </div>
  );
}

const urlInputStyle: React.CSSProperties = {
  flex: 1, padding: '0.3em 0.6em', borderRadius: 4,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'var(--bg-primary, #1a1b2e)',
  color: 'var(--text-primary, #e0e0e0)',
  fontSize: '0.82em', fontFamily: 'inherit', outline: 'none',
};
