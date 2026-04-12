import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';

export type ConfirmFn = (opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}) => Promise<boolean>;

export interface UseTerminalTabsOptions {
  confirm: ConfirmFn;
}

export interface AddTabOptions {
  /** Override the cwd (defaults to the active tab's cwd, or '' if none). */
  cwd?: string;
  customLabel?: string;
  autoCommand?: string;
  launched?: boolean;
  isDevServer?: boolean;
}

export interface UseTerminalTabsReturn {
  // State
  tabs: TerminalTab[];
  activeId: string;
  splitId: string | null;

  // Derived from active tab
  active: TerminalTab;
  cwd: string;
  aiAction: AiAction;
  isClaudeRunning: boolean;

  // Per-tab scoped watcher state
  activityEvents: FileChangeEvent[];
  lastWatcherEvent: FileChangeEvent | null;
  changedFiles: Map<string, 'create' | 'modify' | 'delete'>;

  // Refs exposed for menu/PTY callbacks registered once at mount that
  // must read the latest tab state without a re-subscribe.
  activeIdRef: MutableRefObject<string>;
  splitIdRef: MutableRefObject<string | null>;
  tabsRef: MutableRefObject<TerminalTab[]>;

  // Actions
  addTab: (opts?: AddTabOptions) => void;
  closeTab: (id: string) => Promise<void>;
  /** Close the tab that's currently active. */
  closeActiveTab: () => Promise<void>;
  switchTab: (id: string) => void;
  toggleSplit: (id: string) => void;
  updateTab: (id: string, updates: Partial<TerminalTab>) => void;
  /** Update the active tab's cwd. */
  setActiveCwd: (cwd: string) => void;
  /** Reorder tabs via drag-drop in the tab bar. */
  reorderTabs: (from: number, to: number) => void;
}

interface TabWatcherState {
  activityEvents: FileChangeEvent[];
}

function makeTerminalTab(cwd: string, counter: number, launched = false): TerminalTab {
  const id = `tab-${Date.now()}-${counter}`;
  const label = `Terminal ${counter}`;
  return { id, ptyId: null, label, cwd, aiAction: 'idle', claudeRunning: false, launched };
}

export function useTerminalTabs(options: UseTerminalTabsOptions): UseTerminalTabsReturn {
  const { confirm } = options;

  const tabCounterRef = useRef(1);

  const [tabs, setTabs] = useState<TerminalTab[]>(() => [
    makeTerminalTab('', tabCounterRef.current++),
  ]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  const [splitId, setSplitId] = useState<string | null>(null);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const splitIdRef = useRef(splitId);
  splitIdRef.current = splitId;

  // M50 — per-tab activity cache. The watcher is still process-global
  // (one `fs.watch` at a time), but each tab keeps its own accumulated
  // event history so switching tabs doesn't cross-contaminate the feed.
  const tabWatcherCache = useRef(new Map<string, TabWatcherState>());

  const [activityEvents, setActivityEvents] = useState<FileChangeEvent[]>([]);
  const [lastWatcherEvent, setLastWatcherEvent] = useState<FileChangeEvent | null>(null);
  const activityEventsRef = useRef(activityEvents);
  activityEventsRef.current = activityEvents;
  const prevActiveIdRef = useRef(activeId);

  const active = tabs.find((t) => t.id === activeId) || tabs[0];
  const cwd = active.cwd;
  const aiAction = active.aiAction;
  const isClaudeRunning = active.claudeRunning;

  const changedFiles = useMemo(() => {
    const map = new Map<string, 'create' | 'modify' | 'delete'>();
    for (let i = activityEvents.length - 1; i >= 0; i--) {
      map.set(activityEvents[i].path, activityEvents[i].type);
    }
    return map;
  }, [activityEvents]);

  // Initial mount: default first tab to homedir.
  useEffect(() => {
    if (tabs[0]?.cwd) return;
    window.cozyPane.fs.homedir().then((home) => {
      setTabs((p) => p.map((t, i) => (i === 0 && !t.cwd ? { ...t, cwd: home } : t)));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restart the file watcher whenever the active tab's cwd changes.
  useEffect(() => {
    if (!cwd) return;

    window.cozyPane.watcher.start(cwd);

    const removeListener = window.cozyPane.watcher.onChange((event: FileChangeEvent) => {
      setActivityEvents((prev) => [event, ...prev].slice(0, 200));
      setLastWatcherEvent(event);
    });

    return () => {
      removeListener();
      window.cozyPane.watcher.stop();
    };
  }, [cwd]);

  // Tab switch: save the leaving tab's events, restore the entering tab's.
  useEffect(() => {
    const prevId = prevActiveIdRef.current;
    if (prevId === activeId) return;
    tabWatcherCache.current.set(prevId, {
      activityEvents: activityEventsRef.current,
    });
    const cached = tabWatcherCache.current.get(activeId);
    setActivityEvents(cached?.activityEvents ?? []);
    prevActiveIdRef.current = activeId;
  }, [activeId]);

  const updateTab = useCallback((tabId: string, updates: Partial<TerminalTab>) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, ...updates } : t)));
  }, []);

  const addTab = useCallback((opts?: AddTabOptions) => {
    setTabs((prev) => {
      const currentCwd =
        opts?.cwd ?? (prev.find((t) => t.id === activeIdRef.current)?.cwd || '');
      const newTab = makeTerminalTab(
        currentCwd,
        tabCounterRef.current++,
        opts?.launched ?? false,
      );
      if (opts?.customLabel !== undefined) newTab.customLabel = opts.customLabel;
      if (opts?.autoCommand !== undefined) newTab.autoCommand = opts.autoCommand;
      if (opts?.isDevServer) newTab.isDevServer = true;
      setActiveId(newTab.id);
      return [...prev, newTab];
    });
  }, []);

  const closeTab = useCallback(async (id: string) => {
    const currentTabs = tabsRef.current;
    const tab = currentTabs.find((t) => t.id === id);
    if (!tab || currentTabs.length <= 1) return;

    const ok = await confirm({
      title: 'Close terminal?',
      message: `Close terminal "${tab.customLabel || tab.label}"? Any running processes will be stopped.`,
      confirmLabel: 'Close',
      destructive: true,
    });
    if (!ok) return;

    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      if (tab.ptyId) {
        window.cozyPane.terminal.close(tab.ptyId);
      }
      tabWatcherCache.current.delete(id);
      const remaining = prev.filter((t) => t.id !== id);
      if (id === activeIdRef.current) {
        const idx = prev.findIndex((t) => t.id === id);
        const newActive = remaining[Math.min(idx, remaining.length - 1)] || remaining[0];
        setActiveId(newActive.id);
      }
      if (id === splitIdRef.current) {
        setSplitId(null);
      }
      return remaining;
    });
  }, [confirm]);

  const closeActiveTab = useCallback(() => closeTab(activeIdRef.current), [closeTab]);

  const switchTab = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const toggleSplit = useCallback((id: string) => {
    setSplitId((prev) => {
      if (prev === id) return null;
      if (id === activeIdRef.current) return prev; // Active tab can't be its own split.
      return id;
    });
  }, []);

  const setActiveCwd = useCallback((newCwd: string) => {
    updateTab(activeIdRef.current, { cwd: newCwd });
  }, [updateTab]);

  const reorderTabs = useCallback((from: number, to: number) => {
    setTabs((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  return {
    tabs,
    activeId,
    splitId,
    active,
    cwd,
    aiAction,
    isClaudeRunning,
    activityEvents,
    lastWatcherEvent,
    changedFiles,
    activeIdRef,
    splitIdRef,
    tabsRef,
    addTab,
    closeTab,
    closeActiveTab,
    switchTab,
    toggleSplit,
    updateTab,
    setActiveCwd,
    reorderTabs,
  };
}
