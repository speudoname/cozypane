import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useDragResize } from './lib/useDragResize';
import { useConfirm } from './lib/confirmContext';
import { Eye, GitBranch, Rocket, Settings2 } from 'lucide-react';
import Sidebar from './components/Sidebar';
import FilePreview from './components/FilePreview';
import Terminal from './components/Terminal';
import StatusBar from './components/StatusBar';
import DiffViewer from './components/DiffViewer';
import Settings from './components/Settings';
import GitPanel from './components/GitPanel';
import DeployPanel from './components/DeployPanel';
import Preview from './components/Preview';
import ErrorBoundary from './components/ErrorBoundary';
import TabLauncher from './components/TabLauncher';
import UpdateBanner from './components/UpdateBanner';
import { enableCozyMode } from './lib/cozyMode';

import CommandPalette from './components/CommandPalette';
import type { PaletteAction } from './components/CommandPalette';
import TerminalTabBar from './components/TerminalTabBar';
// PreviewError, ConsoleLog, NetworkError, TerminalTab are declared in the
// global ambient types (src/renderer/types.d.ts) — no explicit import needed.
import type { AiAction } from './lib/terminalAnalyzer';

type LayoutMode = 'two-col' | 'three-col';
type RightPanelTab = 'preview' | 'settings' | 'git' | 'deploy';

function loadPersisted<T>(key: string, fallback: T): T {
  try {
    const val = localStorage.getItem(`cozyPane:${key}`);
    return val ? JSON.parse(val) : fallback;
  } catch { return fallback; }
}

function savePersisted(key: string, value: any) {
  try { localStorage.setItem(`cozyPane:${key}`, JSON.stringify(value)); } catch {}
}

interface OpenTab {
  path: string;
  name: string;
  dirty?: boolean;
}

interface DiffState {
  filePath: string;
  before: string;
  after: string;
}

function makeTerminalTab(cwd: string, counter: number, launched = false): TerminalTab {
  const id = `tab-${Date.now()}-${counter}`;
  const label = `Terminal ${counter}`;
  return { id, ptyId: null, label, cwd, aiAction: 'idle', claudeRunning: false, launched };
}

export default function App() {
  const confirm = useConfirm();
  const [panelsOpen, setPanelsOpen] = useState(() => loadPersisted('panelsOpen', true));
  const terminalCounterRef = useRef(1);
  const [openTabs, setOpenTabs] = useState<OpenTab[]>(() => loadPersisted('openTabs', []));
  const [activeTab, setActiveTab] = useState<string | null>(() => loadPersisted('activeTab', null));
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => loadPersisted('layoutMode', 'two-col'));
  const [panelWidth, setPanelWidth] = useState(() => loadPersisted('panelWidth', 360));
  const [isResizing, setIsResizing] = useState(false);
  const [sidebarRatio, setSidebarRatio] = useState(() => loadPersisted('sidebarRatio', 0.35));
  // (resize cleanup refs have moved into the useDragResize hook in lib/useDragResize.ts)
  const [activityEvents, setActivityEvents] = useState<FileChangeEvent[]>([]);
  const [lastWatcherEvent, setLastWatcherEvent] = useState<FileChangeEvent | null>(null);

  // Per-tab watcher state cache
  interface TabWatcherState {
    activityEvents: FileChangeEvent[];
  }
  const tabWatcherCache = useRef(new Map<string, TabWatcherState>());
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>(() => {
    const saved = loadPersisted<string>('rightPanelTab', 'preview');
    const valid: RightPanelTab[] = ['preview', 'settings', 'git', 'deploy'];
    return valid.includes(saved as RightPanelTab) ? (saved as RightPanelTab) : 'preview';
  });
  const [previewLocalUrl, setPreviewLocalUrl] = useState<string>('');
  const [previewLocalUrls, setPreviewLocalUrls] = useState<string[]>([]);
  const [previewProdUrl, setPreviewProdUrl] = useState<string>('');
  const [previewInitialErrors, setPreviewInitialErrors] = useState<PreviewError[]>([]);
  const [previewInitialConsoleLogs, setPreviewInitialConsoleLogs] = useState<ConsoleLog[]>([]);
  const [previewInitialNetworkErrors, setPreviewInitialNetworkErrors] = useState<NetworkError[]>([]);
  const [previewOpen, setPreviewOpen] = useState(() => loadPersisted('previewOpen', false));
  const [previewWidth, setPreviewWidth] = useState(() => loadPersisted('previewWidth', 500));
  const [isResizingPreview, setIsResizingPreview] = useState(false);
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const [gitBranch, setGitBranch] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [deployments, setDeployments] = useState<Deployment[]>([]);

  // Per-panel zoom levels (font sizes)
  const [terminalFontSize, setTerminalFontSize] = useState(() => loadPersisted('terminalFontSize', 13));
  const [editorFontSize, setEditorFontSize] = useState(() => loadPersisted('editorFontSize', 13));
  const [sidebarFontSize, setSidebarFontSize] = useState(() => loadPersisted('sidebarFontSize', 13));
  const [panelFontSize, setPanelFontSize] = useState(() => loadPersisted('panelFontSize', 12));
  const hoverZoneRef = useRef<'terminal' | 'sidebar' | 'editor' | 'panel'>('terminal');

  // Multi-terminal state
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>(() => {
    return [makeTerminalTab('', terminalCounterRef.current++)];
  });
  const [activeTerminalId, setActiveTerminalId] = useState(terminalTabs[0].id);
  const [splitTerminalId, setSplitTerminalId] = useState<string | null>(null);
  const activeTerminalIdRef = useRef(activeTerminalId);
  activeTerminalIdRef.current = activeTerminalId;
  const splitTerminalIdRef = useRef(splitTerminalId);
  splitTerminalIdRef.current = splitTerminalId;
  const terminalTabsRef = useRef(terminalTabs);
  terminalTabsRef.current = terminalTabs;

  // Derived state from active terminal
  const activeTerminal = terminalTabs.find(t => t.id === activeTerminalId) || terminalTabs[0];
  const cwd = activeTerminal.cwd;
  const aiAction = activeTerminal.aiAction;
  const isClaudeRunning = activeTerminal.claudeRunning;

  const updateTab = useCallback((tabId: string, updates: Partial<TerminalTab>) => {
    setTerminalTabs(prev => prev.map(t => t.id === tabId ? { ...t, ...updates } : t));
  }, []);

  // Initialize cwd to home directory on mount (only if no persisted cwd)
  useEffect(() => {
    if (terminalTabs[0]?.cwd) return;
    window.cozyPane.fs.homedir().then(home => {
      setTerminalTabs(p => p.map((t, i) => i === 0 && !t.cwd ? { ...t, cwd: home } : t));
    }).catch(() => {});
  }, []);

  // Persist key state to localStorage
  useEffect(() => { if (cwd) savePersisted('cwd', cwd); }, [cwd]);
  useEffect(() => { savePersisted('openTabs', openTabs); }, [openTabs]);
  useEffect(() => { savePersisted('activeTab', activeTab); }, [activeTab]);
  useEffect(() => { savePersisted('panelsOpen', panelsOpen); }, [panelsOpen]);
  useEffect(() => { savePersisted('layoutMode', layoutMode); }, [layoutMode]);
  useEffect(() => { savePersisted('rightPanelTab', rightPanelTab); }, [rightPanelTab]);
  useEffect(() => { if (!isResizing) savePersisted('panelWidth', panelWidth); }, [panelWidth, isResizing]);
  useEffect(() => { savePersisted('sidebarRatio', sidebarRatio); }, [sidebarRatio]);
  useEffect(() => { savePersisted('terminalFontSize', terminalFontSize); }, [terminalFontSize]);
  useEffect(() => { savePersisted('editorFontSize', editorFontSize); }, [editorFontSize]);
  useEffect(() => { savePersisted('sidebarFontSize', sidebarFontSize); }, [sidebarFontSize]);
  useEffect(() => { savePersisted('panelFontSize', panelFontSize); }, [panelFontSize]);
  useEffect(() => { savePersisted('previewOpen', previewOpen); }, [previewOpen]);
  useEffect(() => { if (!isResizingPreview) savePersisted('previewWidth', previewWidth); }, [previewWidth, isResizingPreview]);

  // Refs for per-tab watcher save/restore
  const activityEventsRef = useRef(activityEvents);
  activityEventsRef.current = activityEvents;
  const prevActiveTabRef = useRef(activeTerminalId);

  // Save/restore watcher state on tab switch
  useEffect(() => {
    const prevId = prevActiveTabRef.current;
    if (prevId === activeTerminalId) return;
    // Save leaving tab
    tabWatcherCache.current.set(prevId, {
      activityEvents: activityEventsRef.current,
    });
    // Restore or init new tab
    const cached = tabWatcherCache.current.get(activeTerminalId);
    setActivityEvents(cached?.activityEvents ?? []);
    // Restore preview URLs and console state for the newly active tab
    const newTab = terminalTabsRef.current.find(t => t.id === activeTerminalId);
    setPreviewLocalUrl(newTab?.previewLocalUrl || '');
    setPreviewLocalUrls(newTab?.previewLocalUrls || []);
    setPreviewProdUrl(newTab?.previewProdUrl || '');
    setPreviewInitialErrors(newTab?.previewErrors || []);
    setPreviewInitialConsoleLogs(newTab?.previewConsoleLogs || []);
    setPreviewInitialNetworkErrors(newTab?.previewNetworkErrors || []);
    prevActiveTabRef.current = activeTerminalId;
  }, [activeTerminalId]);

  const changedFiles = useMemo(() => {
    const map = new Map<string, 'create' | 'modify' | 'delete'>();
    for (let i = activityEvents.length - 1; i >= 0; i--) {
      map.set(activityEvents[i].path, activityEvents[i].type);
    }
    return map;
  }, [activityEvents]);

  // Start/restart file watcher when cwd changes
  useEffect(() => {
    if (!cwd) return;

    window.cozyPane.watcher.start(cwd);

    const removeListener = window.cozyPane.watcher.onChange((event: FileChangeEvent) => {
      setActivityEvents(prev => [event, ...prev].slice(0, 200));
      setLastWatcherEvent(event);
    });

    return () => {
      removeListener();
      window.cozyPane.watcher.stop();
    };
  }, [cwd]);

  // Tab operations
  const addTerminalTab = useCallback(() => {
    setTerminalTabs(prev => {
      const currentCwd = prev.find(t => t.id === activeTerminalIdRef.current)?.cwd || '';
      const newTab = makeTerminalTab(currentCwd, terminalCounterRef.current++);
      setActiveTerminalId(newTab.id);
      return [...prev, newTab];
    });
  }, []);

  const closeTerminalTab = useCallback(async (id: string) => {
    const tabs = terminalTabsRef.current;
    const tab = tabs.find(t => t.id === id);
    if (!tab || tabs.length <= 1) return; // Can't close last tab

    const ok = await confirm({
      title: 'Close terminal?',
      message: `Close terminal "${tab.customLabel || tab.label}"? Any running processes will be stopped.`,
      confirmLabel: 'Close',
      destructive: true,
    });
    if (!ok) return;

    setTerminalTabs(prev => {
      if (prev.length <= 1) return prev;
      if (tab.ptyId) {
        window.cozyPane.terminal.close(tab.ptyId);
      }
      tabWatcherCache.current.delete(id);
      const remaining = prev.filter(t => t.id !== id);
      // If closing active tab, switch to adjacent
      if (id === activeTerminalIdRef.current) {
        const idx = prev.findIndex(t => t.id === id);
        const newActive = remaining[Math.min(idx, remaining.length - 1)] || remaining[0];
        setActiveTerminalId(newActive.id);
      }
      // Clear split if it was the split tab
      if (id === splitTerminalIdRef.current) {
        setSplitTerminalId(null);
      }
      return remaining;
    });
  }, []);

  const switchTerminalTab = useCallback((id: string) => {
    setActiveTerminalId(id);
  }, []);

  const toggleSplit = useCallback((id: string) => {
    setSplitTerminalId(prev => {
      if (prev === id) return null; // Un-split
      if (id === activeTerminalIdRef.current) return prev; // Can't split active as split
      return id;
    });
  }, []);

  // Build the `claude` autoCommand. When cozy mode is on we add --mcp-config pointing
  // at CozyPane's static MCP config so only sessions we spawn see the cozypane tools.
  const buildClaudeAutoCommand = useCallback(async (cozyMode: boolean): Promise<string> => {
    if (!cozyMode) return 'claude --dangerously-skip-permissions';
    const result = await window.cozyPane.mcp.getConfigPath();
    if (!result.path) {
      console.warn('[CozyPane] getConfigPath failed, launching claude without cozypane MCP:', result.error);
      return 'claude --dangerously-skip-permissions';
    }
    return `claude --mcp-config "${result.path}" --dangerously-skip-permissions`;
  }, []);

  // Launcher handlers — called when user picks an option on the new tab launcher
  const launchOpenProject = useCallback(async (cwd: string, cozyMode: boolean) => {
    if (cozyMode) {
      await enableCozyMode(cwd);
    }
    const autoCommand = await buildClaudeAutoCommand(cozyMode);
    updateTab(activeTerminalIdRef.current, {
      cwd,
      launched: true,
      autoCommand,
    });
  }, [updateTab, buildClaudeAutoCommand]);

  const launchCreateProject = useCallback(async (fullPath: string, _projectName: string, cozyMode: boolean) => {
    // L24: check if the directory already exists. Previously `mkdir` would
    // silently succeed (it's recursive) or error obscurely if the path was
    // a non-empty existing directory; the user would land in a new tab
    // with no feedback. Now we surface a clear confirmation.
    const existing = await window.cozyPane.fs.readdir(fullPath).catch(() => null);
    if (existing && existing.length > 0) {
      const ok = await confirm({
        title: 'Directory exists',
        message: `"${fullPath}" already exists and is not empty. Open it as an existing project instead of creating a new one?`,
        confirmLabel: 'Open existing',
      });
      if (!ok) return;
    } else {
      const result = await window.cozyPane.fs.mkdir(fullPath);
      if (result?.error) {
        await confirm({
          title: 'Could not create project',
          message: result.error,
          confirmLabel: 'OK',
          cancelLabel: '',
        });
        return;
      }
    }
    if (cozyMode) {
      await enableCozyMode(fullPath);
    }
    const autoCommand = await buildClaudeAutoCommand(cozyMode);
    updateTab(activeTerminalIdRef.current, {
      cwd: fullPath,
      launched: true,
      autoCommand,
    });
  }, [updateTab, buildClaudeAutoCommand, confirm]);

  const launchNewTerminal = useCallback(async () => {
    const tab = terminalTabsRef.current.find(t => t.id === activeTerminalIdRef.current);
    const dir = tab?.cwd || await window.cozyPane.fs.homedir();
    updateTab(activeTerminalIdRef.current, {
      cwd: dir,
      launched: true,
    });
  }, [updateTab]);

  const handleFileSelect = useCallback((filePath: string, fileName: string) => {
    setDiffState(null);
    setOpenTabs(prev => {
      if (!prev.find(t => t.path === filePath)) {
        return [...prev, { path: filePath, name: fileName }];
      }
      return prev;
    });
    setActiveTab(filePath);
    setRightPanelTab('preview');
  }, []);

  const handleDiffClick = useCallback(async (filePath: string) => {
    const result = await window.cozyPane.watcher.getDiff(filePath);
    if (result.error || result.before === undefined || result.after === undefined) {
      const fileName = filePath.split('/').pop() || filePath;
      handleFileSelect(filePath, fileName);
      return;
    }
    setDiffState({ filePath, before: result.before, after: result.after });
    setRightPanelTab('preview');
  }, [handleFileSelect]);

  const handleGitDiffClick = useCallback((filePath: string, before: string, after: string) => {
    setDiffState({ filePath, before, after });
    setRightPanelTab('preview');
  }, []);

  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;

  const closeFileTab = useCallback(async (filePath: string): Promise<boolean> => {
    // Returns true if the tab was actually closed, false if the user
    // cancelled due to unsaved changes.
    const tab = openTabsRef.current.find(t => t.path === filePath);
    if (tab?.dirty) {
      const ok = await confirm({
        title: 'Unsaved changes',
        message: `${tab.name} has unsaved changes. Close without saving?`,
        confirmLabel: 'Discard',
        destructive: true,
      });
      if (!ok) return false;
    }
    const remaining = openTabsRef.current.filter(t => t.path !== filePath);
    setOpenTabs(remaining);
    setActiveTab(prev => {
      if (prev !== filePath) return prev;
      return remaining.length > 0 ? remaining[remaining.length - 1].path : null;
    });
    return true;
  }, [confirm]);

  const handleCloseTab = useCallback((filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    void closeFileTab(filePath);
  }, [closeFileTab]);

  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;

  const previewWidthRef = useRef(previewWidth);
  previewWidthRef.current = previewWidth;

  // H19/L9 — three drag-resize handlers were previously 80 lines of
  // near-identical boilerplate (cleanup refs, mousemove/mouseup wiring,
  // unmount effect). Extracted to `lib/useDragResize.ts`; each handler is
  // now ~7 lines and the unmount cleanup is built into the hook.

  const handlePanelResizeStart = useDragResize({
    onStart: () => setIsResizing(true),
    onEnd:   () => setIsResizing(false),
    getStartValue: () => panelWidthRef.current,
    onMove: (e, ctx) => {
      const delta = ctx.startX - e.clientX;
      setPanelWidth(Math.max(200, Math.min(ctx.startWidth + delta, window.innerWidth * 0.6)));
    },
  });

  const handleSplitResizeStart = useDragResize({
    getContainer: (target) => target.parentElement,
    onMove: (e, ctx) => {
      if (!ctx.containerRect) return;
      const deltaY = e.clientY - ctx.containerRect.top;
      const newRatio = Math.max(0.15, Math.min(deltaY / ctx.containerRect.height, 0.85));
      setSidebarRatio(newRatio);
    },
  });

  const handlePreviewResizeStart = useDragResize({
    onStart: () => setIsResizingPreview(true),
    onEnd:   () => setIsResizingPreview(false),
    getStartValue: () => previewWidthRef.current,
    onMove: (e, ctx) => {
      const delta = ctx.startX - e.clientX;
      setPreviewWidth(Math.max(250, Math.min(ctx.startWidth + delta, window.innerWidth * 0.6)));
    },
  });

  const togglePanels = useCallback(() => {
    setPanelsOpen(prev => !prev);
  }, []);

  const toggleLayout = useCallback(() => {
    setLayoutMode(prev => prev === 'two-col' ? 'three-col' : 'two-col');
  }, []);

  // Keyboard shortcuts: Cmd+K palette, Cmd+T new tab, Cmd+W close tab
  const isMac = navigator.platform.includes('Mac');
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen(prev => !prev);
      }
      if (mod && e.key === 't') {
        e.preventDefault();
        addTerminalTab();
      }
      if (mod && e.key === 'w') {
        e.preventDefault();
        // Scope Cmd+W to the currently-hovered pane so editors with unsaved
        // files get a dirty-check prompt, while terminal-focused Cmd+W still
        // closes the active terminal tab. Without this, Cmd+W silently
        // discarded unsaved file edits when the user thought they were
        // closing an editor tab.
        if (hoverZoneRef.current === 'editor') {
          const active = activeTab;
          if (active) {
            void closeFileTab(active);
            return;
          }
        }
        closeTerminalTab(activeTerminalIdRef.current);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [addTerminalTab, closeTerminalTab, closeFileTab, activeTab]);

  // Per-panel zoom via Cmd+/- based on hover zone
  const adjustZoom = useCallback((delta: number, reset?: boolean) => {
    const zone = hoverZoneRef.current;
    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
    if (zone === 'terminal') {
      setTerminalFontSize(prev => reset ? 13 : clamp(prev + delta, 8, 28));
    } else if (zone === 'editor') {
      setEditorFontSize(prev => reset ? 13 : clamp(prev + delta, 8, 28));
    } else if (zone === 'sidebar') {
      setSidebarFontSize(prev => reset ? 13 : clamp(prev + delta, 9, 22));
    } else {
      setPanelFontSize(prev => reset ? 12 : clamp(prev + delta, 8, 22));
    }
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        adjustZoom(1);
      } else if (e.key === '-') {
        e.preventDefault();
        adjustZoom(-1);
      } else if (e.key === '0') {
        e.preventDefault();
        adjustZoom(0, true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [adjustZoom]);

  // Menu event listeners from Electron main process
  useEffect(() => {
    const cleanups = [
      window.cozyPane.onMenuAction('menu:new-tab', addTerminalTab),
      window.cozyPane.onMenuAction('menu:close-tab', () => closeTerminalTab(activeTerminalIdRef.current)),
      window.cozyPane.onMenuAction('menu:toggle-panels', togglePanels),
      window.cozyPane.onMenuAction('menu:toggle-layout', toggleLayout),
      window.cozyPane.onMenuAction('menu:settings', () => { setPanelsOpen(true); setRightPanelTab('settings'); }),
      window.cozyPane.onMenuAction('menu:clear-terminal', () => {
        const tab = terminalTabsRef.current.find(t => t.id === activeTerminalIdRef.current);
        if (tab?.ptyId) window.cozyPane.terminal.write(tab.ptyId, 'clear\n');
      }),
      window.cozyPane.onMenuAction('menu:split-view', () => {
        const tabs = terminalTabsRef.current;
        if (tabs.length < 2) return;
        const other = tabs.find(t => t.id !== activeTerminalIdRef.current);
        if (other) toggleSplit(other.id);
      }),
      window.cozyPane.onMenuAction('menu:zoom-in', () => adjustZoom(1)),
      window.cozyPane.onMenuAction('menu:zoom-out', () => adjustZoom(-1)),
      window.cozyPane.onMenuAction('menu:zoom-reset', () => adjustZoom(0, true)),
    ];
    return () => cleanups.forEach(fn => fn());
  }, [addTerminalTab, closeTerminalTab, togglePanels, toggleLayout, toggleSplit, adjustZoom]);

  // Listen for /deploy command from CommandInput
  useEffect(() => {
    const handler = () => {
      setPanelsOpen(true);
      setRightPanelTab('deploy');
    };
    window.addEventListener('cozyPane:deploy', handler);
    return () => window.removeEventListener('cozyPane:deploy', handler);
  }, []);

  // openPreview removed — URL detection now goes through Terminal callbacks directly

  const sendTerminalCommand = useCallback((command: string) => {
    const tab = terminalTabsRef.current.find(t => t.id === activeTerminalIdRef.current);
    if (tab?.ptyId) {
      const text = command.replace(/\n/g, '\r');
      // Wrap in bracketed paste so the terminal treats it as one pasted block
      window.cozyPane.terminal.write(tab.ptyId, `\x1b[200~${text}\x1b[201~\r`);
    }
  }, []);

  const applyTheme = useCallback((themeId: string) => {
    document.documentElement.setAttribute('data-theme', themeId);
    try { localStorage.setItem('cozyPane:theme', themeId); } catch {}
    window.dispatchEvent(new CustomEvent('cozyPane:themeChange', { detail: themeId }));
  }, []);

  const paletteActions: PaletteAction[] = useMemo(() => [
    { id: 'toggle-panels', label: 'Toggle Panels', category: 'View', shortcut: '', action: () => setPanelsOpen(p => !p) },
    { id: 'toggle-layout', label: 'Switch Layout Mode', category: 'View', action: () => setLayoutMode(p => p === 'two-col' ? 'three-col' : 'two-col') },
    { id: 'new-terminal', label: 'New Terminal Tab', category: 'Terminal', shortcut: 'Cmd+T', action: addTerminalTab },
    { id: 'tab-editor', label: 'Show Editor', category: 'Tab', action: () => setRightPanelTab('preview') },
    { id: 'tab-git', label: 'Show Git Panel', category: 'Tab', action: () => setRightPanelTab('git') },
    { id: 'tab-settings', label: 'Show Settings', category: 'Tab', action: () => setRightPanelTab('settings') },
    { id: 'tab-deploy', label: 'Show Deploy', category: 'Tab', action: () => setRightPanelTab('deploy') },
    { id: 'toggle-preview', label: 'Toggle Preview Panel', category: 'View', action: () => setPreviewOpen(p => !p) },
    { id: 'git-stage-all', label: 'Stage All Changes', category: 'Git', action: () => { sendTerminalCommand('git add -A'); setRightPanelTab('git'); } },
    { id: 'git-commit', label: 'Open Git to Commit', category: 'Git', action: () => setRightPanelTab('git') },
    { id: 'git-push', label: 'Push', category: 'Git', action: () => { sendTerminalCommand('git push'); setRightPanelTab('git'); } },
    { id: 'git-pull', label: 'Pull', category: 'Git', action: () => { sendTerminalCommand('git pull'); setRightPanelTab('git'); } },
    { id: 'theme-cozy', label: 'Theme: Cozy Dark', category: 'Theme', action: () => applyTheme('cozy-dark') },
    { id: 'theme-ocean', label: 'Theme: Ocean', category: 'Theme', action: () => applyTheme('ocean') },
    { id: 'theme-forest', label: 'Theme: Forest', category: 'Theme', action: () => applyTheme('forest') },
    { id: 'theme-light', label: 'Theme: Light', category: 'Theme', action: () => applyTheme('cozy-light') },
  ], [addTerminalTab, sendTerminalCommand, applyTheme]);

  // Run update command in a new terminal tab
  const handleRunUpdate = useCallback((command: string) => {
    setTerminalTabs(prev => {
      const home = prev.find(t => t.cwd)?.cwd || '';
      const newTab = makeTerminalTab(home, terminalCounterRef.current++, true);
      newTab.customLabel = 'Updates';
      newTab.autoCommand = command;
      setActiveTerminalId(newTab.id);
      return [...prev, newTab];
    });
  }, []);

  const handleDirtyChange = useCallback((filePath: string, isDirty: boolean) => {
    setOpenTabs(prev => prev.map(t =>
      t.path === filePath ? { ...t, dirty: isDirty } : t
    ));
  }, []);

  const setCwd = useCallback((newCwd: string) => {
    updateTab(activeTerminalIdRef.current, { cwd: newCwd });
  }, [updateTab]);

  // H26 — Monaco container must ALWAYS stay mounted (CLAUDE.md rule).
  //
  // Previously `renderBottomPanel()` returned completely different JSX trees
  // for each panel state — Settings/Git/Deploy/Preview/Diff/Empty — which
  // meant React unmounted `FilePreview` (and disposed its Monaco editor)
  // every time the user switched the right-panel tab, opened a diff, or
  // closed the last file tab. Monaco spin-up is expensive and caused
  // visible flicker.
  //
  // The fix: FilePreview is rendered exactly once, permanently. Its
  // container is toggled via `display: none` (or an absolute-positioned
  // stacking layer) based on which sub-view is active. Same trick we
  // already use for terminal tabs.
  const renderBottomPanel = () => {
    const showPreviewTab = rightPanelTab === 'preview';
    const showDiff = showPreviewTab && !!diffState;
    const showEditor = showPreviewTab && !diffState && openTabs.length > 0;
    const showEmpty  = showPreviewTab && !diffState && openTabs.length === 0;

    return (
      <>
        {/* --- Preview tab contents (editor / diff / empty). FilePreview is
            ALWAYS mounted below; the wrappers around it use display:none to
            toggle visibility so Monaco is never disposed. --- */}
        <div
          className="bottom-panel-editor-root"
          style={{
            display: showPreviewTab ? 'flex' : 'none',
            flex: 1,
            minHeight: 0,
            flexDirection: 'column',
          }}
        >
          {/* Editor tabs row — only visible when showing open files */}
          <div
            className="editor-tabs"
            style={{ display: showEditor ? 'flex' : 'none' }}
          >
            {openTabs.map(tab => (
              <div
                key={tab.path}
                className={`editor-tab ${activeTab === tab.path ? 'active' : ''}`}
                onClick={() => { setActiveTab(tab.path); setDiffState(null); }}
              >
                <span>{tab.dirty ? '● ' : ''}{tab.name}</span>
                <span className="tab-close" role="button" aria-label={`Close ${tab.name}`} onClick={e => handleCloseTab(tab.path, e)}>x</span>
              </div>
            ))}
          </div>

          {/* Diff tab row */}
          {showDiff && diffState && (
            <div className="editor-tabs">
              <div className="editor-tab active">
                <span>Diff: {diffState.filePath.split('/').pop()}</span>
                <span className="tab-close" role="button" aria-label="Close diff" onClick={() => setDiffState(null)}>x</span>
              </div>
            </div>
          )}

          {/* FilePreview (Monaco) — ALWAYS mounted. Hidden via display:none
              when the diff viewer is active or no files are open. */}
          <div style={{ display: showEditor ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
            <FilePreview filePath={activeTab} onDirtyChange={handleDirtyChange} fontSize={editorFontSize} />
          </div>

          {/* Diff viewer — mounted only when a diff is active. DiffViewer
              is less expensive to remount than FilePreview and its content
              (before/after) is diff-specific, so conditional mounting is
              fine here. */}
          {showDiff && diffState && (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <DiffViewer filePath={diffState.filePath} before={diffState.before} after={diffState.after} fontSize={editorFontSize} />
            </div>
          )}

          {/* Empty state */}
          {showEmpty && (
            <div className="empty-state">
              <div className="empty-state-text">Select a file to preview</div>
            </div>
          )}
        </div>

        {/* Non-preview panels — safe to conditionally mount because they
            don't hold expensive persistent state. */}
        {rightPanelTab === 'settings' && (
          <ErrorBoundary panel="Settings"><Settings /></ErrorBoundary>
        )}
        {rightPanelTab === 'git' && (
          <ErrorBoundary panel="Git">
            <GitPanel
              cwd={cwd}
              onDiffClick={handleGitDiffClick}
              onBranchChange={setGitBranch}
              activityEvents={activityEvents}
              onTerminalCommand={sendTerminalCommand}
              claudeRunning={isClaudeRunning}
            />
          </ErrorBoundary>
        )}
        {rightPanelTab === 'deploy' && (
          <ErrorBoundary panel="Deploy">
            <DeployPanel cwd={cwd} onTerminalCommand={sendTerminalCommand} onDeploymentsLoaded={setDeployments} />
          </ErrorBoundary>
        )}
      </>
    );
  };

  const panelTabBar = (
    <div className="panel-tab-bar">
      <button
        className={`panel-tab ${rightPanelTab === 'preview' ? 'active' : ''}`}
        onClick={() => setRightPanelTab('preview')}
      >
        <Eye size={13} /> Editor
      </button>
      <button
        className={`panel-tab ${rightPanelTab === 'git' ? 'active' : ''}`}
        onClick={() => setRightPanelTab('git')}
      >
        <GitBranch size={13} /> Git
      </button>
      <button
        className={`panel-tab ${rightPanelTab === 'deploy' ? 'active' : ''}`}
        onClick={() => setRightPanelTab('deploy')}
      >
        <Rocket size={13} /> Deploy
      </button>
      <button
        className={`panel-tab ${rightPanelTab === 'settings' ? 'active' : ''}`}
        onClick={() => setRightPanelTab('settings')}
      >
        <Settings2 size={13} /> Settings
      </button>
      {rightPanelTab === 'preview' && (
        <div className="zoom-controls">
          <button className="zoom-btn" onClick={() => setEditorFontSize(prev => Math.max(8, prev - 1))} title="Zoom out">−</button>
          <button className="zoom-label" onClick={() => setEditorFontSize(13)} title="Reset zoom">{editorFontSize}px</button>
          <button className="zoom-btn" onClick={() => setEditorFontSize(prev => Math.min(28, prev + 1))} title="Zoom in">+</button>
        </div>
      )}
    </div>
  );

  const sidebarProps = {
    isOpen: true as const,
    onToggle: togglePanels,
    onFileSelect: handleFileSelect,
    onDiffClick: handleDiffClick,
    activeFile: activeTab,
    onCwdChange: setCwd,
    cwd,
    changedFiles,
    lastWatcherEvent,
    fontSize: sidebarFontSize,
    onZoomIn: () => setSidebarFontSize(prev => Math.min(22, prev + 1)),
    onZoomOut: () => setSidebarFontSize(prev => Math.max(9, prev - 1)),
    onZoomReset: () => setSidebarFontSize(13),
  };

  return (
    <div className="app">
      <div className="titlebar">
        <span className="titlebar-text">CozyPane</span>
        <div className="titlebar-actions">
          <button className="btn titlebar-btn" onClick={togglePanels} title="Toggle panels" aria-label="Toggle panels">
            {panelsOpen ? '>' : '<'}
          </button>
          <button
            className={`btn titlebar-btn ${previewOpen ? 'titlebar-btn-active' : ''}`}
            onClick={() => setPreviewOpen(p => !p)}
            title="Toggle preview"
            aria-label="Toggle preview"
          >
            {previewOpen ? '\u{1F5A5}\u2009x' : '\u{1F5A5}'}
          </button>
          {panelsOpen && (
            <button className="btn titlebar-btn" onClick={toggleLayout} title="Toggle layout" aria-label="Toggle layout">
              {layoutMode === 'two-col' ? '|||' : '||'}
            </button>
          )}
        </div>
      </div>

      <UpdateBanner onRunUpdate={handleRunUpdate} />

      <div className="main-content">
        {/* Overlay prevents webview from stealing mouse events during resize */}
        {(isResizing || isResizingPreview) && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 9999, cursor: 'col-resize' }} />
        )}
        <div className={`terminal-pane ${splitTerminalId ? 'split' : ''}`}
          onMouseEnter={() => { hoverZoneRef.current = 'terminal'; }}
        >
          <TerminalTabBar
            tabs={terminalTabs}
            activeId={activeTerminalId}
            splitId={splitTerminalId}
            onSelect={switchTerminalTab}
            onClose={closeTerminalTab}
            onAdd={addTerminalTab}
            onToggleSplit={toggleSplit}
            onRename={(id, name) => updateTab(id, { customLabel: name || undefined })}
            onReorder={(from, to) => {
              setTerminalTabs(prev => {
                const next = [...prev];
                const [moved] = next.splice(from, 1);
                next.splice(to, 0, moved);
                return next;
              });
            }}
            fontSize={terminalFontSize}
            onZoomIn={() => setTerminalFontSize(prev => Math.min(28, prev + 1))}
            onZoomOut={() => setTerminalFontSize(prev => Math.max(8, prev - 1))}
            onZoomReset={() => setTerminalFontSize(13)}
          />
          <div className="terminal-instances">
            {terminalTabs.map(tab => {
              const isActive = tab.id === activeTerminalId;
              const isSplit = tab.id === splitTerminalId;
              const visible = isActive || isSplit;

              // Show launcher for unlaunched tabs
              if (!tab.launched && isActive) {
                return (
                  <div key={tab.id} className="terminal-instance" style={{ display: 'flex', flex: 1 }}>
                    <TabLauncher
                      onOpenProject={launchOpenProject}
                      onCreateProject={launchCreateProject}
                      onNewTerminal={launchNewTerminal}
                    />
                  </div>
                );
              }

              if (!tab.launched) return null;

              return (
                <div
                  key={tab.id}
                  className="terminal-instance"
                  style={visible
                    ? { display: 'flex', flex: 1, position: 'relative' as const }
                    : { visibility: 'hidden' as const, position: 'absolute' as const, inset: 0, pointerEvents: 'none' as const }
                  }
                  onClick={() => {
                    if (isSplit && !isActive) {
                      setActiveTerminalId(tab.id);
                    }
                  }}
                >
                  {/* L16 — wrap each Terminal in its own ErrorBoundary so a
                      runtime error in xterm/PTY wiring for one tab doesn't
                      crash the entire app. The boundary key is the tab id so
                      React treats each Terminal as its own error scope. */}
                  <ErrorBoundary panel={`Terminal ${tab.label}`}>
                    <Terminal
                      terminalId={tab.ptyId}
                      cwd={tab.cwd}
                      isVisible={visible}
                      fontSize={terminalFontSize}
                      autoCommand={tab.autoCommand}
                      onTerminalReady={(ptyId) => updateTab(tab.id, { ptyId })}
                      onCwdChange={(newCwd) => updateTab(tab.id, { cwd: newCwd })}
                      onActionChange={(action) => updateTab(tab.id, { aiAction: action })}
                      onClaudeRunningChange={(running) => updateTab(tab.id, { claudeRunning: running })}
                      onLocalUrlDetected={(url) => {
                        updateTab(tab.id, { previewLocalUrl: url });
                        if (tab.id === activeTerminalIdRef.current) {
                          setPreviewLocalUrl(url);
                        }
                      }}
                      onLocalUrlsDetected={(urls) => {
                        updateTab(tab.id, { previewLocalUrls: urls });
                        if (tab.id === activeTerminalIdRef.current) {
                          setPreviewLocalUrls(urls);
                        }
                      }}
                      onProdUrlDetected={(url) => {
                        updateTab(tab.id, { previewProdUrl: url });
                        if (tab.id === activeTerminalIdRef.current) {
                          setPreviewProdUrl(url);
                        }
                      }}
                    />
                  </ErrorBoundary>
                </div>
              );
            })}
          </div>
        </div>

        {panelsOpen && (
          <>
            <div
              className={`resize-handle ${isResizing ? 'active' : ''}`}
              onMouseDown={handlePanelResizeStart}
            />

            {layoutMode === 'two-col' ? (
              <div className="right-panel" style={{ width: panelWidth }}>
                <div className="panel-section" style={{ flex: sidebarRatio, fontSize: sidebarFontSize }}
                  onMouseEnter={() => { hoverZoneRef.current = 'sidebar'; }}
                >
                  <ErrorBoundary panel="Sidebar"><Sidebar {...sidebarProps} /></ErrorBoundary>
                </div>
                <div className="resize-handle-h" onMouseDown={handleSplitResizeStart} />
                <div className="panel-section preview-section" style={{ flex: 1 - sidebarRatio, fontSize: panelFontSize }}
                  onMouseEnter={() => { hoverZoneRef.current = rightPanelTab === 'preview' ? 'editor' : 'panel'; }}
                >
                  {panelTabBar}
                  {renderBottomPanel()}
                </div>
              </div>
            ) : (
              <>
                <div className="right-panel" style={{ width: 180, minWidth: 140, maxWidth: 240 }}>
                  <div className="panel-section" style={{ flex: 1, fontSize: sidebarFontSize }}
                    onMouseEnter={() => { hoverZoneRef.current = 'sidebar'; }}
                  >
                    <ErrorBoundary panel="Sidebar"><Sidebar {...sidebarProps} /></ErrorBoundary>
                  </div>
                </div>
                <div className="right-panel preview-panel" style={{ width: panelWidth }}>
                  <div className="panel-section preview-section" style={{ flex: 1, fontSize: panelFontSize }}
                    onMouseEnter={() => { hoverZoneRef.current = rightPanelTab === 'preview' ? 'editor' : 'panel'; }}
                  >
                    {panelTabBar}
                    {renderBottomPanel()}
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {/* Preview Panel — independent, rightmost column */}
        {previewOpen && (
          <>
            <div
              className={`resize-handle ${isResizingPreview ? 'active' : ''}`}
              onMouseDown={handlePreviewResizeStart}
            />
            <div className="right-panel preview-panel" style={{ width: previewWidth }}>
              <ErrorBoundary panel="Preview">
                <Preview
                  localUrl={previewLocalUrl}
                  localUrls={previewLocalUrls}
                  productionUrl={previewProdUrl}
                  cwd={cwd}
                  onSendToTerminal={sendTerminalCommand}
                  deployments={deployments}
                  claudeRunning={isClaudeRunning}
                  initialErrors={previewInitialErrors}
                  initialConsoleLogs={previewInitialConsoleLogs}
                  initialNetworkErrors={previewInitialNetworkErrors}
                  onConsoleUpdate={(errors, consoleLogs, networkErrors) => {
                    updateTab(activeTerminalId, { previewErrors: errors, previewConsoleLogs: consoleLogs, previewNetworkErrors: networkErrors });
                  }}
                />
              </ErrorBoundary>
            </div>
          </>
        )}
      </div>

      <StatusBar
        cwd={cwd}
        layoutMode={layoutMode}
        onToggleLayout={toggleLayout}
        panelsOpen={panelsOpen}
        onTogglePanels={togglePanels}
        aiAction={aiAction}
        gitBranch={gitBranch}
      />

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} actions={paletteActions} />
    </div>
  );
}
