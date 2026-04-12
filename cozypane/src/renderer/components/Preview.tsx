import React, { useState, useRef, useCallback, useEffect } from 'react';
import { ArrowLeft, ArrowRight, Home, RotateCw, Smartphone, Tablet, Monitor, Columns2, Globe, Zap } from 'lucide-react';
import PreviewConsole from './PreviewConsole';
import PreviewEmptyState from './PreviewEmptyState';
import { useStaticServer } from '../lib/useStaticServer';
import { useWebviewBridge } from '../lib/useWebviewBridge';
// PreviewError, ConsoleLog, NetworkError are declared in src/renderer/types.d.ts

interface Props {
  localUrl?: string;
  localUrls?: string[];
  productionUrl?: string;
  cwd: string;
  onSendToTerminal: (command: string) => void;
  deployments?: Deployment[];
  claudeRunning?: boolean;
  initialErrors?: PreviewError[];
  initialConsoleLogs?: ConsoleLog[];
  initialNetworkErrors?: NetworkError[];
  onConsoleUpdate?: (errors: PreviewError[], consoleLogs: ConsoleLog[], networkErrors: NetworkError[]) => void;
  onNetworkRequest?: (req: NetworkRequest) => void;
  onScreenshotCaptured?: (path: string) => void;
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

export default function Preview({ localUrl, localUrls = [], productionUrl, cwd, onSendToTerminal, deployments = [], claudeRunning, initialErrors = [], initialConsoleLogs = [], initialNetworkErrors = [], onConsoleUpdate, onNetworkRequest, onScreenshotCaptured }: Props) {
  const [device, setDevice] = useState<DeviceMode>('desktop');
  const [errors, setErrors] = useState<PreviewError[]>(initialErrors);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>(initialConsoleLogs);
  const [networkErrors, setNetworkErrors] = useState<NetworkError[]>(initialNetworkErrors);
  const onConsoleUpdateRef = useRef(onConsoleUpdate);
  onConsoleUpdateRef.current = onConsoleUpdate;
  const onNetworkRequestRef = useRef(onNetworkRequest);
  onNetworkRequestRef.current = onNetworkRequest;
  const onScreenshotCapturedRef = useRef(onScreenshotCaptured);
  onScreenshotCapturedRef.current = onScreenshotCaptured;
  // Keep latest initial values in refs so the cwd-change effect can read them
  const initialErrorsRef = useRef(initialErrors);
  initialErrorsRef.current = initialErrors;
  const initialConsoleLogsRef = useRef(initialConsoleLogs);
  initialConsoleLogsRef.current = initialConsoleLogs;
  const initialNetworkErrorsRef = useRef(initialNetworkErrors);
  initialNetworkErrorsRef.current = initialNetworkErrors;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('local');
  const [manualLocalUrl, setManualLocalUrl] = useState('');
  const [selectedLocalUrl, setSelectedLocalUrl] = useState<string | null>(null);
  const [manualUrlInput, setManualUrlInput] = useState('');
  const [sendingToClaude, setSendingToClaude] = useState(false);
  const [claudeWarning, setClaudeWarning] = useState(false);
  const [projectInfo, setProjectInfo] = useState<{ type: string | null; devCommand: string | null } | null>(null);
  const [suggestedPort, setSuggestedPort] = useState<number | null>(null);
  const [startingDev, setStartingDev] = useState(false);

  const [consoleTab, setConsoleTab] = useState<'errors' | 'all'>('errors');
  const [matchedDeployments, setMatchedDeployments] = useState<Deployment[]>([]);
  const [selectedDeploymentUrl, setSelectedDeploymentUrl] = useState<string | null>(null);
  const [storedProdUrl, setStoredProdUrl] = useState<string | null>(null);

  const localWebviewRef = useRef<any>(null);
  const prodWebviewRef = useRef<any>(null);
  const devtoolsWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the URL we intentionally loaded so we don't re-navigate when webview browses to a sub-path
  const lastLoadedLocalUrlRef = useRef<string | null>(null);
  const lastLoadedProdUrlRef = useRef<string | null>(null);

  const { staticUrl, staticError } = useStaticServer(cwd, localUrl);

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

  // On tab switch (cwd changes): restore saved console state and navigate to root
  const prevCwdRef = useRef(cwd);
  useEffect(() => {
    if (prevCwdRef.current === cwd) return;
    prevCwdRef.current = cwd;
    setErrors(initialErrorsRef.current);
    setConsoleLogs(initialConsoleLogsRef.current);
    setNetworkErrors(initialNetworkErrorsRef.current);
    // Reset the last-loaded tracking so the URL effects will re-navigate to root on next render
    lastLoadedLocalUrlRef.current = null;
    lastLoadedProdUrlRef.current = null;
  }, [cwd]);

  // Notify parent whenever console state changes so it can persist per-tab.
  // Skip the initial mount to avoid a spurious update with the initial prop values.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    onConsoleUpdateRef.current?.(errors, consoleLogs, networkErrors);
  }, [errors, consoleLogs, networkErrors]);

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

  // Detect project type and suggest port when no dev server is running
  useEffect(() => {
    if (!cwd || effectiveLocalUrl) { setProjectInfo(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const [info, stored, portResult] = await Promise.all([
          window.cozyPane.preview.detectProject(cwd),
          window.cozyPane.preview.getStoredUrl(cwd),
          window.cozyPane.preview.suggestPort(),
        ]);
        if (cancelled) return;
        const devCommand = stored?.lastDevCommand || info?.devCommand || null;
        setProjectInfo({ type: info?.type || null, devCommand });
        setSuggestedPort(portResult?.port || 3000);
      } catch {
        if (!cancelled) { setProjectInfo(null); setSuggestedPort(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [cwd, effectiveLocalUrl]);

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

  useWebviewBridge({
    localWebviewRef,
    prodWebviewRef,
    effectiveLocalUrl,
    effectiveProdUrl,
    setConsoleLogs,
    setNetworkErrors,
    setErrors,
    setLoading,
    onNetworkRequestRef,
    onScreenshotCapturedRef,
  });

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
    // Always ignore cache — prevents stale error responses (e.g. cached 503) from persisting
    if (viewMode === 'local' || viewMode === 'split') localWebviewRef.current?.reloadIgnoringCache();
    if (viewMode === 'production' || viewMode === 'split') prodWebviewRef.current?.reloadIgnoringCache();
  }, [viewMode]);

  const goBack = useCallback(() => {
    if (viewMode === 'local' || viewMode === 'split') localWebviewRef.current?.goBack();
    if (viewMode === 'production' || viewMode === 'split') prodWebviewRef.current?.goBack();
  }, [viewMode]);

  const goForward = useCallback(() => {
    if (viewMode === 'local' || viewMode === 'split') localWebviewRef.current?.goForward();
    if (viewMode === 'production' || viewMode === 'split') prodWebviewRef.current?.goForward();
  }, [viewMode]);

  const goHome = useCallback(() => {
    setErrors([]);
    setConsoleLogs([]);
    setNetworkErrors([]);
    if (viewMode === 'local' || viewMode === 'split') {
      const wv = localWebviewRef.current;
      if (wv && effectiveLocalUrl) {
        // Navigate to localhost root (e.g. http://localhost:5173)
        try { const u = new URL(effectiveLocalUrl); wv.src = u.origin; } catch { wv.src = effectiveLocalUrl; }
      }
    }
    if (viewMode === 'production' || viewMode === 'split') {
      const wv = prodWebviewRef.current;
      if (wv && effectiveProdUrl) {
        // Navigate to domain root (e.g. https://myapp.com)
        try { const u = new URL(effectiveProdUrl); wv.src = u.origin; } catch { wv.src = effectiveProdUrl; }
      }
    }
  }, [viewMode, effectiveLocalUrl, effectiveProdUrl]);

  const deviceWidth = DEVICE_WIDTHS[device];

  useEffect(() => {
    const wv = localWebviewRef.current;
    if (wv && effectiveLocalUrl && lastLoadedLocalUrlRef.current !== effectiveLocalUrl) {
      lastLoadedLocalUrlRef.current = effectiveLocalUrl;
      wv.src = effectiveLocalUrl;
    }
  }, [effectiveLocalUrl]);

  useEffect(() => {
    const wv = prodWebviewRef.current;
    if (wv && effectiveProdUrl && lastLoadedProdUrlRef.current !== effectiveProdUrl) {
      lastLoadedProdUrlRef.current = effectiveProdUrl;
      wv.src = effectiveProdUrl;
    }
  }, [effectiveProdUrl]);

  const hasDevToolsData = consoleLogs.length > 0 || networkErrors.length > 0 || errors.length > 0;

  const renderWebview = (url: string, ref: React.RefObject<any>, label: string) => (
    <div className="preview-webview-wrapper">
      {viewMode === 'split' && (
        <div className="preview-split-label">
          {label}
        </div>
      )}
      <div className="preview-webview-viewport">
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

      </div>
    </div>
  );

  const startDevServer = useCallback(async () => {
    if (!projectInfo?.devCommand || !suggestedPort) return;
    setStartingDev(true);
    const cmd = projectInfo.devCommand;
    // Remember the command for next time
    if (cwd) window.cozyPane.preview.storeUrl(cwd, { lastDevCommand: cmd }).catch(() => {});
    // Append --port flag for frameworks that support it
    const portFlag = cmd.includes('vite') || cmd.includes('next') || cmd.includes('nuxi')
      ? ` --port ${suggestedPort}`
      : cmd.includes('flask') ? ` --port ${suggestedPort}`
      : cmd.includes('runserver') ? ` ${suggestedPort}`
      : cmd.includes('ng serve') ? ` --port ${suggestedPort}`
      : '';
    onSendToTerminal(cmd + portFlag);
    // Reset after a delay — the URL detection will pick up the server
    setTimeout(() => setStartingDev(false), 5000);
  }, [projectInfo, suggestedPort, cwd, onSendToTerminal]);

  const handleManualUrlSubmit = useCallback(() => {
    const url = manualUrlInput.trim();
    if (!url) return;
    if (viewMode === 'production') {
      setStoredProdUrl(url);
      if (cwd) window.cozyPane.preview.storeUrl(cwd, { productionUrl: url }).catch(() => {});
    } else {
      setManualLocalUrl(url);
    }
    setManualUrlInput('');
  }, [manualUrlInput, viewMode, cwd]);

  const renderEmptyState = () => (
    <PreviewEmptyState
      viewMode={viewMode}
      staticError={staticError}
      projectInfo={projectInfo}
      suggestedPort={suggestedPort}
      startingDev={startingDev}
      onStartDevServer={startDevServer}
      manualUrlInput={manualUrlInput}
      onManualUrlInputChange={setManualUrlInput}
      onManualUrlSubmit={handleManualUrlSubmit}
    />
  );

  const showLocal = viewMode === 'local' || viewMode === 'split';
  const showProd = viewMode === 'production' || viewMode === 'split';
  const hasContent = (showLocal && effectiveLocalUrl) || (showProd && effectiveProdUrl);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={toolbarStyle}>
        <div style={{ display: 'flex', gap: '0.15em' }}>
          <button onClick={() => setViewMode('local')} style={{ ...modeBtnStyle, ...(viewMode === 'local' ? modeActiveStyle : {}) }}>
            <Zap size={12} /> Local
            {effectiveLocalUrl && <span style={dotStyle('var(--success, #5ce0a8)')} />}
          </button>
          <button onClick={() => setViewMode('production')} style={{ ...modeBtnStyle, ...(viewMode === 'production' ? modeActiveStyle : {}) }}>
            <Globe size={12} /> Prod
            {effectiveProdUrl && <span style={dotStyle('var(--info, #5cb8f0)')} />}
          </button>
          {localUrls.length > 1 && (
            <select
              value={effectiveLocalUrl || ''}
              onChange={e => setSelectedLocalUrl(e.target.value)}
              className="preview-url-select"
              style={{ maxWidth: 180 }}
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
              className="preview-url-select"
              style={{ maxWidth: 140 }}
              title="Switch deployment"
            >
              {matchedDeployments.map(d => (
                <option key={d.id} value={d.url}>{d.appName}</option>
              ))}
            </select>
          )}
          <button onClick={() => setViewMode('split')} style={{ ...modeBtnStyle, ...(viewMode === 'split' ? modeActiveStyle : {}) }} title="Side by side">
            <Columns2 size={12} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: '0.15em' }}>
          <button onClick={goBack} style={toolBtnStyle} title="Back" aria-label="Back"><ArrowLeft size={13} /></button>
          <button onClick={goForward} style={toolBtnStyle} title="Forward" aria-label="Forward"><ArrowRight size={13} /></button>
          <button onClick={goHome} style={toolBtnStyle} title="Home (server root)" aria-label="Home (server root)"><Home size={13} /></button>
          <button onClick={reload} style={toolBtnStyle} title="Reload" aria-label="Reload">
            <RotateCw size={13} style={loading ? { animation: 'spin 0.7s linear infinite' } : {}} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: '0.15em' }} role="group" aria-label="Device size">
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
              aria-label={`${d.charAt(0).toUpperCase() + d.slice(1)} viewport`}
              aria-pressed={device === d}
            >
              {d === 'phone' ? <Smartphone size={13} /> : d === 'tablet' ? <Tablet size={13} /> : <Monitor size={13} />}
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
          aria-label="Send preview context to Claude"
        >
          {sendingToClaude ? 'Sending...' : 'Send to Claude'}
        </button>

      </div>

      {effectiveLocalUrl && (
        <div className="preview-url-bar">
          <span style={{ ...dotStyle('var(--success, #5ce0a8)'), position: 'relative', top: 0 }} />
          <span style={{ fontFamily: 'monospace' }}>{effectiveLocalUrl}</span>
          {staticUrl && <span style={{ fontSize: '0.9em', color: 'var(--text-secondary, #666)' }}>(static)</span>}
          {effectiveProdUrl && (
            <>
              <span style={{ margin: '0 0.3em', color: 'var(--border, #3a3b4e)' }}>|</span>
              <span style={{ ...dotStyle('var(--info, #5cb8f0)'), position: 'relative', top: 0 }} />
              <span style={{ fontFamily: 'monospace' }}>{effectiveProdUrl}</span>
              <button
                title="Clear production URL"
                onClick={() => {
                  setStoredProdUrl(null);
                  setSelectedDeploymentUrl(null);
                  if (cwd) window.cozyPane.preview.storeUrl(cwd, { productionUrl: '' }).catch(() => {});
                }}
                style={{ ...tinyBtnStyle, padding: '0 3px', color: 'var(--text-secondary, #888)', fontSize: '0.85em', lineHeight: 1 }}
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

      {claudeWarning && (
        <div className="preview-claude-warning">
          Claude is not running in the terminal
        </div>
      )}

      <PreviewConsole
        errors={errors}
        consoleLogs={consoleLogs}
        networkErrors={networkErrors}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen(v => !v)}
        consoleTab={consoleTab}
        onTabChange={setConsoleTab}
        onClear={() => { setErrors([]); setConsoleLogs([]); setNetworkErrors([]); }}
        onFixWithClaude={sendDevToolsToClaude}
        sendingToClaude={sendingToClaude}
      />
    </div>
  );
}

const toolbarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center',
  padding: '5px 8px',
  borderBottom: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'var(--bg-secondary, #161822)',
  gap: '0.4em',
  minHeight: 36,
};

const toolBtnStyle: React.CSSProperties = {
  padding: '4px 7px', borderRadius: 4,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'transparent',
  color: 'var(--text-secondary, #aaa)',
  fontSize: '0.82em', cursor: 'pointer', lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const modeBtnStyle: React.CSSProperties = {
  padding: '4px 8px', borderRadius: 4,
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

const tinyBtnStyle: React.CSSProperties = {
  padding: '2px 8px', borderRadius: 3,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'transparent',
  color: 'var(--text-secondary, #aaa)',
  fontSize: '0.75em', cursor: 'pointer',
};
