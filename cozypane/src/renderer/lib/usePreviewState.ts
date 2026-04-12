import { useState, useCallback, useRef, useEffect } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { usePersistedState } from './usePersistedState';

export interface UsePreviewStateOptions {
  terminalTabsRef: MutableRefObject<TerminalTab[]>;
  activeTerminalIdRef: MutableRefObject<string>;
  activeTerminalId: string;
  cwd: string;
  updateTab: (id: string, patch: Partial<TerminalTab>) => void;
  setPreviewOpen: Dispatch<SetStateAction<boolean>>;
}

export interface UsePreviewStateReturn {
  previewLocalUrl: string;
  previewLocalUrls: string[];
  previewProdUrl: string;
  previewInitialErrors: PreviewError[];
  previewInitialConsoleLogs: ConsoleLog[];
  previewInitialNetworkErrors: NetworkError[];
  networkRequests: NetworkRequest[];
  liveConsoleLogs: ConsoleLog[];
  screenshotPath: string | null;
  screenshotTimestamp: number;
  autoPreviewDisabled: boolean;
  autoPreviewDisabledRef: MutableRefObject<boolean>;
  toggleAutoPreview: () => void;
  autoPreviewToast: string | null;
  setAutoPreviewToast: Dispatch<SetStateAction<string | null>>;
  showAutoPreviewToast: (url: string) => void;
  handleRefreshSnapshot: () => void;
  handleDevServerStateChange: (tabId: string, state: DevServerState) => void;
  handleLocalUrlDetected: (tabId: string, url: string) => void;
  handleLocalUrlsDetected: (tabId: string, urls: string[]) => void;
  handleProdUrlDetected: (tabId: string, url: string) => void;
  setLiveConsoleLogs: Dispatch<SetStateAction<ConsoleLog[]>>;
  setNetworkRequests: Dispatch<SetStateAction<NetworkRequest[]>>;
  setScreenshotPath: Dispatch<SetStateAction<string | null>>;
  setScreenshotTimestamp: Dispatch<SetStateAction<number>>;
}

export function usePreviewState({
  terminalTabsRef,
  activeTerminalIdRef,
  activeTerminalId,
  cwd,
  updateTab,
  setPreviewOpen,
}: UsePreviewStateOptions): UsePreviewStateReturn {
  const [previewLocalUrl, setPreviewLocalUrl] = useState<string>('');
  const [previewLocalUrls, setPreviewLocalUrls] = useState<string[]>([]);
  const [previewProdUrl, setPreviewProdUrl] = useState<string>('');
  const [previewInitialErrors, setPreviewInitialErrors] = useState<PreviewError[]>([]);
  const [previewInitialConsoleLogs, setPreviewInitialConsoleLogs] = useState<ConsoleLog[]>([]);
  const [previewInitialNetworkErrors, setPreviewInitialNetworkErrors] = useState<NetworkError[]>([]);
  const [networkRequests, setNetworkRequests] = useState<NetworkRequest[]>([]);
  const [liveConsoleLogs, setLiveConsoleLogs] = useState<ConsoleLog[]>([]);
  const [screenshotPath, setScreenshotPath] = useState<string | null>(null);
  const [screenshotTimestamp, setScreenshotTimestamp] = useState(0);

  // Auto-preview toggle (persisted)
  const [autoPreviewDisabled, setAutoPreviewDisabled] = usePersistedState<boolean>('autoPreviewDisabled', false);
  const autoPreviewDisabledRef = useRef(autoPreviewDisabled);
  autoPreviewDisabledRef.current = autoPreviewDisabled;
  const toggleAutoPreview = useCallback(() => {
    setAutoPreviewDisabled(prev => !prev);
  }, [setAutoPreviewDisabled]);

  // Auto-preview toast with cleanup on unmount
  const [autoPreviewToast, setAutoPreviewToast] = useState<string | null>(null);
  const autoPreviewToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showAutoPreviewToast = useCallback((url: string) => {
    if (autoPreviewToastTimer.current) clearTimeout(autoPreviewToastTimer.current);
    setAutoPreviewToast(url);
    autoPreviewToastTimer.current = setTimeout(() => setAutoPreviewToast(null), 4000);
  }, []);
  useEffect(() => () => {
    if (autoPreviewToastTimer.current) clearTimeout(autoPreviewToastTimer.current);
  }, []);

  const handleRefreshSnapshot = useCallback(() => {
    setScreenshotTimestamp(Date.now());
  }, []);

  // Debounced inspect data persistence — uses refs to avoid effect churn
  // on every console log / network request.
  const networkRequestsRef = useRef(networkRequests);
  networkRequestsRef.current = networkRequests;
  const liveConsoleLogsRef = useRef(liveConsoleLogs);
  liveConsoleLogsRef.current = liveConsoleLogs;
  const screenshotPathRef = useRef(screenshotPath);
  screenshotPathRef.current = screenshotPath;
  const previewLocalUrlRef = useRef(previewLocalUrl);
  previewLocalUrlRef.current = previewLocalUrl;
  const previewProdUrlRef = useRef(previewProdUrl);
  previewProdUrlRef.current = previewProdUrl;

  const inspectWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Schedule a write whenever meaningful data changes. The refs avoid
    // re-running the effect on every array update — only cwd changes
    // trigger the effect; the timer reads current values from refs.
    if (inspectWriteTimer.current) clearTimeout(inspectWriteTimer.current);
    inspectWriteTimer.current = setTimeout(() => {
      if (networkRequestsRef.current.length === 0 && liveConsoleLogsRef.current.length === 0) return;
      const devTab = terminalTabsRef.current.find(t => t.isDevServer && t.cwd === cwd);
      window.cozyPane.preview.writeInspectData({
        consoleLogs: liveConsoleLogsRef.current.slice(-200),
        networkRequests: networkRequestsRef.current.slice(-200),
        devServer: devTab?.devServerState || null,
        screenshotPath: screenshotPathRef.current,
        url: previewLocalUrlRef.current || previewProdUrlRef.current || null,
        timestamp: Date.now(),
      }).catch(() => {});
    }, 3000);
    return () => { if (inspectWriteTimer.current) clearTimeout(inspectWriteTimer.current); };
  }, [cwd]);

  // Debounced dev server state persistence (2s)
  const devServerWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleDevServerStateChange = useCallback((tabId: string, state: DevServerState) => {
    updateTab(tabId, { devServerState: state });
    if (devServerWriteTimer.current) clearTimeout(devServerWriteTimer.current);
    devServerWriteTimer.current = setTimeout(() => {
      window.cozyPane.preview.writeDevServerState(state).catch(() => {});
    }, 2000);
  }, [updateTab]);

  // Restore preview URLs + console state on tab switch
  useEffect(() => {
    const newTab = terminalTabsRef.current.find(t => t.id === activeTerminalId);
    let localUrl = newTab?.previewLocalUrl || '';
    let localUrls = newTab?.previewLocalUrls || [];
    let prodUrl = newTab?.previewProdUrl || '';
    if (!localUrl && newTab?.cwd) {
      const companion = terminalTabsRef.current.find(
        t => t.id !== activeTerminalId && t.cwd === newTab.cwd && t.previewLocalUrl
      );
      if (companion) {
        localUrl = companion.previewLocalUrl || '';
        localUrls = companion.previewLocalUrls || [];
        prodUrl = companion.previewProdUrl || prodUrl;
      }
    }
    setPreviewLocalUrl(localUrl);
    setPreviewLocalUrls(localUrls);
    setPreviewProdUrl(prodUrl);
    setPreviewInitialErrors(newTab?.previewErrors || []);
    setPreviewInitialConsoleLogs(newTab?.previewConsoleLogs || []);
    setPreviewInitialNetworkErrors(newTab?.previewNetworkErrors || []);
    if (localUrl && newTab && !newTab.devServerAutoOpened && !autoPreviewDisabledRef.current) {
      updateTab(activeTerminalId, { devServerAutoOpened: true });
      setPreviewOpen(true);
      showAutoPreviewToast(localUrl);
    }
  }, [activeTerminalId]);

  // Helper: check if a tab is the active tab or shares cwd with it
  const isActiveOrCompanion = useCallback((tabId: string): boolean => {
    if (tabId === activeTerminalIdRef.current) return true;
    const activeTab = terminalTabsRef.current.find(t => t.id === activeTerminalIdRef.current);
    const tab = terminalTabsRef.current.find(t => t.id === tabId);
    return !!(activeTab && tab && tab.cwd === activeTab.cwd);
  }, [terminalTabsRef, activeTerminalIdRef]);

  // Health-check retry chain with cancellation on unmount
  const healthCheckAbortRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { healthCheckAbortRef.current?.(); }, []);

  const handleLocalUrlDetected = useCallback((tabId: string, url: string) => {
    updateTab(tabId, { previewLocalUrl: url });
    if (!isActiveOrCompanion(tabId)) return;
    setPreviewLocalUrl(url);
    const fresh = terminalTabsRef.current.find(t => t.id === tabId);
    if (fresh && !fresh.devServerAutoOpened && !autoPreviewDisabledRef.current) {
      updateTab(tabId, { devServerAutoOpened: true });
      let cancelled = false;
      healthCheckAbortRef.current = () => { cancelled = true; };
      const check = (attempt: number) => {
        if (cancelled) return;
        fetch(url, { mode: 'no-cors' }).then(() => {
          if (cancelled) return;
          setPreviewOpen(true);
          showAutoPreviewToast(url);
        }).catch(() => {
          if (!cancelled && attempt < 10) setTimeout(() => check(attempt + 1), 800);
        });
      };
      check(0);
    }
  }, [updateTab, terminalTabsRef, activeTerminalIdRef, setPreviewOpen, showAutoPreviewToast, isActiveOrCompanion]);

  const handleLocalUrlsDetected = useCallback((tabId: string, urls: string[]) => {
    updateTab(tabId, { previewLocalUrls: urls });
    if (isActiveOrCompanion(tabId)) setPreviewLocalUrls(urls);
  }, [updateTab, isActiveOrCompanion]);

  const handleProdUrlDetected = useCallback((tabId: string, url: string) => {
    updateTab(tabId, { previewProdUrl: url });
    if (isActiveOrCompanion(tabId)) setPreviewProdUrl(url);
  }, [updateTab, isActiveOrCompanion]);

  return {
    previewLocalUrl, previewLocalUrls, previewProdUrl,
    previewInitialErrors, previewInitialConsoleLogs, previewInitialNetworkErrors,
    networkRequests, liveConsoleLogs, screenshotPath, screenshotTimestamp,
    autoPreviewDisabled, autoPreviewDisabledRef, toggleAutoPreview,
    autoPreviewToast, setAutoPreviewToast, showAutoPreviewToast,
    handleRefreshSnapshot, handleDevServerStateChange,
    handleLocalUrlDetected, handleLocalUrlsDetected, handleProdUrlDetected,
    setLiveConsoleLogs, setNetworkRequests, setScreenshotPath, setScreenshotTimestamp,
  };
}
