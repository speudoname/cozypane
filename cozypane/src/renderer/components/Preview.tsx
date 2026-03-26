import React, { useState, useRef, useCallback, useEffect } from 'react';

interface PreviewError {
  type: 'console' | 'network' | 'load';
  message: string;
  timestamp: number;
  detail?: string;
}

interface ConsoleLog {
  level: number;
  message: string;
  timestamp: number;
  source?: string;
  line?: number;
}

interface NetworkError {
  method: string;
  url: string;
  status: number;
  statusText: string;
  timestamp: number;
}

interface Props {
  localUrl?: string;
  localUrls?: string[];
  productionUrl?: string;
  cwd: string;
  onSendToTerminal: (command: string) => void;
  deployments?: Deployment[];
  claudeRunning?: boolean;
}

type DeviceMode = 'desktop' | 'tablet' | 'phone';
type ViewMode = 'local' | 'production' | 'split';

const DEVICE_WIDTHS: Record<DeviceMode, number | null> = {
  desktop: null,
  tablet: 768,
  phone: 375,
};

const LEVEL_LABELS = ['verbose', 'info', 'warn', 'error'];

// Common frontend dev server ports (prefer these when auto-selecting)
const FRONTEND_PORTS = new Set([5173, 5174, 5175, 3000, 8080, 8081, 4200, 4321, 3001, 5000, 5500, 1234, 9000]);

function getPort(url: string): number {
  const match = url.match(/:(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

export default function Preview({ localUrl, localUrls = [], productionUrl, cwd, onSendToTerminal, deployments = [], claudeRunning }: Props) {
  const [device, setDevice] = useState<DeviceMode>('desktop');
  const [errors, setErrors] = useState<PreviewError[]>([]);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>([]);
  const [networkErrors, setNetworkErrors] = useState<NetworkError[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('local');
  const [manualLocalUrl, setManualLocalUrl] = useState('');
  const [selectedLocalUrl, setSelectedLocalUrl] = useState<string | null>(null);
  const [manualUrlInput, setManualUrlInput] = useState('');
  const [staticUrl, setStaticUrl] = useState<string | null>(null);
  const [sendingToClaude, setSendingToClaude] = useState(false);
  const [claudeWarning, setClaudeWarning] = useState(false);

  const [matchedDeployments, setMatchedDeployments] = useState<Deployment[]>([]);
  const [selectedDeploymentUrl, setSelectedDeploymentUrl] = useState<string | null>(null);
  const [storedProdUrl, setStoredProdUrl] = useState<string | null>(null);

  const localWebviewRef = useRef<any>(null);
  const prodWebviewRef = useRef<any>(null);
  const staticCwdRef = useRef<string>('');
  const devtoolsWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // When multiple URLs detected, let user pick; auto-select first frontend port
  const resolvedLocalUrl = selectedLocalUrl && localUrls.includes(selectedLocalUrl)
    ? selectedLocalUrl
    : localUrls.length > 1
      ? (localUrls.find(u => FRONTEND_PORTS.has(getPort(u))) || localUrls[0])
      : localUrl || null;
  const rawLocalUrl = staticUrl || resolvedLocalUrl || manualLocalUrl || null;
  const rawProdUrl = selectedDeploymentUrl || storedProdUrl || productionUrl || null;

  // Validate URLs before passing to webview — Electron's webview crashes on invalid src
  const isValidUrl = (url: string | null): url is string => {
    if (!url) return false;
    try { new URL(url); return true; } catch { return false; }
  };
  const effectiveLocalUrl = isValidUrl(rawLocalUrl) ? rawLocalUrl : null;
  const effectiveProdUrl = isValidUrl(rawProdUrl) ? rawProdUrl : null;

  useEffect(() => {
    if (effectiveLocalUrl && !effectiveProdUrl) setViewMode('local');
    else if (!effectiveLocalUrl && effectiveProdUrl) setViewMode('production');
  }, [effectiveLocalUrl, effectiveProdUrl]);

  useEffect(() => {
    if (!cwd || deployments.length === 0) {
      setMatchedDeployments([]);
      setSelectedDeploymentUrl(null);
      return;
    }
    const folderName = cwd.split('/').pop()?.toLowerCase() || '';
    const running = deployments.filter(d => d.status === 'running');
    const matched = running.filter(d =>
      d.appName.toLowerCase().includes(folderName) ||
      folderName.includes(d.appName.toLowerCase().split('-')[0])
    );
    setMatchedDeployments(matched);
    const frontend = matched.find(d => !/(api|backend|server)/.test(d.appName));
    setSelectedDeploymentUrl((frontend || matched[0])?.url || null);
  }, [cwd, deployments]);

  useEffect(() => {
    if (!cwd) return;
    setStoredProdUrl(null);
    window.cozyPane.preview.getStoredUrl(cwd).then((data: { productionUrl?: string } | null) => {
      if (data?.productionUrl) setStoredProdUrl(data.productionUrl);
    }).catch(() => {});
  }, [cwd]);

  useEffect(() => {
    if (!cwd) return;
    if (staticCwdRef.current && staticCwdRef.current !== cwd) {
      window.cozyPane.preview.stopStatic(staticCwdRef.current).catch(() => {});
      staticCwdRef.current = '';
      setStaticUrl(null);
    }
    if (localUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const projectResult = await window.cozyPane.preview.detectProject(cwd);
        if (cancelled) return;
        if (projectResult?.serveStatic) {
          const result = await window.cozyPane.preview.serveStatic(cwd);
          if (cancelled) return;
          staticCwdRef.current = cwd;
          setStaticUrl(`http://localhost:${result.port}`);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [cwd, localUrl]);

  // Debounced auto-write devtools data for MCP bridge (2s)
  useEffect(() => {
    if (consoleLogs.length === 0 && networkErrors.length === 0) return;
    if (devtoolsWriteTimerRef.current) clearTimeout(devtoolsWriteTimerRef.current);
    devtoolsWriteTimerRef.current = setTimeout(() => {
      const data = {
        url: effectiveLocalUrl || effectiveProdUrl || null,
        consoleLogs: consoleLogs.slice(-100),
        networkErrors: networkErrors.slice(-50),
        timestamp: Date.now(),
      };
      window.cozyPane.preview.writeDevToolsData(data).catch(() => {});
    }, 2000);
    return () => {
      if (devtoolsWriteTimerRef.current) clearTimeout(devtoolsWriteTimerRef.current);
    };
  }, [consoleLogs, networkErrors, effectiveLocalUrl, effectiveProdUrl]);

  const wireWebview = useCallback((wv: any) => {
    if (!wv) return;

    const handleConsoleMessage = (e: any) => {
      const log: ConsoleLog = {
        level: e.level,
        message: e.message,
        timestamp: Date.now(),
        source: e.sourceId,
        line: e.line,
      };
      setConsoleLogs(prev => [...prev.slice(-99), log]);

      if (e.message.startsWith('[CozyPreview:netdata]')) {
        try {
          const json = JSON.parse(e.message.slice('[CozyPreview:netdata]'.length));
          setNetworkErrors(prev => [...prev.slice(-49), {
            method: json.method || 'GET',
            url: json.url || '',
            status: json.status || 0,
            statusText: json.statusText || 'Unknown',
            timestamp: Date.now(),
          }]);
        } catch {}
        return;
      }

      if (e.level >= 2) {
        setErrors(prev => [...prev.slice(-19), {
          type: e.message.startsWith('[CozyPreview:network]') ? 'network' : 'console',
          message: e.message,
          timestamp: Date.now(),
          detail: `Line ${e.line} in ${e.sourceId}`,
        }]);
      }
    };

    const handleDidFailLoad = (e: any) => {
      if (e.errorCode === -3) return;
      setErrors(prev => [...prev.slice(-19), {
        type: 'load',
        message: `Page failed to load: ${e.errorDescription}`,
        timestamp: Date.now(),
        detail: `Error code: ${e.errorCode}, URL: ${e.validatedURL}`,
      }]);
      setLoading(false);
    };

    const handleDidStartLoading = () => setLoading(true);
    const handleDidStopLoading = () => setLoading(false);

    const injectNetworkWatcher = () => {
      wv.executeJavaScript(`
        (function() {
          if (window.__cozyPreviewInjected) return;
          window.__cozyPreviewInjected = true;
          const origFetch = window.fetch;
          window.fetch = async function(...args) {
            const method = (args[1]?.method || 'GET').toUpperCase();
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || String(args[0]));
            try {
              const res = await origFetch.apply(this, args);
              if (!res.ok) {
                console.error('[CozyPreview:netdata]' + JSON.stringify({method: method, url: url, status: res.status, statusText: res.statusText}));
                console.error('[CozyPreview:network] ' + res.status + ' ' + res.statusText + ' - ' + url);
              }
              return res;
            } catch(e) {
              console.error('[CozyPreview:netdata]' + JSON.stringify({method: method, url: url, status: 0, statusText: e.message}));
              console.error('[CozyPreview:network] Fetch failed: ' + e.message + ' - ' + url);
              throw e;
            }
          };
          window.addEventListener('error', function(e) {
            console.error('[CozyPreview:error] ' + e.message + ' at ' + e.filename + ':' + e.lineno);
          });
          window.addEventListener('unhandledrejection', function(e) {
            console.error('[CozyPreview:error] Unhandled promise rejection: ' + (e.reason?.message || e.reason));
          });
        })();
      `).catch(() => {});
    };

    wv.addEventListener('console-message', handleConsoleMessage);
    wv.addEventListener('did-fail-load', handleDidFailLoad);
    wv.addEventListener('did-start-loading', handleDidStartLoading);
    wv.addEventListener('did-stop-loading', handleDidStopLoading);
    wv.addEventListener('dom-ready', injectNetworkWatcher);

    return () => {
      wv.removeEventListener('console-message', handleConsoleMessage);
      wv.removeEventListener('did-fail-load', handleDidFailLoad);
      wv.removeEventListener('did-start-loading', handleDidStartLoading);
      wv.removeEventListener('did-stop-loading', handleDidStopLoading);
      wv.removeEventListener('dom-ready', injectNetworkWatcher);
    };
  }, []);

  useEffect(() => {
    const wv = localWebviewRef.current;
    if (!wv || !effectiveLocalUrl) return;
    return wireWebview(wv);
  }, [effectiveLocalUrl, wireWebview]);

  useEffect(() => {
    const wv = prodWebviewRef.current;
    if (!wv || !effectiveProdUrl) return;
    return wireWebview(wv);
  }, [effectiveProdUrl, wireWebview]);

  const collectDevToolsData = useCallback(async () => {
    const currentUrl = effectiveLocalUrl || effectiveProdUrl || null;
    const wv = localWebviewRef.current || prodWebviewRef.current;

    let screenshotPath: string | null = null;
    let htmlSnapshot: string | null = null;

    if (wv) {
      try {
        const nativeImage = await wv.capturePage();
        const base64 = nativeImage.toPNG().toString('base64');
        screenshotPath = await window.cozyPane.preview.captureScreenshot(base64);
      } catch {}

      try {
        const html: string = await wv.executeJavaScript('document.documentElement.outerHTML');
        htmlSnapshot = html.length > 100000 ? html.slice(0, 100000) : html;
      } catch {}
    }

    const data = {
      url: currentUrl,
      consoleLogs: consoleLogs.slice(-100),
      networkErrors: networkErrors.slice(-50),
      screenshotPath,
      htmlSnapshot,
      timestamp: Date.now(),
    };

    await window.cozyPane.preview.writeDevToolsData(data).catch(() => {});
    return data;
  }, [consoleLogs, networkErrors, effectiveLocalUrl, effectiveProdUrl]);

  const sendDevToolsToClaude = useCallback(async () => {
    if (!claudeRunning) {
      setClaudeWarning(true);
      setTimeout(() => setClaudeWarning(false), 3000);
      return;
    }

    setSendingToClaude(true);
    try {
      const data = await collectDevToolsData();

      const sections: string[] = [];
      sections.push(`The preview at ${data.url || 'unknown'} needs debugging. Here is the devtools data:\n`);

      const errorLogs = data.consoleLogs.filter(l => l.level >= 2);
      if (errorLogs.length > 0) {
        sections.push('## Console Errors/Warnings');
        sections.push(errorLogs.slice(-15).map(l =>
          `- [${LEVEL_LABELS[l.level] || 'log'}] ${l.message}${l.source ? ` (${l.source}:${l.line})` : ''}`
        ).join('\n'));
      }

      if (data.networkErrors.length > 0) {
        sections.push('\n## Network Errors');
        sections.push(data.networkErrors.slice(-10).map(n =>
          `- ${n.method} ${n.url} -> ${n.status} ${n.statusText}`
        ).join('\n'));
      }

      if (data.screenshotPath) {
        sections.push(`\n## Screenshot\nSaved at: ${data.screenshotPath}`);
      }

      if (data.htmlSnapshot) {
        const snippet = data.htmlSnapshot.slice(0, 2000);
        sections.push(`\n## HTML Snapshot (first 2KB)\n\`\`\`html\n${snippet}\n\`\`\``);
      }

      sections.push('\nPlease fix these issues. Full data is available via the cozypane_get_preview_info MCP tool.');

      onSendToTerminal(sections.join('\n'));
    } finally {
      setSendingToClaude(false);
    }
  }, [claudeRunning, collectDevToolsData, onSendToTerminal]);


  const reload = useCallback(() => {
    setErrors([]);
    setConsoleLogs([]);
    setNetworkErrors([]);
    if (viewMode === 'local' || viewMode === 'split') localWebviewRef.current?.reload();
    if (viewMode === 'production' || viewMode === 'split') prodWebviewRef.current?.reload();
  }, [viewMode]);

  const hardReload = useCallback(() => {
    setErrors([]);
    setConsoleLogs([]);
    setNetworkErrors([]);
    if (viewMode === 'local' || viewMode === 'split') localWebviewRef.current?.reloadIgnoringCache();
    if (viewMode === 'production' || viewMode === 'split') prodWebviewRef.current?.reloadIgnoringCache();
  }, [viewMode]);

  const deviceWidth = DEVICE_WIDTHS[device];

  useEffect(() => {
    const wv = localWebviewRef.current;
    if (wv && effectiveLocalUrl && wv.src !== effectiveLocalUrl) wv.src = effectiveLocalUrl;
  }, [effectiveLocalUrl]);

  useEffect(() => {
    const wv = prodWebviewRef.current;
    if (wv && effectiveProdUrl && wv.src !== effectiveProdUrl) wv.src = effectiveProdUrl;
  }, [effectiveProdUrl]);

  const hasDevToolsData = consoleLogs.length > 0 || networkErrors.length > 0 || errors.length > 0;

  const renderWebview = (url: string, ref: React.RefObject<any>, label: string) => (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
      {viewMode === 'split' && (
        <div style={{
          padding: '0.2em 0.5em',
          fontSize: '0.72em',
          color: 'var(--text-secondary, #888)',
          backgroundColor: 'var(--bg-secondary, #161822)',
          borderBottom: '1px solid var(--border, #2a2b3e)',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
          {label}
        </div>
      )}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', backgroundColor: '#0a0b10', overflow: 'hidden', position: 'relative' }}>
        <webview
          ref={ref}
          src={url}
          style={{
            width: deviceWidth ? `${deviceWidth}px` : '100%',
            height: '100%',
            border: deviceWidth ? '1px solid var(--border, #2a2b3e)' : 'none',
            borderRadius: deviceWidth ? '8px' : '0',
            backgroundColor: '#fff',
          }}
          // @ts-ignore
          partition="persist:preview"
          {...(/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url) ? { webpreferences: 'allowRunningInsecureContent=true' } : {})}
        />

        {errors.length > 0 && !drawerOpen && (
          <button
            onClick={sendDevToolsToClaude}
            disabled={sendingToClaude}
            style={{
              position: 'absolute', bottom: 12, right: 12,
              padding: '6px 12px', borderRadius: 20, border: 'none',
              backgroundColor: '#e74c3c', color: '#fff',
              fontSize: '0.75em', fontWeight: 600,
              cursor: sendingToClaude ? 'wait' : 'pointer',
              display: 'flex', alignItems: 'center', gap: '6px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
              opacity: sendingToClaude ? 0.7 : 1, zIndex: 10,
            }}
          >
            <span style={{
              display: 'inline-block', minWidth: 18, height: 18,
              lineHeight: '18px', textAlign: 'center', borderRadius: '50%',
              backgroundColor: 'rgba(255,255,255,0.25)', fontSize: '0.9em',
            }}>
              {errors.length}
            </span>
            {sendingToClaude ? 'Sending...' : 'Fix with Claude'}
          </button>
        )}

        {claudeWarning && (
          <div style={{
            position: 'absolute', bottom: 48, right: 12,
            padding: '6px 12px', borderRadius: 6,
            backgroundColor: '#e6b80099', color: '#1a1b2e',
            fontSize: '0.72em', fontWeight: 600, zIndex: 11,
          }}>
            Claude is not running in the terminal
          </div>
        )}
      </div>
    </div>
  );

  const renderEmptyState = () => (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', color: 'var(--text-secondary, #888)', gap: '1em', padding: '2em',
    }}>
      <div style={{ fontSize: '1.1em', color: 'var(--text-primary, #e0e0e0)', textAlign: 'center' }}>
        {viewMode === 'production' ? 'No production URL' : 'No dev server running'}
      </div>
      {viewMode !== 'production' && (
        <div style={{ fontSize: '0.82em', color: 'var(--text-secondary, #888)', textAlign: 'center', maxWidth: 380 }}>
          Run your dev server in the terminal — preview will auto-connect when it starts.
        </div>
      )}
      {viewMode === 'production' && (
        <div style={{ fontSize: '0.82em', color: 'var(--text-secondary, #888)', textAlign: 'center', maxWidth: 380 }}>
          Deploy your project to see the production preview, or enter a URL below.
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.3em', width: '100%', maxWidth: 400, marginTop: '0.5em' }}>
        <input
          type="text"
          value={manualUrlInput}
          onChange={e => setManualUrlInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && manualUrlInput.trim()) {
              const url = manualUrlInput.trim();
              if (viewMode === 'production') {
                setStoredProdUrl(url);
                if (cwd) window.cozyPane.preview.storeUrl(cwd, { productionUrl: url }).catch(() => {});
              } else {
                setManualLocalUrl(url);
              }
              setManualUrlInput('');
            }
          }}
          placeholder={viewMode === 'production' ? 'https://yourapp.com' : 'http://localhost:3000'}
          spellCheck={false}
          style={urlInputStyle}
        />
      </div>
    </div>
  );

  const showLocal = viewMode === 'local' || viewMode === 'split';
  const showProd = viewMode === 'production' || viewMode === 'split';
  const hasContent = (showLocal && effectiveLocalUrl) || (showProd && effectiveProdUrl);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={toolbarStyle}>
        <div style={{ display: 'flex', gap: '0.15em' }}>
          <button onClick={() => setViewMode('local')} style={{ ...modeBtnStyle, ...(viewMode === 'local' ? modeActiveStyle : {}) }}>
            Local
            {effectiveLocalUrl && <span style={dotStyle('#5ce0a8')} />}
          </button>
          <button onClick={() => setViewMode('production')} style={{ ...modeBtnStyle, ...(viewMode === 'production' ? modeActiveStyle : {}) }}>
            Prod
            {effectiveProdUrl && <span style={dotStyle('#5cb8f0')} />}
          </button>
          {localUrls.length > 1 && (
            <select
              value={effectiveLocalUrl || ''}
              onChange={e => setSelectedLocalUrl(e.target.value)}
              style={{
                padding: '0.15em 0.3em', borderRadius: 3,
                border: '1px solid var(--border, #2a2b3e)',
                backgroundColor: 'var(--bg-primary, #1a1b2e)',
                color: 'var(--text-secondary, #aaa)',
                fontSize: '0.72em', cursor: 'pointer', maxWidth: 180,
              }}
              title="Switch local URL"
            >
              {localUrls.map(u => (
                <option key={u} value={u}>:{getPort(u)}</option>
              ))}
            </select>
          )}
          {matchedDeployments.length > 1 && (
            <select
              value={selectedDeploymentUrl || ''}
              onChange={e => setSelectedDeploymentUrl(e.target.value)}
              style={{
                padding: '0.15em 0.3em', borderRadius: 3,
                border: '1px solid var(--border, #2a2b3e)',
                backgroundColor: 'var(--bg-primary, #1a1b2e)',
                color: 'var(--text-secondary, #aaa)',
                fontSize: '0.72em', cursor: 'pointer', maxWidth: 140,
              }}
              title="Switch deployment"
            >
              {matchedDeployments.map(d => (
                <option key={d.id} value={d.url}>{d.appName}</option>
              ))}
            </select>
          )}
          <button onClick={() => setViewMode('split')} style={{ ...modeBtnStyle, ...(viewMode === 'split' ? modeActiveStyle : {}) }} title="Side by side">
            Split
          </button>
        </div>

        <div style={{ display: 'flex', gap: '0.15em' }}>
          <button onClick={reload} style={toolBtnStyle} title="Reload">
            {loading ? '...' : '\u21BB'}
          </button>
          <button onClick={hardReload} style={{ ...toolBtnStyle, fontWeight: 700 }} title="Hard Reload (clear cache)">
            {loading ? '...' : '\u21BB!'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: '0.15em' }}>
          {(['phone', 'tablet', 'desktop'] as DeviceMode[]).map(d => (
            <button
              key={d}
              onClick={() => setDevice(d)}
              style={{
                ...toolBtnStyle,
                backgroundColor: device === d ? 'var(--accent, #7c6fe0)' : 'transparent',
                color: device === d ? '#fff' : 'var(--text-secondary, #888)',
              }}
              title={d.charAt(0).toUpperCase() + d.slice(1)}
            >
              {d === 'phone' ? '\u{1F4F1}' : d === 'tablet' ? '\u{1F4BB}' : '\u{1F5A5}'}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <button
          onClick={sendDevToolsToClaude}
          disabled={!hasDevToolsData || sendingToClaude}
          style={{
            ...toolBtnStyle,
            color: hasDevToolsData ? 'var(--accent, #7c6fe0)' : 'var(--text-secondary, #555)',
            fontWeight: 600, fontSize: '0.75em',
            opacity: hasDevToolsData ? 1 : 0.5,
            cursor: hasDevToolsData && !sendingToClaude ? 'pointer' : 'default',
          }}
          title="Send console logs, network errors, screenshot, and HTML to Claude"
        >
          {sendingToClaude ? 'Sending...' : 'Send to Claude'}
        </button>

      </div>

      {effectiveLocalUrl && (
        <div style={{
          padding: '0.2em 0.6em', fontSize: '0.75em',
          color: 'var(--text-secondary, #888)',
          backgroundColor: 'var(--bg-primary, #1a1b2e)',
          borderBottom: '1px solid var(--border, #2a2b3e)',
          display: 'flex', alignItems: 'center', gap: '0.4em',
        }}>
          <span style={{ ...dotStyle('#5ce0a8'), position: 'relative', top: 0 }} />
          <span style={{ fontFamily: 'monospace' }}>{effectiveLocalUrl}</span>
          {staticUrl && <span style={{ fontSize: '0.9em', color: 'var(--text-secondary, #666)' }}>(static)</span>}
          {effectiveProdUrl && (
            <>
              <span style={{ margin: '0 0.3em', color: 'var(--border, #3a3b4e)' }}>|</span>
              <span style={{ ...dotStyle('#5cb8f0'), position: 'relative', top: 0 }} />
              <span style={{ fontFamily: 'monospace' }}>{effectiveProdUrl}</span>
              <button
                title="Clear production URL"
                onClick={() => {
                  setStoredProdUrl(null);
                  setSelectedDeploymentUrl(null);
                  if (cwd) window.cozyPane.preview.storeUrl(cwd, { productionUrl: '' }).catch(() => {});
                }}
                style={{ ...tinyBtnStyle, padding: '0 3px', color: '#888', fontSize: '0.85em', lineHeight: 1 }}
              >
                x
              </button>
            </>
          )}
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        {!hasContent ? (
          renderEmptyState()
        ) : (
          <>
            {showLocal && effectiveLocalUrl && renderWebview(effectiveLocalUrl, localWebviewRef, 'Local')}
            {viewMode === 'split' && effectiveLocalUrl && effectiveProdUrl && (
              <div style={{ width: 2, backgroundColor: 'var(--border, #2a2b3e)', flexShrink: 0 }} />
            )}
            {showProd && effectiveProdUrl && renderWebview(effectiveProdUrl, prodWebviewRef, 'Production')}
            {showLocal && !effectiveLocalUrl && renderEmptyState()}
            {showProd && !effectiveProdUrl && renderEmptyState()}
          </>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--border, #2a2b3e)', backgroundColor: 'var(--bg-secondary, #161822)' }}>
        <div
          onClick={() => setDrawerOpen(v => !v)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0.3em 0.6em', cursor: 'pointer', userSelect: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4em' }}>
            <span style={{ fontSize: '0.78em', color: 'var(--text-secondary, #888)' }}>
              {drawerOpen ? '\u25BC' : '\u25B6'} Errors
            </span>
            {errors.length > 0 && (
              <span style={{
                fontSize: '0.7em', padding: '0 5px', borderRadius: 8,
                backgroundColor: '#e74c3c33', color: '#e74c3c', fontWeight: 600,
              }}>
                {errors.length}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.3em' }}>
            {errors.length > 0 && (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); sendDevToolsToClaude(); }}
                  style={{ ...tinyBtnStyle, color: 'var(--accent, #7c6fe0)', fontWeight: 600 }}
                >
                  Fix with Claude
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setErrors([]); setConsoleLogs([]); setNetworkErrors([]); }}
                  style={tinyBtnStyle}
                >
                  Clear
                </button>
              </>
            )}
          </div>
        </div>

        {drawerOpen && (
          <div style={{ maxHeight: 200, overflowY: 'auto', padding: '0 0.6em 0.4em' }}>
            {errors.length === 0 ? (
              <div style={{ fontSize: '0.78em', color: 'var(--text-secondary, #666)', padding: '0.5em 0' }}>
                No errors captured
              </div>
            ) : (
              errors.map((err, i) => (
                <div key={i} style={{ padding: '0.25em 0', borderBottom: '1px solid var(--border, #1e1f32)', fontSize: '0.75em' }}>
                  <div style={{ display: 'flex', gap: '0.4em', alignItems: 'baseline' }}>
                    <span style={{
                      color: err.type === 'network' ? '#e6b800' : '#e74c3c',
                      fontWeight: 600, fontSize: '0.9em', textTransform: 'uppercase',
                    }}>
                      {err.type}
                    </span>
                    <span style={{ color: 'var(--text-primary, #e0e0e0)', fontFamily: 'monospace' }}>
                      {err.message}
                    </span>
                  </div>
                  {err.detail && (
                    <div style={{ color: 'var(--text-secondary, #666)', fontSize: '0.9em', marginTop: '0.1em' }}>
                      {err.detail}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const toolbarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center',
  padding: '0.35em 0.5em',
  borderBottom: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'var(--bg-secondary, #161822)',
  gap: '0.4em',
};

const toolBtnStyle: React.CSSProperties = {
  padding: '0.2em 0.5em', borderRadius: 4,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'transparent',
  color: 'var(--text-secondary, #aaa)',
  fontSize: '0.82em', cursor: 'pointer', lineHeight: 1,
};

const modeBtnStyle: React.CSSProperties = {
  padding: '0.2em 0.6em', borderRadius: 4,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'transparent',
  color: 'var(--text-secondary, #888)',
  fontSize: '0.78em', cursor: 'pointer',
  display: 'flex', alignItems: 'center', gap: '0.3em',
};

const modeActiveStyle: React.CSSProperties = {
  backgroundColor: 'var(--accent, #7c6fe0)',
  color: '#fff',
  borderColor: 'var(--accent, #7c6fe0)',
};

const dotStyle = (color: string): React.CSSProperties => ({
  display: 'inline-block', width: 6, height: 6,
  borderRadius: '50%', backgroundColor: color, flexShrink: 0,
});

const urlInputStyle: React.CSSProperties = {
  flex: 1, padding: '0.3em 0.6em', borderRadius: 4,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'var(--bg-primary, #1a1b2e)',
  color: 'var(--text-primary, #e0e0e0)',
  fontSize: '0.82em', fontFamily: 'inherit', outline: 'none',
};

const tinyBtnStyle: React.CSSProperties = {
  padding: '2px 8px', borderRadius: 3,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'transparent',
  color: 'var(--text-secondary, #aaa)',
  fontSize: '0.75em', cursor: 'pointer',
};
