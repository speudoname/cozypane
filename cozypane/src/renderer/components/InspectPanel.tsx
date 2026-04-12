import React, { useState } from 'react';

type InspectTab = 'console' | 'network' | 'devserver' | 'snapshot';

interface Props {
  consoleLogs: ConsoleLog[];
  networkRequests: NetworkRequest[];
  devServerState?: DevServerState;
  previewUrl: string | null;
  screenshotPath: string | null;
  screenshotTimestamp?: number;
  onRefreshSnapshot: () => void;
}

const LEVEL_LABELS = ['VERBOSE', 'INFO', 'WARN', 'ERROR'];
const LEVEL_COLORS = [
  'var(--text-muted, #666)',
  'var(--text-secondary, #aaa)',
  'var(--warning, #e6b800)',
  'var(--danger, #e74c3c)',
];

function statusColor(status: number): string {
  if (status >= 200 && status < 300) return 'var(--success, #5ce0a8)';
  if (status >= 300 && status < 400) return 'var(--info, #5cb8f0)';
  if (status >= 400 && status < 500) return 'var(--warning, #e6b800)';
  return 'var(--danger, #e74c3c)';
}

function errorTypeColor(type: string): string {
  switch (type) {
    case 'typescript': return 'var(--danger, #e74c3c)';
    case 'build': return 'var(--danger, #e74c3c)';
    case 'hmr': return 'var(--warning, #e6b800)';
    case 'runtime': return 'var(--danger, #e74c3c)';
    case 'warning': return 'var(--warning, #e6b800)';
    default: return 'var(--text-muted, #666)';
  }
}

export default function InspectPanel({ consoleLogs, networkRequests, devServerState, previewUrl, screenshotPath, screenshotTimestamp = 0, onRefreshSnapshot }: Props) {
  const [activeTab, setActiveTab] = useState<InspectTab>('console');
  const [consoleFilter, setConsoleFilter] = useState<number>(0); // min level

  return (
    <div className="inspect-panel">
      <div className="inspect-header">
        <div className="panel-tab-bar" style={{ borderBottom: 'none' }}>
          {(['console', 'network', 'devserver', 'snapshot'] as InspectTab[]).map(tab => (
            <button
              key={tab}
              className={`panel-tab ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'console' && `Console (${consoleLogs.length})`}
              {tab === 'network' && `Network (${networkRequests.length})`}
              {tab === 'devserver' && `Dev Server`}
              {tab === 'snapshot' && `Snapshot`}
            </button>
          ))}
        </div>
        {previewUrl && (
          <span className="inspect-url">{previewUrl}</span>
        )}
      </div>

      <div className="inspect-content">
        {activeTab === 'console' && (
          <div className="inspect-console">
            <div className="inspect-filter-bar">
              {[0, 1, 2, 3].map(level => (
                <button
                  key={level}
                  className={`inspect-filter-btn ${consoleFilter === level ? 'active' : ''}`}
                  onClick={() => setConsoleFilter(level)}
                  style={{ color: LEVEL_COLORS[level] }}
                >
                  {LEVEL_LABELS[level]}
                </button>
              ))}
            </div>
            <div className="inspect-log-list">
              {consoleLogs
                .filter(l => l.level >= consoleFilter)
                .slice(-200)
                .map((log, i) => (
                  <div key={i} className="inspect-log-entry" style={{ borderLeftColor: LEVEL_COLORS[log.level] }}>
                    <span className="inspect-log-level" style={{ color: LEVEL_COLORS[log.level] }}>
                      {LEVEL_LABELS[log.level] || 'LOG'}
                    </span>
                    <span className="inspect-log-msg">{log.message}</span>
                    {log.source && (
                      <span className="inspect-log-source">{log.source}{log.line ? `:${log.line}` : ''}</span>
                    )}
                  </div>
                ))}
              {consoleLogs.filter(l => l.level >= consoleFilter).length === 0 && (
                <div className="inspect-empty">No console output yet</div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'network' && (
          <div className="inspect-network">
            <div className="inspect-request-header">
              <span className="inspect-req-method">Method</span>
              <span className="inspect-req-url">URL</span>
              <span className="inspect-req-status">Status</span>
              <span className="inspect-req-duration">Time</span>
              <span className="inspect-req-size">Size</span>
            </div>
            <div className="inspect-log-list">
              {networkRequests.slice(-200).map((req, i) => (
                <div key={i} className={`inspect-request-row ${!req.ok ? 'inspect-request-error' : ''}`}>
                  <span className="inspect-req-method">{req.method}</span>
                  <span className="inspect-req-url" title={req.url}>
                    {req.url.replace(/^https?:\/\/[^/]+/, '')}
                  </span>
                  <span className="inspect-req-status">
                    <span className="inspect-status-badge" style={{ color: statusColor(req.status) }}>
                      {req.status || 'ERR'}
                    </span>
                  </span>
                  <span className="inspect-req-duration">{req.duration}ms</span>
                  <span className="inspect-req-size">{req.size ? `${(req.size / 1024).toFixed(1)}KB` : '-'}</span>
                </div>
              ))}
              {networkRequests.length === 0 && (
                <div className="inspect-empty">No network requests yet</div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'devserver' && (
          <div className="inspect-devserver">
            {devServerState ? (
              <>
                <div className="inspect-devserver-status">
                  <span
                    className="inspect-devserver-dot"
                    style={{ background: devServerState.status === 'running' ? 'var(--success, #5ce0a8)' : devServerState.status === 'error' ? 'var(--danger, #e74c3c)' : 'var(--warning, #e6b800)' }}
                  />
                  <span>{devServerState.status.toUpperCase()}</span>
                  {devServerState.url && <span className="inspect-devserver-url">{devServerState.url}</span>}
                </div>
                {devServerState.errorSummary && (
                  <div className="inspect-devserver-summary">{devServerState.errorSummary}</div>
                )}
                {devServerState.errors.length > 0 && (
                  <div className="inspect-devserver-errors">
                    {devServerState.errors.map((err, i) => (
                      <div key={i} className="inspect-log-entry" style={{ borderLeftColor: errorTypeColor(err.type) }}>
                        <span className="inspect-log-level" style={{ color: errorTypeColor(err.type) }}>
                          {err.type.toUpperCase()}
                        </span>
                        <span className="inspect-log-msg">{err.message}</span>
                        {err.file && <span className="inspect-log-source">{err.file}{err.line ? `:${err.line}` : ''}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {devServerState.recentOutput.length > 0 && (
                  <div className="inspect-terminal-output">
                    <div className="inspect-section-label">Recent Output</div>
                    <pre className="inspect-terminal-pre">
                      {devServerState.recentOutput.join('\n')}
                    </pre>
                  </div>
                )}
              </>
            ) : (
              <div className="inspect-empty">No dev server running</div>
            )}
          </div>
        )}

        {activeTab === 'snapshot' && (
          <div className="inspect-snapshot">
            <div className="inspect-snapshot-toolbar">
              <button className="inspect-snapshot-btn" onClick={onRefreshSnapshot}>
                Capture Screenshot
              </button>
            </div>
            {screenshotPath ? (
              <div className="inspect-snapshot-view">
                <img
                  src={`file://${screenshotPath}?t=${screenshotTimestamp}`}
                  alt="Preview screenshot"
                  className="inspect-screenshot-img"
                />
              </div>
            ) : (
              <div className="inspect-empty">No screenshot captured yet. Click "Capture Screenshot" or navigate in the preview.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
