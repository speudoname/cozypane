import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import Sidebar from './components/Sidebar';
import FilePreview from './components/FilePreview';
import Terminal from './components/Terminal';
import StatusBar from './components/StatusBar';
import ActivityFeed from './components/ActivityFeed';
import DiffViewer from './components/DiffViewer';
import SessionSummary from './components/SessionSummary';
import Settings from './components/Settings';
import GitPanel from './components/GitPanel';
import DeployPanel from './components/DeployPanel';
import Preview from './components/Preview';
import TabLauncher from './components/TabLauncher';
import { enableCozyMode } from './lib/cozyMode';

import CommandPalette from './components/CommandPalette';
import type { PaletteAction } from './components/CommandPalette';
import TerminalTabBar from './components/TerminalTabBar';
import type { TerminalTab } from './components/TerminalTabBar';
import type { AiAction, CostInfo } from './lib/terminalAnalyzer';

type LayoutMode = 'two-col' | 'three-col';
type RightPanelTab = 'preview' | 'activity' | 'summary' | 'settings' | 'git' | 'deploy';

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
  return { id, ptyId: null, label, cwd, aiAction: 'idle', costInfo: { cost: null, tokens: null }, conversationTurns: [], launched };
}

export default function App() {
  const [panelsOpen, setPanelsOpen] = useState(() => loadPersisted('panelsOpen', true));
  const terminalCounterRef = useRef(1);
  const [openTabs, setOpenTabs] = useState<OpenTab[]>(() => loadPersisted('openTabs', []));
  const [activeTab, setActiveTab] = useState<string | null>(() => loadPersisted('activeTab', null));
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => loadPersisted('layoutMode', 'two-col'));
  const [panelWidth, setPanelWidth] = useState(() => loadPersisted('panelWidth', 360));
  const [isResizing, setIsResizing] = useState(false);
  const [sidebarRatio, setSidebarRatio] = useState(() => loadPersisted('sidebarRatio', 0.35));
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [activityEvents, setActivityEvents] = useState<FileChangeEvent[]>([]);
  const [lastWatcherEvent, setLastWatcherEvent] = useState<FileChangeEvent | null>(null);

  // Per-tab watcher state cache
  interface TabWatcherState {
    activityEvents: FileChangeEvent[];
    summary: string | null;
  }
  const tabWatcherCache = useRef(new Map<string, TabWatcherState>());
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>(() => {
    const saved = loadPersisted<string>('rightPanelTab', 'preview');
    // Migrate: 'browser' tab was removed, fall back to 'preview' (editor)
    const valid: RightPanelTab[] = ['preview', 'activity', 'summary', 'settings', 'git', 'deploy'];
    return valid.includes(saved as RightPanelTab) ? (saved as RightPanelTab) : 'preview';
  });
  const [previewLocalUrl, setPreviewLocalUrl] = useState<string>('');
  const [previewProdUrl, setPreviewProdUrl] = useState<string>('');
  const [previewOpen, setPreviewOpen] = useState(() => loadPersisted('previewOpen', false));
  const [previewWidth, setPreviewWidth] = useState(() => loadPersisted('previewWidth', 500));
  const [isResizingPreview, setIsResizingPreview] = useState(false);
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
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
  const costInfo = activeTerminal.costInfo;
  const conversationTurns = activeTerminal.conversationTurns;

  const updateTab = useCallback((tabId: string, updates: Partial<TerminalTab>) => {
    setTerminalTabs(prev => prev.map(t => t.id === tabId ? { ...t, ...updates } : t));
  }, []);

  // Initialize cwd to home directory on mount (only if no persisted cwd)
  useEffect(() => {
    if (terminalTabs[0]?.cwd) return;
    window.cozyPane.fs.homedir().then(home => {
      setTerminalTabs(p => p.map((t, i) => i === 0 && !t.cwd ? { ...t, cwd: home } : t));
    });
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
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  const prevActiveTabRef = useRef(activeTerminalId);

  // Save/restore watcher state on tab switch
  useEffect(() => {
    const prevId = prevActiveTabRef.current;
    if (prevId === activeTerminalId) return;
    // Save leaving tab
    tabWatcherCache.current.set(prevId, {
      activityEvents: activityEventsRef.current,
      summary: summaryRef.current,
    });
    // Restore or init new tab
    const cached = tabWatcherCache.current.get(activeTerminalId);
    setActivityEvents(cached?.activityEvents ?? []);
    setSummary(cached?.summary ?? null);
    // Restore preview URLs for the newly active tab
    const newTab = terminalTabsRef.current.find(t => t.id === activeTerminalId);
    setPreviewLocalUrl(newTab?.previewLocalUrl || '');
    setPreviewProdUrl(newTab?.previewProdUrl || '');
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

  const closeTerminalTab = useCallback((id: string) => {
    const tabs = terminalTabsRef.current;
    const tab = tabs.find(t => t.id === id);
    if (!tab || tabs.length <= 1) return; // Can't close last tab

    if (!window.confirm(`Close terminal "${tab.customLabel || tab.label}"?`)) return;

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

  // Launcher handlers — called when user picks an option on the new tab launcher
  const launchOpenProject = useCallback(async (cwd: string, cozyMode: boolean) => {
    if (cozyMode) {
      await enableCozyMode(cwd);
    }
    updateTab(activeTerminalIdRef.current, {
      cwd,
      launched: true,
      autoCommand: 'claude --dangerously-skip-permissions',
    });
  }, [updateTab]);

  const launchCreateProject = useCallback(async (fullPath: string, _projectName: string, cozyMode: boolean) => {
    await window.cozyPane.fs.mkdir(fullPath);
    if (cozyMode) {
      await enableCozyMode(fullPath);
    }
    updateTab(activeTerminalIdRef.current, {
      cwd: fullPath,
      launched: true,
      autoCommand: 'claude --dangerously-skip-permissions',
    });
  }, [updateTab]);

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

  const handleSummarize = useCallback(async () => {
    if (activityEvents.length === 0) return;
    setSummarizing(true);
    const changes = activityEvents.slice(0, 50).map(e => ({ type: e.type, name: e.name }));
    const result = await window.cozyPane.settings.summarize(changes);
    if (result.summary) {
      setSummary(result.summary);
    } else {
      setSummary(result.error || 'Could not generate summary');
    }
    setSummarizing(false);
  }, [activityEvents]);

  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;

  const handleCloseTab = useCallback((filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const remaining = openTabsRef.current.filter(t => t.path !== filePath);
    setOpenTabs(remaining);
    setActiveTab(prev => {
      if (prev !== filePath) return prev;
      return remaining.length > 0 ? remaining[remaining.length - 1].path : null;
    });
  }, []);

  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;

  const handlePanelResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = panelWidthRef.current;

    const onMouseMove = (e: MouseEvent) => {
      const delta = startX - e.clientX;
      const newWidth = Math.max(200, Math.min(startWidth + delta, window.innerWidth * 0.6));
      setPanelWidth(newWidth);
    };

    const cleanup = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', cleanup);
      resizeCleanupRef.current = null;
    };

    resizeCleanupRef.current?.();
    resizeCleanupRef.current = cleanup;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', cleanup);
  }, []);

  const splitCleanupRef = useRef<(() => void) | null>(null);

  const handleSplitResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = (e.target as HTMLElement).parentElement;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();

    const onMouseMove = (e: MouseEvent) => {
      const deltaY = e.clientY - containerRect.top;
      const newRatio = Math.max(0.15, Math.min(deltaY / containerRect.height, 0.85));
      setSidebarRatio(newRatio);
    };

    const cleanup = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', cleanup);
      splitCleanupRef.current = null;
    };

    splitCleanupRef.current?.();
    splitCleanupRef.current = cleanup;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', cleanup);
  }, []);

  const previewWidthRef = useRef(previewWidth);
  previewWidthRef.current = previewWidth;
  const previewResizeCleanupRef = useRef<(() => void) | null>(null);

  const handlePreviewResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingPreview(true);
    const startX = e.clientX;
    const startWidth = previewWidthRef.current;

    const onMouseMove = (e: MouseEvent) => {
      const delta = startX - e.clientX;
      const newWidth = Math.max(250, Math.min(startWidth + delta, window.innerWidth * 0.6));
      setPreviewWidth(newWidth);
    };

    const cleanup = () => {
      setIsResizingPreview(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', cleanup);
      previewResizeCleanupRef.current = null;
    };

    previewResizeCleanupRef.current?.();
    previewResizeCleanupRef.current = cleanup;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', cleanup);
  }, []);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
      splitCleanupRef.current?.();
      previewResizeCleanupRef.current?.();
    };
  }, []);

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
        closeTerminalTab(activeTerminalIdRef.current);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [addTerminalTab, closeTerminalTab]);

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
      window.cozyPane.terminal.write(tab.ptyId, command + '\n');
    }
  }, []);

  const paletteActions: PaletteAction[] = useMemo(() => [
    { id: 'toggle-panels', label: 'Toggle Panels', category: 'View', shortcut: '', action: () => setPanelsOpen(p => !p) },
    { id: 'toggle-layout', label: 'Switch Layout Mode', category: 'View', action: () => setLayoutMode(p => p === 'two-col' ? 'three-col' : 'two-col') },
    { id: 'new-terminal', label: 'New Terminal Tab', category: 'Terminal', shortcut: 'Cmd+T', action: addTerminalTab },
    { id: 'tab-editor', label: 'Show Editor', category: 'Tab', action: () => setRightPanelTab('preview') },
    { id: 'tab-activity', label: 'Show Activity Feed', category: 'Tab', action: () => setRightPanelTab('activity') },
    { id: 'tab-summary', label: 'Show Session Summary', category: 'Tab', action: () => setRightPanelTab('summary') },
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
  ], [addTerminalTab, sendTerminalCommand]);

  const applyTheme = useCallback((themeId: string) => {
    document.documentElement.setAttribute('data-theme', themeId);
    try { localStorage.setItem('cozyPane:theme', themeId); } catch {}
    window.dispatchEvent(new CustomEvent('cozyPane:themeChange', { detail: themeId }));
  }, []);

  const handleDirtyChange = useCallback((filePath: string, isDirty: boolean) => {
    setOpenTabs(prev => prev.map(t =>
      t.path === filePath ? { ...t, dirty: isDirty } : t
    ));
  }, []);

  const setCwd = useCallback((newCwd: string) => {
    updateTab(activeTerminalIdRef.current, { cwd: newCwd });
  }, [updateTab]);

  const renderBottomPanel = () => {
    if (rightPanelTab === 'activity') {
      return (
        <ActivityFeed
          events={activityEvents}
          onFileClick={handleFileSelect}
          onDiffClick={handleDiffClick}
          summary={summary}
          onSummarize={handleSummarize}
          summarizing={summarizing}
        />
      );
    }

    if (rightPanelTab === 'summary') {
      return <SessionSummary turns={conversationTurns} aiAction={aiAction} activityEvents={activityEvents} />;
    }

    if (rightPanelTab === 'settings') {
      return <Settings />;
    }

    if (rightPanelTab === 'git') {
      return (
        <GitPanel
          cwd={cwd}
          onDiffClick={handleGitDiffClick}
          onBranchChange={setGitBranch}
          activityEvents={activityEvents}
          onTerminalCommand={sendTerminalCommand}
          claudeRunning={aiAction !== 'idle'}
        />
      );
    }

    if (rightPanelTab === 'deploy') {
      return <DeployPanel cwd={cwd} onTerminalCommand={sendTerminalCommand} claudeRunning={aiAction !== 'idle'} onDeploymentsLoaded={setDeployments} />;
    }

    // Preview tab — show diff viewer or editor
    if (diffState) {
      return (
        <>
          <div className="editor-tabs">
            <div className="editor-tab active">
              <span>Diff: {diffState.filePath.split('/').pop()}</span>
              <span className="tab-close" role="button" aria-label="Close diff" onClick={() => setDiffState(null)}>x</span>
            </div>
          </div>
          <DiffViewer filePath={diffState.filePath} before={diffState.before} after={diffState.after} fontSize={editorFontSize} />
        </>
      );
    }

    if (openTabs.length === 0) {
      return (
        <div className="empty-state">
          <div className="empty-state-text">Select a file to preview</div>
        </div>
      );
    }
    return (
      <>
        <div className="editor-tabs">
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
        <FilePreview filePath={activeTab} onDirtyChange={handleDirtyChange} fontSize={editorFontSize} />
      </>
    );
  };

  const panelTabBar = (
    <div className="panel-tab-bar">
      <button
        className={`panel-tab ${rightPanelTab === 'preview' ? 'active' : ''}`}
        onClick={() => setRightPanelTab('preview')}
      >
        Editor
      </button>
      <button
        className={`panel-tab ${rightPanelTab === 'activity' ? 'active' : ''}`}
        onClick={() => setRightPanelTab('activity')}
      >
        Activity
        {activityEvents.length > 0 && (
          <span className="panel-tab-badge">{activityEvents.length}</span>
        )}
      </button>
      <button
        className={`panel-tab ${rightPanelTab === 'summary' ? 'active' : ''}`}
        onClick={() => setRightPanelTab('summary')}
      >
        Summary
      </button>
      <button
        className={`panel-tab ${rightPanelTab === 'git' ? 'active' : ''}`}
        onClick={() => setRightPanelTab('git')}
      >
        Git
      </button>
      <button
        className={`panel-tab ${rightPanelTab === 'deploy' ? 'active' : ''}`}
        onClick={() => setRightPanelTab('deploy')}
      >
        Deploy
      </button>
      <button
        className={`panel-tab ${rightPanelTab === 'settings' ? 'active' : ''}`}
        onClick={() => setRightPanelTab('settings')}
      >
        Settings
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

      <div className="main-content">
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
                  style={{ display: visible ? 'flex' : 'none', flex: 1 }}
                  onClick={() => {
                    if (isSplit && !isActive) {
                      setActiveTerminalId(tab.id);
                    }
                  }}
                >
                  <Terminal
                    terminalId={tab.ptyId}
                    cwd={tab.cwd}
                    isVisible={visible}
                    fontSize={terminalFontSize}
                    autoCommand={tab.autoCommand}
                    onTerminalReady={(ptyId) => updateTab(tab.id, { ptyId })}
                    onCwdChange={(newCwd) => updateTab(tab.id, { cwd: newCwd })}
                    onActionChange={(action) => updateTab(tab.id, { aiAction: action })}
                    onCostChange={(cost) => updateTab(tab.id, { costInfo: cost })}
                    onConversationUpdate={(turns) => updateTab(tab.id, { conversationTurns: turns })}
                    onLocalUrlDetected={(url) => {
                      updateTab(tab.id, { previewLocalUrl: url });
                      if (tab.id === activeTerminalIdRef.current) {
                        setPreviewLocalUrl(url);
                        setPreviewOpen(true);
                      }
                    }}
                    onProdUrlDetected={(url) => {
                      updateTab(tab.id, { previewProdUrl: url });
                      if (tab.id === activeTerminalIdRef.current) {
                        setPreviewProdUrl(url);
                        setPreviewOpen(true);
                      }
                    }}
                  />
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
                  <Sidebar {...sidebarProps} />
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
                    <Sidebar {...sidebarProps} />
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
              <Preview
                localUrl={previewLocalUrl}
                productionUrl={previewProdUrl}
                cwd={cwd}
                onSendToTerminal={sendTerminalCommand}
                deployments={deployments}
              />
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
        costInfo={costInfo}
        gitBranch={gitBranch}
      />

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} actions={paletteActions} />
    </div>
  );
}
