import React, { useState, useRef, useCallback, useEffect } from 'react';

interface PreviewError {
  type: 'console' | 'network' | 'load';
  message: string;
  timestamp: number;
  detail?: string;
}

interface Props {
  url?: string;
  onSendToTerminal: (command: string) => void;
  onClose: () => void;
}

type DeviceMode = 'desktop' | 'tablet' | 'phone';

const DEVICE_WIDTHS: Record<DeviceMode, number | null> = {
  desktop: null, // full width
  tablet: 768,
  phone: 375,
};

export default function Preview({ url: initialUrl, onSendToTerminal, onClose }: Props) {
  const [url, setUrl] = useState(initialUrl || '');
  const [urlInput, setUrlInput] = useState(initialUrl || '');
  const [device, setDevice] = useState<DeviceMode>('desktop');
  const [autoFix, setAutoFix] = useState(false);
  const [errors, setErrors] = useState<PreviewError[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const webviewRef = useRef<any>(null);
  const autoFixSentRef = useRef(false);

  // Update URL when prop changes
  useEffect(() => {
    if (initialUrl && initialUrl !== url) {
      setUrl(initialUrl);
      setUrlInput(initialUrl);
      setErrors([]);
      autoFixSentRef.current = false;
    }
  }, [initialUrl]);

  // Wire up webview events after it mounts
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || !url) return;

    const handleConsoleMessage = (e: any) => {
      // Only capture errors and warnings
      if (e.level >= 2) { // 2 = warning, 3 = error
        setErrors(prev => [...prev, {
          type: 'console',
          message: e.message,
          timestamp: Date.now(),
          detail: `Line ${e.line} in ${e.sourceId}`,
        }]);
      }
    };

    const handleDidFailLoad = (e: any) => {
      if (e.errorCode === -3) return; // Aborted, ignore
      setErrors(prev => [...prev, {
        type: 'load',
        message: `Page failed to load: ${e.errorDescription}`,
        timestamp: Date.now(),
        detail: `Error code: ${e.errorCode}, URL: ${e.validatedURL}`,
      }]);
      setLoading(false);
    };

    const handleDidStartLoading = () => setLoading(true);
    const handleDidStopLoading = () => setLoading(false);

    const handleDidNavigate = (e: any) => {
      setUrlInput(e.url);
    };

    wv.addEventListener('console-message', handleConsoleMessage);
    wv.addEventListener('did-fail-load', handleDidFailLoad);
    wv.addEventListener('did-start-loading', handleDidStartLoading);
    wv.addEventListener('did-stop-loading', handleDidStopLoading);
    wv.addEventListener('did-navigate', handleDidNavigate);
    wv.addEventListener('did-navigate-in-page', handleDidNavigate);

    // Inject network error interceptor after page loads
    const injectNetworkWatcher = () => {
      wv.executeJavaScript(`
        (function() {
          if (window.__cozyPreviewInjected) return;
          window.__cozyPreviewInjected = true;

          // Intercept fetch errors
          const origFetch = window.fetch;
          window.fetch = async function(...args) {
            try {
              const res = await origFetch.apply(this, args);
              if (!res.ok) {
                console.error('[CozyPreview:network] ' + res.status + ' ' + res.statusText + ' - ' + (args[0]?.url || args[0]));
              }
              return res;
            } catch(e) {
              console.error('[CozyPreview:network] Fetch failed: ' + e.message + ' - ' + (args[0]?.url || args[0]));
              throw e;
            }
          };

          // Intercept XHR errors
          const origOpen = XMLHttpRequest.prototype.open;
          const origSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function(method, url) {
            this.__cozyUrl = url;
            this.__cozyMethod = method;
            return origOpen.apply(this, arguments);
          };
          XMLHttpRequest.prototype.send = function() {
            this.addEventListener('loadend', function() {
              if (this.status >= 400) {
                console.error('[CozyPreview:network] ' + this.__cozyMethod + ' ' + this.status + ' - ' + this.__cozyUrl);
              }
            });
            this.addEventListener('error', function() {
              console.error('[CozyPreview:network] Request failed: ' + this.__cozyMethod + ' ' + this.__cozyUrl);
            });
            return origSend.apply(this, arguments);
          };

          // Catch unhandled errors
          window.addEventListener('error', function(e) {
            console.error('[CozyPreview:error] ' + e.message + ' at ' + e.filename + ':' + e.lineno);
          });

          // Catch unhandled promise rejections
          window.addEventListener('unhandledrejection', function(e) {
            console.error('[CozyPreview:error] Unhandled promise rejection: ' + (e.reason?.message || e.reason));
          });
        })();
      `).catch(() => {});
    };

    wv.addEventListener('dom-ready', injectNetworkWatcher);

    return () => {
      wv.removeEventListener('console-message', handleConsoleMessage);
      wv.removeEventListener('did-fail-load', handleDidFailLoad);
      wv.removeEventListener('did-start-loading', handleDidStartLoading);
      wv.removeEventListener('did-stop-loading', handleDidStopLoading);
      wv.removeEventListener('did-navigate', handleDidNavigate);
      wv.removeEventListener('did-navigate-in-page', handleDidNavigate);
      wv.removeEventListener('dom-ready', injectNetworkWatcher);
    };
  }, [url]);

  // Auto-fix: send errors to Claude when they accumulate
  useEffect(() => {
    if (!autoFix || errors.length === 0 || autoFixSentRef.current) return;

    const timer = setTimeout(() => {
      if (errors.length > 0 && !autoFixSentRef.current) {
        autoFixSentRef.current = true;
        sendErrorsToClaude();
        // Reset after 30s to allow re-triggering
        setTimeout(() => { autoFixSentRef.current = false; }, 30000);
      }
    }, 3000); // Wait 3s for errors to settle

    return () => clearTimeout(timer);
  }, [autoFix, errors]);

  const navigate = useCallback(() => {
    let target = urlInput.trim();
    if (!target) return;
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      target = 'https://' + target;
    }
    setUrl(target);
    setUrlInput(target);
    setErrors([]);
    autoFixSentRef.current = false;
  }, [urlInput]);

  const reload = useCallback(() => {
    const wv = webviewRef.current;
    if (wv) {
      setErrors([]);
      autoFixSentRef.current = false;
      wv.reload();
    }
  }, []);

  const sendErrorsToClaude = useCallback(() => {
    if (errors.length === 0) return;
    const errorList = errors
      .slice(-20) // Last 20 errors
      .map(e => `- [${e.type}] ${e.message}${e.detail ? ` (${e.detail})` : ''}`)
      .join('\n');
    const message = `The preview at ${url} has these errors. Please fix them:\n\n${errorList}`;
    onSendToTerminal(message);
  }, [errors, url, onSendToTerminal]);

  const deviceWidth = DEVICE_WIDTHS[device];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={toolbarStyle}>
        {/* URL bar */}
        <div style={{ display: 'flex', flex: 1, gap: '0.3em', alignItems: 'center' }}>
          <input
            type="text"
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && navigate()}
            placeholder="Enter URL..."
            spellCheck={false}
            style={urlInputStyle}
          />
          <button onClick={reload} style={toolBtnStyle} title="Reload">
            {loading ? '...' : '\u21BB'}
          </button>
        </div>

        {/* Device buttons */}
        <div style={{ display: 'flex', gap: '0.2em', marginLeft: '0.5em' }}>
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

        {/* Auto-fix toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3em', marginLeft: '0.5em' }}>
          <span style={{ fontSize: '0.72em', color: 'var(--text-secondary, #888)' }}>Auto-fix</span>
          <button
            onClick={() => setAutoFix(v => !v)}
            style={{
              width: 32,
              height: 16,
              borderRadius: 8,
              border: 'none',
              backgroundColor: autoFix ? 'var(--accent, #7c6fe0)' : 'var(--border, #3a3b4e)',
              cursor: 'pointer',
              position: 'relative',
              transition: 'background-color 0.2s',
              flexShrink: 0,
            }}
          >
            <div style={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              backgroundColor: '#fff',
              position: 'absolute',
              top: 2,
              left: autoFix ? 18 : 2,
              transition: 'left 0.2s',
            }} />
          </button>
        </div>

        {/* Close */}
        <button onClick={onClose} style={{ ...toolBtnStyle, marginLeft: '0.3em' }} title="Close preview">
          &times;
        </button>
      </div>

      {/* Webview container */}
      <div style={{
        flex: 1,
        display: 'flex',
        justifyContent: 'center',
        backgroundColor: '#0a0b10',
        overflow: 'hidden',
        position: 'relative',
      }}>
        {url ? (
          <webview
            ref={webviewRef}
            src={url}
            style={{
              width: deviceWidth ? `${deviceWidth}px` : '100%',
              height: '100%',
              border: deviceWidth ? '1px solid var(--border, #2a2b3e)' : 'none',
              borderRadius: deviceWidth ? '8px' : '0',
              backgroundColor: '#fff',
            }}
            // @ts-ignore — webview attributes
            allowpopups="true"
          />
        ) : (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--text-secondary, #666)',
            fontSize: '0.9em',
          }}>
            Enter a URL above or deploy an app to preview it
          </div>
        )}
      </div>

      {/* Error drawer */}
      <div style={{
        borderTop: '1px solid var(--border, #2a2b3e)',
        backgroundColor: 'var(--bg-secondary, #161822)',
      }}>
        {/* Drawer header */}
        <div
          onClick={() => setDrawerOpen(v => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.3em 0.6em',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4em' }}>
            <span style={{ fontSize: '0.78em', color: 'var(--text-secondary, #888)' }}>
              {drawerOpen ? '\u25BC' : '\u25B6'} Errors
            </span>
            {errors.length > 0 && (
              <span style={{
                fontSize: '0.7em',
                padding: '0 5px',
                borderRadius: 8,
                backgroundColor: '#e74c3c33',
                color: '#e74c3c',
                fontWeight: 600,
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

        {/* Drawer body */}
        {drawerOpen && (
          <div style={{
            maxHeight: 200,
            overflowY: 'auto',
            padding: '0 0.6em 0.4em',
          }}>
            {errors.length === 0 ? (
              <div style={{ fontSize: '0.78em', color: 'var(--text-secondary, #666)', padding: '0.5em 0' }}>
                No errors captured
              </div>
            ) : (
              errors.map((err, i) => (
                <div key={i} style={{
                  padding: '0.25em 0',
                  borderBottom: '1px solid var(--border, #1e1f32)',
                  fontSize: '0.75em',
                }}>
                  <div style={{ display: 'flex', gap: '0.4em', alignItems: 'baseline' }}>
                    <span style={{
                      color: err.type === 'console' ? '#e74c3c' : err.type === 'network' ? '#e6b800' : '#e74c3c',
                      fontWeight: 600,
                      fontSize: '0.9em',
                      textTransform: 'uppercase',
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
  gap: '0.2em',
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

const tinyBtnStyle: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 3,
  border: '1px solid var(--border, #2a2b3e)',
  backgroundColor: 'transparent',
  color: 'var(--text-secondary, #aaa)',
  fontSize: '0.75em',
  cursor: 'pointer',
};
