import React from 'react';

interface PreviewConsoleProps {
  errors: PreviewError[];
  consoleLogs: ConsoleLog[];
  networkErrors: NetworkError[];
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  consoleTab: 'errors' | 'all';
  onTabChange: (tab: 'errors' | 'all') => void;
  onClear: () => void;
  onFixWithClaude: () => void;
  sendingToClaude: boolean;
}

export default function PreviewConsole({
  errors,
  consoleLogs,
  drawerOpen,
  onToggleDrawer,
  consoleTab,
  onTabChange,
  onClear,
  onFixWithClaude,
  sendingToClaude,
}: PreviewConsoleProps) {
  return (
    <div style={{ borderTop: '1px solid var(--border, #2a2b3e)', backgroundColor: 'var(--bg-secondary, #161822)' }}>
      <div
        onClick={onToggleDrawer}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0.3em 0.6em', cursor: 'pointer', userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4em' }}>
          <span style={{ fontSize: '0.78em', color: 'var(--text-secondary, #888)' }}>
            {drawerOpen ? '\u25BC' : '\u25B6'} Console
          </span>
          {errors.length > 0 && (
            <span style={{
              fontSize: '0.7em', padding: '0 5px', borderRadius: 8,
              backgroundColor: 'color-mix(in srgb, var(--danger, #e74c3c) 20%, transparent)', color: 'var(--danger, #e74c3c)', fontWeight: 600,
            }}>
              {errors.length} error{errors.length !== 1 ? 's' : ''}
            </span>
          )}
          {consoleLogs.length > 0 && errors.length === 0 && (
            <span style={{
              fontSize: '0.7em', padding: '0 5px', borderRadius: 8,
              backgroundColor: 'var(--border, #2a2b3e)', color: 'var(--text-secondary, #888)', fontWeight: 600,
            }}>
              {consoleLogs.length}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '0.3em' }}>
          {errors.length > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); onFixWithClaude(); }}
              disabled={sendingToClaude}
              style={{ ...tinyBtnStyle, color: 'var(--accent, #7c6fe0)', fontWeight: 600 }}
            >
              Fix with Claude
            </button>
          )}
          {(errors.length > 0 || consoleLogs.length > 0) && (
            <button
              onClick={(e) => { e.stopPropagation(); onClear(); }}
              style={tinyBtnStyle}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {drawerOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 240 }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', gap: '0.2em', padding: '0.2em 0.6em 0', borderBottom: '1px solid var(--border, #1e1f32)' }}>
            {(['errors', 'all'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => onTabChange(tab)}
                style={{
                  padding: '0.15em 0.5em', fontSize: '0.72em', cursor: 'pointer', border: 'none',
                  borderBottom: consoleTab === tab ? '2px solid var(--accent, #7c6fe0)' : '2px solid transparent',
                  backgroundColor: 'transparent',
                  color: consoleTab === tab ? 'var(--text-primary, #e0e0e0)' : 'var(--text-secondary, #888)',
                  fontWeight: consoleTab === tab ? 600 : 400,
                }}
              >
                {tab === 'errors' ? `Errors (${errors.length})` : `All (${consoleLogs.length})`}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '0.2em 0.6em 0.4em' }}>
            {consoleTab === 'errors' ? (
              errors.length === 0 ? (
                <div style={{ fontSize: '0.78em', color: 'var(--text-secondary, #666)', padding: '0.5em 0' }}>No errors</div>
              ) : (
                errors.map((err, i) => (
                  <div key={i} style={{ padding: '0.25em 0', borderBottom: '1px solid var(--border, #1e1f32)', fontSize: '0.75em' }}>
                    <div style={{ display: 'flex', gap: '0.4em', alignItems: 'baseline' }}>
                      <span style={{ color: err.type === 'network' ? 'var(--warning, #e6b800)' : 'var(--danger, #e74c3c)', fontWeight: 600, fontSize: '0.9em', textTransform: 'uppercase', flexShrink: 0 }}>
                        {err.type}
                      </span>
                      <span style={{ color: 'var(--text-primary, #e0e0e0)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                        {err.message}
                      </span>
                    </div>
                    {err.detail && (
                      <div style={{ color: 'var(--text-secondary, #666)', fontSize: '0.9em', marginTop: '0.1em' }}>{err.detail}</div>
                    )}
                  </div>
                ))
              )
            ) : (
              consoleLogs.length === 0 ? (
                <div style={{ fontSize: '0.78em', color: 'var(--text-secondary, #666)', padding: '0.5em 0' }}>No console output</div>
              ) : (
                consoleLogs.map((log, i) => {
                  const levelColor = log.level === 3 ? 'var(--danger, #e74c3c)' : log.level === 2 ? 'var(--warning, #e6b800)' : log.level === 1 ? 'var(--info, #4fc3f7)' : 'var(--text-secondary, #888)';
                  const levelLabel = ['verbose', 'info', 'warn', 'error'][log.level] ?? 'log';
                  return (
                    <div key={i} style={{ padding: '0.2em 0', borderBottom: '1px solid var(--border, #1e1f32)', fontSize: '0.74em', display: 'flex', gap: '0.4em', alignItems: 'baseline' }}>
                      <span style={{ color: levelColor, fontWeight: 600, fontSize: '0.85em', textTransform: 'uppercase', flexShrink: 0, minWidth: '2.5em' }}>
                        {levelLabel}
                      </span>
                      <span style={{ color: 'var(--text-primary, #ccc)', fontFamily: 'monospace', wordBreak: 'break-all', flex: 1 }}>
                        {log.message}
                      </span>
                      {log.source && (
                        <span style={{ color: 'var(--text-secondary, #555)', fontSize: '0.85em', flexShrink: 0 }}>
                          {log.source.split('/').pop()}{log.line ? `:${log.line}` : ''}
                        </span>
                      )}
                    </div>
                  );
                })
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const tinyBtnStyle: React.CSSProperties = {
  padding: '2px 8px', borderRadius: 3,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'transparent',
  color: 'var(--text-secondary, #aaa)',
  fontSize: '0.75em', cursor: 'pointer',
};
