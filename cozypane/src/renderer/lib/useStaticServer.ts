import { useState, useRef, useEffect } from 'react';

/**
 * Manages the static file server lifecycle for Preview.
 * Starts a static server when no dev server URL is detected and the project
 * supports static serving. Stops the old server when cwd changes.
 */
export function useStaticServer(cwd: string, localUrl: string | undefined): {
  staticUrl: string | null;
  staticError: string | null;
} {
  const [staticUrl, setStaticUrl] = useState<string | null>(null);
  const [staticError, setStaticError] = useState<string | null>(null);
  const staticCwdRef = useRef<string>('');

  useEffect(() => {
    if (!cwd) return;
    if (staticCwdRef.current && staticCwdRef.current !== cwd) {
      window.cozyPane.preview.stopStatic(staticCwdRef.current).catch(() => {});
      staticCwdRef.current = '';
      setStaticUrl(null);
      setStaticError(null);
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
          if (result.error) {
            setStaticError(`Could not start static server: ${result.error}`);
          } else {
            staticCwdRef.current = cwd;
            setStaticUrl(`http://localhost:${result.port}`);
          }
        }
      } catch (e) {
        if (!cancelled) setStaticError(`Could not start static server: ${String(e)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [cwd, localUrl]);

  // Stop the static server on unmount so we don't leak the process
  useEffect(() => () => {
    if (staticCwdRef.current) {
      window.cozyPane.preview.stopStatic(staticCwdRef.current).catch(() => {});
    }
  }, []);

  return { staticUrl, staticError };
}
