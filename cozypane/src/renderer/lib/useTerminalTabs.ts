import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';

// useTerminalTabs — terminal-tab state machine + per-tab watcher scoping.
//
// Before this hook existed, App.tsx had ~150 lines of interleaved state
// for:
//   - `terminalTabs`, `activeTerminalId`, `splitTerminalId`
//   - three ref-mirror patterns (`activeTerminalIdRef`, `splitTerminalIdRef`,
//     `terminalTabsRef`) so stale callbacks could read the current value
//   - `tabWatcherCache` — per-tab cached activityEvents
//   - `activityEvents` + `lastWatcherEvent` scoped to the active tab
//   - a save/restore effect that swapped event caches on tab switch
//   - a tab-counter ref
//   - `addTerminalTab`, `closeTerminalTab`, `switchTerminalTab`, `toggleSplit`,
//     `updateTab` callbacks
//   - a mount-time homedir init effect
//   - a `watcher:start` / `watcher:stop` lifecycle effect keyed on cwd
//   - the `changedFiles` useMemo derived from activityEvents
//
// Audit findings closed by this extraction:
//   - H19 (App.tsx decomposition, the biggest slice)
//   - M50 (per-tab file watcher — already partially implemented via
//     `tabWatcherCache` but now owned by the hook with clearer semantics)
//
// The hook exposes the refs explicitly so existing App.tsx callbacks can
// still read the latest values without a re-subscribe.

export type ConfirmFn = (opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}) => Promise<boolean>;

export interface UseTerminalTabsOptions {
  /** Pass in the `useConfirm()` fn from App.tsx so the close-tab prompt is themed. */
  confirm: ConfirmFn;
}

export interface UseTerminalTabsReturn {
  // --- State ---
  tabs: TerminalTab[];
  activeId: string;
  splitId: string | null;

  // --- Derived from active tab ---
  active: TerminalTab;
  cwd: string;
  aiAction: AiAction;
  isClaudeRunning: boolean;

  // --- Per-tab scoped watcher state ---
  activityEvents: FileChangeEvent[];
  lastWatcherEvent: FileChangeEvent | null;
  changedFiles: Map<string, 'create' | 'modify' | 'delete'>;

  // --- Refs exposed for callbacks that need the latest value ---
  activeIdRef: MutableRefObject<string>;
  splitIdRef: MutableRefObject<string | null>;
  tabsRef: MutableRefObject<TerminalTab[]>;

  // --- Setters that App.tsx needs for tab metadata updates ---
  setTabs: React.Dispatch<React.SetStateAction<TerminalTab[]>>;
  setActiveId: React.Dispatch<React.SetStateAction<string>>;
  setSplitId: React.Dispatch<React.SetStateAction<string | null>>;

  // --- Actions ---
  addTab: (opts?: AddTabOptions) => void;
  closeTab: (id: string) => Promise<void>;
  switchTab: (id: string) => void;
  toggleSplit: (id: string) => void;
  updateTab: (id: string, updates: Partial<TerminalTab>) => void;
}

export interface AddTabOptions {
  /** Override the cwd (defaults to the active tab's cwd, or '' if none). */
  cwd?: string;
  customLabel?: string;
  autoCommand?: string;
  launched?: boolean;
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

  // Monotonic counter for tab labels. Refs survive across renders.
  const tabCounterRef = useRef(1);

  // Core state
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [
    makeTerminalTab('', tabCounterRef.current++),
  ]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  const [splitId, setSplitId] = useState<string | null>(null);

  // Ref mirrors so callbacks can read the latest values without stale
  // closures. This is the pattern the audit flagged as "ad-hoc" — still
  // ad-hoc but now contained inside a single hook rather than scattered
  // across the App component.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const splitIdRef = useRef(splitId);
  splitIdRef.current = splitId;

  // Per-tab activity event cache. The audit's M50 was "watcher is
  // single-global; events leak between tabs with the same cwd". The
  // fix: each tab has its own accumulated activityEvents array, and
  // switching tabs swaps to the entering tab's cache.
  const tabWatcherCache = useRef(new Map<string, TabWatcherState>());

  // Active tab's live activity feed — the one currently displayed.
  const [activityEvents, setActivityEvents] = useState<FileChangeEvent[]>([]);
  const [lastWatcherEvent, setLastWatcherEvent] = useState<FileChangeEvent | null>(null);
  const activityEventsRef = useRef(activityEvents);
  activityEventsRef.current = activityEvents;
  const prevActiveIdRef = useRef(activeId);

  // Derived values
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

  // --- Initial mount: set first tab's cwd to home directory ---
  useEffect(() => {
    if (tabs[0]?.cwd) return;
    window.cozyPane.fs.homedir().then((home) => {
      setTabs((p) => p.map((t, i) => (i === 0 && !t.cwd ? { ...t, cwd: home } : t)));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- File watcher lifecycle, keyed on active tab's cwd ---
  // When the user switches tabs or cd's into a new directory, restart
  // the watcher with the new cwd. When no tab is active, stop the watcher.
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

  // --- Tab switch: save leaving tab's activity events, restore entering tab's ---
  // This is the M50 per-tab watcher semantics: each tab has its own
  // cached event history so switching back to a previously-visited tab
  // shows its own activity feed, not the currently-live one.
  useEffect(() => {
    const prevId = prevActiveIdRef.current;
    if (prevId === activeId) return;
    // Save events from the tab we're leaving
    tabWatcherCache.current.set(prevId, {
      activityEvents: activityEventsRef.current,
    });
    // Restore events for the tab we're entering
    const cached = tabWatcherCache.current.get(activeId);
    setActivityEvents(cached?.activityEvents ?? []);
    prevActiveIdRef.current = activeId;
  }, [activeId]);

  // --- Actions ---

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
      setActiveId(newTab.id);
      return [...prev, newTab];
    });
  }, []);

  const closeTab = useCallback(async (id: string) => {
    const currentTabs = tabsRef.current;
    const tab = currentTabs.find((t) => t.id === id);
    if (!tab || currentTabs.length <= 1) return; // Can't close last tab

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
      // If closing the active tab, switch to the adjacent one
      if (id === activeIdRef.current) {
        const idx = prev.findIndex((t) => t.id === id);
        const newActive = remaining[Math.min(idx, remaining.length - 1)] || remaining[0];
        setActiveId(newActive.id);
      }
      // Clear split if it was the split tab
      if (id === splitIdRef.current) {
        setSplitId(null);
      }
      return remaining;
    });
  }, [confirm]);

  const switchTab = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const toggleSplit = useCallback((id: string) => {
    setSplitId((prev) => {
      if (prev === id) return null; // Un-split
      if (id === activeIdRef.current) return prev; // Can't split the active tab as its own split
      return id;
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
    setTabs,
    setActiveId,
    setSplitId,
    addTab,
    closeTab,
    switchTab,
    toggleSplit,
    updateTab,
  };
}
