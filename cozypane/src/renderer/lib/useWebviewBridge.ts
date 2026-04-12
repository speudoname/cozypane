import { useCallback, useEffect } from 'react';

interface UseWebviewBridgeOptions {
  localWebviewRef: React.RefObject<any>;
  prodWebviewRef: React.RefObject<any>;
  effectiveLocalUrl: string | null;
  effectiveProdUrl: string | null;
  setConsoleLogs: React.Dispatch<React.SetStateAction<ConsoleLog[]>>;
  setNetworkErrors: React.Dispatch<React.SetStateAction<NetworkError[]>>;
  setErrors: React.Dispatch<React.SetStateAction<PreviewError[]>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  onNetworkRequestRef: React.RefObject<((req: NetworkRequest) => void) | undefined>;
  onScreenshotCapturedRef: React.RefObject<((path: string) => void) | undefined>;
}

/**
 * Wires up webview event listeners for console log capture, network request
 * interception, screenshot capture on navigation, and loading state tracking.
 *
 * Attaches to the local and production webview refs when their URLs are set.
 * Cleans up listeners (including the screenshotTimer) when URLs change or on unmount.
 */
export function useWebviewBridge({
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
}: UseWebviewBridgeOptions): void {
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

      // All-request capture (captures successes too)
      if (e.message.startsWith('[CozyPreview:request]')) {
        try {
          const json = JSON.parse(e.message.slice('[CozyPreview:request]'.length));
          const netErr: NetworkError = {
            method: json.method || 'GET', url: json.url || '',
            status: json.status || 0, statusText: json.statusText || 'Unknown',
            timestamp: Date.now(),
          };
          onNetworkRequestRef.current?.({
            ...netErr, duration: json.duration || 0, size: json.size,
            ok: json.ok ?? (json.status >= 200 && json.status < 400),
          });
          if (!json.ok && json.status !== 0) {
            setNetworkErrors(prev => [...prev.slice(-49), netErr]);
          }
        } catch {}
        return;
      }
      // Legacy handler for older webview injection (backward compat)
      if (e.message.startsWith('[CozyPreview:netdata]')) {
        try {
          const json = JSON.parse(e.message.slice('[CozyPreview:netdata]'.length));
          setNetworkErrors(prev => [...prev.slice(-49), {
            method: json.method || 'GET', url: json.url || '',
            status: json.status || 0, statusText: json.statusText || 'Unknown',
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
      // -3 = ERR_ABORTED (navigation cancelled, not an error)
      // -102 = ERR_CONNECTION_REFUSED (fires for stale sub-paths during tab restore before server responds)
      if (e.errorCode === -3 || e.errorCode === -102) return;
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
            const start = performance.now();
            try {
              const res = await origFetch.apply(this, args);
              const duration = Math.round(performance.now() - start);
              const size = parseInt(res.headers.get('content-length') || '0', 10) || undefined;
              console.error('[CozyPreview:request]' + JSON.stringify({
                method: method, url: url, status: res.status, statusText: res.statusText,
                duration: duration, size: size, ok: res.ok
              }));
              if (!res.ok) {
                console.error('[CozyPreview:network] ' + res.status + ' ' + res.statusText + ' - ' + url);
              }
              return res;
            } catch(e) {
              const duration = Math.round(performance.now() - start);
              console.error('[CozyPreview:request]' + JSON.stringify({
                method: method, url: url, status: 0, statusText: e.message,
                duration: duration, ok: false
              }));
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

    // Debounced auto-capture screenshot on page navigation (max once per 5s)
    let screenshotTimer: ReturnType<typeof setTimeout> | null = null;
    let lastScreenshotTime = 0;
    const handleDidNavigate = () => {
      if (screenshotTimer) clearTimeout(screenshotTimer);
      const elapsed = Date.now() - lastScreenshotTime;
      const delay = Math.max(1000, 5000 - elapsed); // At least 1s after nav, throttle to 5s
      screenshotTimer = setTimeout(async () => {
        lastScreenshotTime = Date.now();
        try {
          const nativeImage = await wv.capturePage();
          const base64 = nativeImage.toPNG().toString('base64');
          const screenshotFile = await window.cozyPane.preview.captureScreenshot(base64);
          onScreenshotCapturedRef.current?.(screenshotFile);
        } catch {}
      }, delay);
    };

    wv.addEventListener('console-message', handleConsoleMessage);
    wv.addEventListener('did-fail-load', handleDidFailLoad);
    wv.addEventListener('did-start-loading', handleDidStartLoading);
    wv.addEventListener('did-stop-loading', handleDidStopLoading);
    wv.addEventListener('dom-ready', injectNetworkWatcher);
    wv.addEventListener('did-navigate', handleDidNavigate);
    wv.addEventListener('did-navigate-in-page', handleDidNavigate);

    return () => {
      if (screenshotTimer) clearTimeout(screenshotTimer);
      wv.removeEventListener('console-message', handleConsoleMessage);
      wv.removeEventListener('did-fail-load', handleDidFailLoad);
      wv.removeEventListener('did-navigate', handleDidNavigate);
      wv.removeEventListener('did-navigate-in-page', handleDidNavigate);
      wv.removeEventListener('did-start-loading', handleDidStartLoading);
      wv.removeEventListener('did-stop-loading', handleDidStopLoading);
      wv.removeEventListener('dom-ready', injectNetworkWatcher);
    };
  }, [setConsoleLogs, setNetworkErrors, setErrors, setLoading, onNetworkRequestRef, onScreenshotCapturedRef]);

  useEffect(() => {
    const wv = localWebviewRef.current;
    if (!wv || !effectiveLocalUrl) return;
    return wireWebview(wv);
  }, [effectiveLocalUrl, wireWebview, localWebviewRef]);

  useEffect(() => {
    const wv = prodWebviewRef.current;
    if (!wv || !effectiveProdUrl) return;
    return wireWebview(wv);
  }, [effectiveProdUrl, wireWebview, prodWebviewRef]);
}
