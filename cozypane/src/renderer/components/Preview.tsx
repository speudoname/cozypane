import React, { useState, useRef, useCallback, useEffect } from 'react';

interface PreviewError {
  type: 'console' | 'network' | 'load';
  message: string;
  timestamp: number;
  detail?: string;
}

interface SubProject {
  path: string;
  name: string;
  type: string;
  devCommand: string | null;
}

interface ProjectInfo {
  type: string | null;
  devCommand: string | null;
  productionUrl: string | null;
  serveStatic?: boolean;
  needsDatabase?: boolean;
  subProjects?: SubProject[];
}

interface Props {
  localUrl?: string;
  productionUrl?: string;
  cwd: string;
  onSendToTerminal: (command: string) => void;
}

type DeviceMode = 'desktop' | 'tablet' | 'phone';
type ViewMode = 'local' | 'production' | 'split';

type ServerState = 'idle' | 'detecting' | 'starting' | 'waiting' | 'ready' | 'failed';

const DEVICE_WIDTHS: Record<DeviceMode, number | null> = {
  desktop: null,
  tablet: 768,
  phone: 375,
};

declare global {
  interface Window {
    cozyPane: any;
  }
}

export default function Preview({ localUrl, productionUrl, cwd, onSendToTerminal }: Props) {
  const [device, setDevice] = useState<DeviceMode>('desktop');
  const [autoFix, setAutoFix] = useState(false);
  const [errors, setErrors] = useState<PreviewError[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('local');
  const [manualUrl, setManualUrl] = useState('');

  // Smart detection state
  const [serverState, setServerState] = useState<ServerState>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [detectedPorts, setDetectedPorts] = useState<number[]>([]);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<{ devCommand?: string; productionUrl?: string; summary?: string; error?: string } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [staticUrl, setStaticUrl] = useState<string | null>(null);
  const [showSubPicker, setShowSubPicker] = useState(false);

  const localWebviewRef = useRef<any>(null);
  const prodWebviewRef = useRef<any>(null);
  const autoFixSentRef = useRef(false);
  const autoStartedForCwdRef = useRef<string>('');
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const staticCwdRef = useRef<string>('');

  // Determine the actual URLs to show
  const effectiveLocalUrl = localUrl || staticUrl || (detectedPorts.length > 0 ? `http://localhost:${detectedPorts[0]}` : manualUrl || null);
  // Prefer locally-detected production URLs over the prop (which may be stale from a tab switch)
  const effectiveProdUrl = projectInfo?.productionUrl || aiAnalysis?.productionUrl || productionUrl || null;
  const effectiveDevCommand = projectInfo?.devCommand || aiAnalysis?.devCommand || null;

  // Auto-switch view mode based on available URLs
  useEffect(() => {
    if (effectiveLocalUrl && effectiveProdUrl) {
      // Both available — stay on current or default to split
    } else if (effectiveLocalUrl) {
      setViewMode('local');
    } else if (effectiveProdUrl) {
      setViewMode('production');
    }
  }, [effectiveLocalUrl, effectiveProdUrl]);

  // When server becomes ready, stop polling
  useEffect(() => {
    if (effectiveLocalUrl && serverState === 'waiting') {
      setServerState('ready');
      setStatusMessage('');
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    }
  }, [effectiveLocalUrl, serverState]);

  // Cleanup poll on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  // Persist production URLs when they appear — only persist URLs that were
  // actually detected for THIS cwd (from projectInfo or aiAnalysis), never
  // the prop which may be stale from a previous tab during transitions.
  useEffect(() => {
    const detectedProdUrl = projectInfo?.productionUrl || aiAnalysis?.productionUrl;
    if (detectedProdUrl && cwd) {
      window.cozyPane.preview.storeUrl(cwd, { productionUrl: detectedProdUrl }).catch(() => {});
    }
  }, [projectInfo?.productionUrl, aiAnalysis?.productionUrl, cwd]);

  // === CORE: Seamless auto-start flow when cwd changes ===
  useEffect(() => {
    if (!cwd) return;

    // Stop old static server
    if (staticCwdRef.current && staticCwdRef.current !== cwd) {
      window.cozyPane.preview.stopStatic(staticCwdRef.current).catch(() => {});
      staticCwdRef.current = '';
    }

    // Reset state for new cwd
    setDetectedPorts([]);
    setProjectInfo(null);
    setAiAnalysis(null);
    setManualUrl('');
    setErrors([]);
    setServerState('detecting');
    setStatusMessage('Detecting project...');
    setStaticUrl(null);
    setShowSubPicker(false);
    autoStartedForCwdRef.current = '';
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    let cancelled = false;

    (async () => {
      try {
        // Step 1: Scan ports (cwd-aware) + detect project + check stored URLs in parallel
        const [portsResult, projectResult, storedUrl] = await Promise.all([
          window.cozyPane.preview.scanPortsForCwd(cwd),
          window.cozyPane.preview.detectProject(cwd),
          window.cozyPane.preview.getStoredUrl(cwd),
        ]);

        if (cancelled) return;

        const ports = portsResult.ports || [];
        setDetectedPorts(ports);
        setProjectInfo(projectResult);

        // Restore stored production URL if not already present
        if (storedUrl?.productionUrl && !productionUrl && !projectResult?.productionUrl) {
          setProjectInfo((prev: ProjectInfo | null) => prev ? { ...prev, productionUrl: storedUrl.productionUrl } : prev);
        }

        // Step 2: If a server is already running, we're done
        if (ports.length > 0 || localUrl) {
          setServerState('ready');
          setStatusMessage('');
          return;
        }

        // Step 3a: Static HTML — use built-in server
        if (projectResult?.serveStatic) {
          setServerState('starting');
          setStatusMessage('Starting static file server...');
          try {
            const result = await window.cozyPane.preview.serveStatic(cwd);
            if (cancelled) return;
            staticCwdRef.current = cwd;
            setStaticUrl(`http://localhost:${result.port}`);
            setServerState('ready');
            setStatusMessage('');
          } catch {
            if (!cancelled) {
              setServerState('failed');
              setStatusMessage('Failed to start static server');
            }
          }
          return;
        }

        // Step 3b: Monorepo with sub-projects but no root dev command
        if (!projectResult?.devCommand && projectResult?.subProjects?.length) {
          setShowSubPicker(true);
          setServerState('idle');
          setStatusMessage('');
          return;
        }

        // Step 3c: We have a dev command — auto-start it
        const devCommand = projectResult?.devCommand;
        if (devCommand && autoStartedForCwdRef.current !== cwd) {
          autoStartedForCwdRef.current = cwd;
          setServerState('starting');
          setStatusMessage(`Starting: ${devCommand}`);

          onSendToTerminal(devCommand);

          // Step 4: Poll for the server to come up (cwd-aware)
          setServerState('waiting');
          setStatusMessage('Waiting for dev server...');

          let attempts = 0;
          const maxAttempts = 30;

          pollIntervalRef.current = setInterval(async () => {
            attempts++;
            try {
              const result = await window.cozyPane.preview.scanPortsForCwd(cwd);
              const newPorts = result.ports || [];
              if (newPorts.length > 0) {
                setDetectedPorts(newPorts);
                setServerState('ready');
                setStatusMessage('');
                if (pollIntervalRef.current) {
                  clearInterval(pollIntervalRef.current);
                  pollIntervalRef.current = null;
                }
              } else if (attempts >= maxAttempts) {
                setServerState('failed');
                setStatusMessage('Server didn\'t start within 30s');
                if (pollIntervalRef.current) {
                  clearInterval(pollIntervalRef.current);
                  pollIntervalRef.current = null;
                }
              }
            } catch {}
          }, 1000);

          return;
        }

        // No dev command detected — just show idle state
        if (!devCommand) {
          setServerState('idle');
          setStatusMessage('');
        }
      } catch {
        if (!cancelled) {
          setServerState('failed');
          setStatusMessage('Detection failed');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [cwd]); // intentionally not including localUrl/onSendToTerminal to avoid re-triggering

  const scanPorts = useCallback(async () => {
    try {
      const result = await window.cozyPane.preview.scanPortsForCwd(cwd);
      setDetectedPorts(result.ports || []);
    } catch {}
  }, [cwd]);

  const runAiAnalysis = useCallback(async () => {
    setAnalyzing(true);
    try {
      const result = await window.cozyPane.preview.aiAnalyze(cwd);
      setAiAnalysis(result);
      if (result.devCommand && !effectiveLocalUrl && autoStartedForCwdRef.current !== cwd) {
        autoStartedForCwdRef.current = cwd;
        onSendToTerminal(result.devCommand);
        setServerState('waiting');
        setStatusMessage('Waiting for dev server...');
        pollIntervalRef.current = setInterval(async () => {
          try {
            const portResult = await window.cozyPane.preview.scanPortsForCwd(cwd);
            if ((portResult.ports || []).length > 0) {
              setDetectedPorts(portResult.ports);
              setServerState('ready');
              setStatusMessage('');
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
              }
            }
          } catch {}
        }, 1000);
      }
    } catch (err: any) {
      setAiAnalysis({ error: err.message });
    }
    setAnalyzing(false);
  }, [cwd, effectiveLocalUrl, onSendToTerminal]);

  const retryStartServer = useCallback(() => {
    const cmd = effectiveDevCommand || aiAnalysis?.devCommand;
    if (!cmd) return;
    autoStartedForCwdRef.current = '';
    onSendToTerminal(cmd);
    setServerState('waiting');
    setStatusMessage('Waiting for dev server...');

    let attempts = 0;
    pollIntervalRef.current = setInterval(async () => {
      attempts++;
      try {
        const result = await window.cozyPane.preview.scanPortsForCwd(cwd);
        if ((result.ports || []).length > 0) {
          setDetectedPorts(result.ports);
          setServerState('ready');
          setStatusMessage('');
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
        } else if (attempts >= 30) {
          setServerState('failed');
          setStatusMessage('Server didn\'t start within 30s');
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
        }
      } catch {}
    }, 1000);
  }, [cwd, effectiveDevCommand, aiAnalysis, onSendToTerminal]);

  const startSubProject = useCallback((sub: SubProject) => {
    setShowSubPicker(false);
    if (sub.devCommand) {
      autoStartedForCwdRef.current = cwd;
      setServerState('starting');
      setStatusMessage(`Starting: cd ${sub.name} && ${sub.devCommand}`);
      onSendToTerminal(`cd ${sub.path} && ${sub.devCommand}`);

      setServerState('waiting');
      setStatusMessage('Waiting for dev server...');

      let attempts = 0;
      pollIntervalRef.current = setInterval(async () => {
        attempts++;
        try {
          const result = await window.cozyPane.preview.scanPortsForCwd(sub.path);
          const newPorts = result.ports || [];
          if (newPorts.length > 0) {
            setDetectedPorts(newPorts);
            setServerState('ready');
            setStatusMessage('');
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
          } else if (attempts >= 30) {
            setServerState('failed');
            setStatusMessage('Server didn\'t start within 30s');
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
          }
        } catch {}
      }, 1000);
    }
  }, [cwd, onSendToTerminal]);

  // Wire webview events
  const wireWebview = useCallback((wv: any, isLocal: boolean) => {
    if (!wv) return;

    const handleConsoleMessage = (e: any) => {
      if (e.level >= 2) {
        setErrors(prev => [...prev.slice(-19), {
          type: 'console',
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
            try {
              const res = await origFetch.apply(this, args);
              if (!res.ok) console.error('[CozyPreview:network] ' + res.status + ' ' + res.statusText + ' - ' + (args[0]?.url || args[0]));
              return res;
            } catch(e) {
              console.error('[CozyPreview:network] Fetch failed: ' + e.message + ' - ' + (args[0]?.url || args[0]));
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

  // Wire local webview
  useEffect(() => {
    const wv = localWebviewRef.current;
    if (!wv || !effectiveLocalUrl) return;
    return wireWebview(wv, true);
  }, [effectiveLocalUrl, wireWebview]);

  // Wire production webview
  useEffect(() => {
    const wv = prodWebviewRef.current;
    if (!wv || !effectiveProdUrl) return;
    return wireWebview(wv, false);
  }, [effectiveProdUrl, wireWebview]);

  // Auto-fix: send errors to Claude
  useEffect(() => {
    if (!autoFix || errors.length === 0 || autoFixSentRef.current) return;
    const timer = setTimeout(() => {
      if (errors.length > 0 && !autoFixSentRef.current) {
        autoFixSentRef.current = true;
        sendErrorsToClaude();
        setTimeout(() => { autoFixSentRef.current = false; }, 30000);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [autoFix, errors]);

  const reload = useCallback(() => {
    setErrors([]);
    autoFixSentRef.current = false;
    if (viewMode === 'local' || viewMode === 'split') localWebviewRef.current?.reload();
    if (viewMode === 'production' || viewMode === 'split') prodWebviewRef.current?.reload();
  }, [viewMode]);

  const sendErrorsToClaude = useCallback(() => {
    if (errors.length === 0) return;
    const errorList = errors
      .slice(-20)
      .map(e => `- [${e.type}] ${e.message}${e.detail ? ` (${e.detail})` : ''}`)
      .join('\n');
    const currentUrl = effectiveLocalUrl || effectiveProdUrl || 'unknown';
    const message = `The preview at ${currentUrl} has these errors. Please fix them:\n\n${errorList}`;
    onSendToTerminal(message);
  }, [errors, effectiveLocalUrl, effectiveProdUrl, onSendToTerminal]);

  const deviceWidth = DEVICE_WIDTHS[device];

  // Force webview src update when URL changes
  useEffect(() => {
    const wv = localWebviewRef.current;
    if (wv && effectiveLocalUrl && wv.src !== effectiveLocalUrl) {
      wv.src = effectiveLocalUrl;
    }
  }, [effectiveLocalUrl]);

  useEffect(() => {
    const wv = prodWebviewRef.current;
    if (wv && effectiveProdUrl && wv.src !== effectiveProdUrl) {
      wv.src = effectiveProdUrl;
    }
  }, [effectiveProdUrl]);

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
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', backgroundColor: '#0a0b10', overflow: 'hidden' }}>
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
          allowpopups="true"
          webpreferences="allowRunningInsecureContent=true"
        />
      </div>
    </div>
  );

  const renderStartingState = () => (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      color: 'var(--text-secondary, #888)',
      gap: '1em',
      padding: '2em',
    }}>
      {/* Spinner */}
      <div style={{
        width: 40, height: 40, borderRadius: '50%',
        border: '3px solid var(--border, #2a2b3e)',
        borderTopColor: 'var(--accent, #7c6fe0)',
        animation: 'spin 1s linear infinite',
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <div style={{ fontSize: '1em', color: 'var(--text-primary, #e0e0e0)', textAlign: 'center' }}>
        {serverState === 'detecting' && 'Detecting project...'}
        {serverState === 'starting' && 'Starting dev server...'}
        {serverState === 'waiting' && 'Waiting for server to be ready...'}
      </div>

      {statusMessage && (
        <div style={{ fontSize: '0.82em', color: 'var(--text-secondary, #888)', fontFamily: 'monospace' }}>
          {statusMessage}
        </div>
      )}

      {projectInfo?.type && (
        <div style={{ fontSize: '0.82em', color: 'var(--text-secondary, #888)' }}>
          Detected <strong style={{ color: 'var(--accent, #7c6fe0)' }}>{projectInfo.type}</strong> project
        </div>
      )}
    </div>
  );

  const renderFailedState = () => (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      color: 'var(--text-secondary, #888)',
      gap: '1em',
      padding: '2em',
    }}>
      <div style={{ fontSize: '1.2em', color: '#e74c3c' }}>
        Server failed to start
      </div>

      {statusMessage && (
        <div style={{ fontSize: '0.82em', color: 'var(--text-secondary, #888)' }}>
          {statusMessage}
        </div>
      )}

      {/* Database hint */}
      {projectInfo?.needsDatabase && (
        <div style={{
          fontSize: '0.85em',
          color: '#e6b800',
          backgroundColor: '#e6b80010',
          border: '1px solid #e6b80030',
          borderRadius: 6,
          padding: '0.6em 1em',
          maxWidth: 400,
          textAlign: 'center',
        }}>
          This app requires a database. Make sure your database server (PostgreSQL, MongoDB, etc.) is running and configured.
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5em' }}>
        {effectiveDevCommand && (
          <button onClick={retryStartServer} style={actionBtnStyle}>
            Retry
          </button>
        )}
        <button onClick={runAiAnalysis} style={secondaryBtnStyle} disabled={analyzing}>
          {analyzing ? 'Analyzing...' : 'AI Analyze'}
        </button>
      </div>

      {detectedPorts.length > 0 && (
        <div style={{ fontSize: '0.82em' }}>
          <span style={{ color: 'var(--text-secondary, #888)' }}>Active ports: </span>
          {detectedPorts.map(p => (
            <button
              key={p}
              onClick={() => { setManualUrl(`http://localhost:${p}`); setServerState('ready'); }}
              style={{ ...portBtnStyle, marginLeft: '0.3em' }}
            >
              :{p}
            </button>
          ))}
        </div>
      )}

      {/* Manual URL fallback */}
      <div style={{ display: 'flex', gap: '0.3em', width: '100%', maxWidth: 400, marginTop: '0.5em' }}>
        <input
          type="text"
          value={manualUrl}
          onChange={e => setManualUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { setManualUrl(manualUrl.trim()); setServerState('ready'); } }}
          placeholder="Or enter URL manually..."
          spellCheck={false}
          style={urlInputStyle}
        />
      </div>
    </div>
  );

  const renderSubProjectPicker = () => (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      color: 'var(--text-secondary, #888)',
      gap: '1em',
      padding: '2em',
    }}>
      <div style={{ fontSize: '1.1em', color: 'var(--text-primary, #e0e0e0)' }}>
        Multiple services detected
      </div>
      <div style={{ fontSize: '0.82em', color: 'var(--text-secondary, #888)' }}>
        Choose which service to preview:
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5em', width: '100%', maxWidth: 350 }}>
        {(projectInfo?.subProjects || []).map(sub => (
          <button
            key={sub.path}
            onClick={() => startSubProject(sub)}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '0.6em 1em',
              borderRadius: 6,
              border: '1px solid var(--border, #3a3b4e)',
              backgroundColor: 'var(--bg-primary, #1a1b2e)',
              color: 'var(--text-primary, #e0e0e0)',
              fontSize: '0.88em',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span>
              <strong>{sub.name}/</strong>
              <span style={{ color: 'var(--text-secondary, #888)', marginLeft: '0.5em', fontSize: '0.9em' }}>{sub.type}</span>
            </span>
            {sub.devCommand && (
              <span style={{ fontSize: '0.78em', color: 'var(--accent, #7c6fe0)', fontFamily: 'monospace' }}>
                {sub.devCommand}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Manual URL fallback */}
      <div style={{ display: 'flex', gap: '0.3em', width: '100%', maxWidth: 400, marginTop: '0.5em' }}>
        <input
          type="text"
          value={manualUrl}
          onChange={e => setManualUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { setManualUrl(manualUrl.trim()); setServerState('ready'); setShowSubPicker(false); } }}
          placeholder="Or enter URL manually..."
          spellCheck={false}
          style={urlInputStyle}
        />
      </div>
    </div>
  );

  const renderIdleState = () => (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      color: 'var(--text-secondary, #888)',
      gap: '1em',
      padding: '2em',
    }}>
      <div style={{ fontSize: '1.2em', color: 'var(--text-primary, #e0e0e0)' }}>
        No dev server detected
      </div>

      {projectInfo?.type && (
        <div style={{ fontSize: '0.85em', color: 'var(--text-secondary, #888)', textAlign: 'center' }}>
          Detected <strong style={{ color: 'var(--accent, #7c6fe0)' }}>{projectInfo.type}</strong> project
        </div>
      )}

      {aiAnalysis?.summary && (
        <div style={{ fontSize: '0.82em', color: 'var(--text-secondary, #888)', textAlign: 'center', maxWidth: 400 }}>
          {aiAnalysis.summary}
        </div>
      )}

      {detectedPorts.length > 0 && (
        <div style={{ fontSize: '0.82em' }}>
          <span style={{ color: 'var(--text-secondary, #888)' }}>Active ports: </span>
          {detectedPorts.map(p => (
            <button
              key={p}
              onClick={() => { setManualUrl(`http://localhost:${p}`); setServerState('ready'); }}
              style={{ ...portBtnStyle, marginLeft: '0.3em' }}
            >
              :{p}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5em', marginTop: '0.5em' }}>
        <button onClick={runAiAnalysis} style={secondaryBtnStyle} disabled={analyzing}>
          {analyzing ? 'Analyzing...' : 'AI Analyze'}
        </button>
      </div>

      {aiAnalysis?.error && (
        <div style={{ fontSize: '0.78em', color: '#e74c3c' }}>{aiAnalysis.error}</div>
      )}

      {/* Manual URL fallback */}
      <div style={{ display: 'flex', gap: '0.3em', width: '100%', maxWidth: 400, marginTop: '0.5em' }}>
        <input
          type="text"
          value={manualUrl}
          onChange={e => setManualUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { setManualUrl(manualUrl.trim()); setServerState('ready'); } }}
          placeholder="Or enter URL manually..."
          spellCheck={false}
          style={urlInputStyle}
        />
      </div>
    </div>
  );

  const showLocal = viewMode === 'local' || viewMode === 'split';
  const showProd = viewMode === 'production' || viewMode === 'split';
  const hasContent = (showLocal && effectiveLocalUrl) || (showProd && effectiveProdUrl);
  const isStarting = serverState === 'detecting' || serverState === 'starting' || serverState === 'waiting';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={toolbarStyle}>
        {/* View mode tabs */}
        <div style={{ display: 'flex', gap: '0.15em' }}>
          <button
            onClick={() => setViewMode('local')}
            style={{ ...modeBtnStyle, ...(viewMode === 'local' ? modeActiveStyle : {}) }}
          >
            Local
            {effectiveLocalUrl && <span style={dotStyle('#5ce0a8')} />}
          </button>
          <button
            onClick={() => setViewMode('production')}
            style={{ ...modeBtnStyle, ...(viewMode === 'production' ? modeActiveStyle : {}) }}
          >
            Prod
            {effectiveProdUrl && <span style={dotStyle('#5cb8f0')} />}
          </button>
          <button
            onClick={() => setViewMode('split')}
            style={{ ...modeBtnStyle, ...(viewMode === 'split' ? modeActiveStyle : {}) }}
            title="Side by side"
          >
            Split
          </button>
        </div>

        {/* Reload */}
        <button onClick={reload} style={toolBtnStyle} title="Reload">
          {loading ? '...' : '\u21BB'}
        </button>

        {/* Device buttons */}
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

        {/* Auto-fix toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3em' }}>
          <span style={{ fontSize: '0.72em', color: 'var(--text-secondary, #888)' }}>Auto-fix</span>
          <button
            onClick={() => setAutoFix(v => !v)}
            style={{
              width: 32, height: 16, borderRadius: 8, border: 'none',
              backgroundColor: autoFix ? 'var(--accent, #7c6fe0)' : 'var(--border, #3a3b4e)',
              cursor: 'pointer', position: 'relative', transition: 'background-color 0.2s', flexShrink: 0,
            }}
          >
            <div style={{
              width: 12, height: 12, borderRadius: '50%', backgroundColor: '#fff',
              position: 'absolute', top: 2, left: autoFix ? 18 : 2, transition: 'left 0.2s',
            }} />
          </button>
        </div>
      </div>

      {/* Status bar showing detected URL */}
      {effectiveLocalUrl && (
        <div style={{
          padding: '0.2em 0.6em',
          fontSize: '0.75em',
          color: 'var(--text-secondary, #888)',
          backgroundColor: 'var(--bg-primary, #1a1b2e)',
          borderBottom: '1px solid var(--border, #2a2b3e)',
          display: 'flex',
          alignItems: 'center',
          gap: '0.4em',
        }}>
          <span style={{ ...dotStyle('#5ce0a8'), position: 'relative', top: 0 }} />
          <span style={{ fontFamily: 'monospace' }}>{effectiveLocalUrl}</span>
          {staticUrl && <span style={{ fontSize: '0.9em', color: 'var(--text-secondary, #666)' }}>(static)</span>}
          {effectiveProdUrl && (
            <>
              <span style={{ margin: '0 0.3em', color: 'var(--border, #3a3b4e)' }}>|</span>
              <span style={{ ...dotStyle('#5cb8f0'), position: 'relative', top: 0 }} />
              <span style={{ fontFamily: 'monospace' }}>{effectiveProdUrl}</span>
            </>
          )}
        </div>
      )}

      {/* Content area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        {showSubPicker && !hasContent ? (
          renderSubProjectPicker()
        ) : isStarting && !hasContent ? (
          renderStartingState()
        ) : serverState === 'failed' && !hasContent ? (
          renderFailedState()
        ) : !hasContent ? (
          renderIdleState()
        ) : (
          <>
            {showLocal && effectiveLocalUrl && renderWebview(effectiveLocalUrl, localWebviewRef, 'Local')}
            {viewMode === 'split' && effectiveLocalUrl && effectiveProdUrl && (
              <div style={{ width: 2, backgroundColor: 'var(--border, #2a2b3e)', flexShrink: 0 }} />
            )}
            {showProd && effectiveProdUrl && renderWebview(effectiveProdUrl, prodWebviewRef, 'Production')}
            {showLocal && !effectiveLocalUrl && renderStartingState()}
            {showProd && !effectiveProdUrl && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary, #666)' }}>
                No production URL detected
              </div>
            )}
          </>
        )}
      </div>

      {/* Error drawer */}
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
                  onClick={(e) => { e.stopPropagation(); sendErrorsToClaude(); }}
                  style={{ ...tinyBtnStyle, color: 'var(--accent, #7c6fe0)', fontWeight: 600 }}
                >
                  Fix with Claude
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setErrors([]); }}
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
  display: 'flex',
  alignItems: 'center',
  padding: '0.35em 0.5em',
  borderBottom: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'var(--bg-secondary, #161822)',
  gap: '0.4em',
};

const toolBtnStyle: React.CSSProperties = {
  padding: '0.2em 0.5em',
  borderRadius: 4,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'transparent',
  color: 'var(--text-secondary, #aaa)',
  fontSize: '0.82em',
  cursor: 'pointer',
  lineHeight: 1,
};

const modeBtnStyle: React.CSSProperties = {
  padding: '0.2em 0.6em',
  borderRadius: 4,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'transparent',
  color: 'var(--text-secondary, #888)',
  fontSize: '0.78em',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '0.3em',
};

const modeActiveStyle: React.CSSProperties = {
  backgroundColor: 'var(--accent, #7c6fe0)',
  color: '#fff',
  borderColor: 'var(--accent, #7c6fe0)',
};

const dotStyle = (color: string): React.CSSProperties => ({
  display: 'inline-block',
  width: 6,
  height: 6,
  borderRadius: '50%',
  backgroundColor: color,
  flexShrink: 0,
});

const actionBtnStyle: React.CSSProperties = {
  padding: '0.5em 1.2em',
  borderRadius: 6,
  border: 'none',
  backgroundColor: 'var(--accent, #7c6fe0)',
  color: '#fff',
  fontSize: '0.88em',
  cursor: 'pointer',
  fontWeight: 600,
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '0.35em 0.8em',
  borderRadius: 4,
  border: '1px solid var(--border, #3a3b4e)',
  backgroundColor: 'transparent',
  color: 'var(--text-secondary, #aaa)',
  fontSize: '0.8em',
  cursor: 'pointer',
};

const portBtnStyle: React.CSSProperties = {
  padding: '0.15em 0.5em',
  borderRadius: 3,
  border: '1px solid var(--accent, #7c6fe0)',
  backgroundColor: 'transparent',
  color: 'var(--accent, #7c6fe0)',
  fontSize: '0.85em',
  cursor: 'pointer',
  fontFamily: 'monospace',
};

const urlInputStyle: React.CSSProperties = {
  flex: 1,
  padding: '0.3em 0.6em',
  borderRadius: 4,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'var(--bg-primary, #1a1b2e)',
  color: 'var(--text-primary, #e0e0e0)',
  fontSize: '0.82em',
  fontFamily: 'inherit',
  outline: 'none',
};

const tinyBtnStyle: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 3,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'transparent',
  color: 'var(--text-secondary, #aaa)',
  fontSize: '0.75em',
  cursor: 'pointer',
};
