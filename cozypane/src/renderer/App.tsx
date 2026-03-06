import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import Sidebar from './components/Sidebar';
import FilePreview from './components/FilePreview';
import Terminal from './components/Terminal';
import StatusBar from './components/StatusBar';
import ActivityFeed from './components/ActivityFeed';
import DiffViewer from './components/DiffViewer';
import ConversationHistory from './components/ConversationHistory';
import type { ConversationTurn } from './components/ConversationHistory';
import Settings from './components/Settings';
import GitPanel from './components/GitPanel';
import type { AiAction, CostInfo } from './lib/terminalAnalyzer';

type LayoutMode = 'two-col' | 'three-col';
type RightPanelTab = 'preview' | 'activity' | 'conversation' | 'settings' | 'git';

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

export default function App() {
  const [panelsOpen, setPanelsOpen] = useState(() => loadPersisted('panelsOpen', true));
  const [cwd, setCwd] = useState<string>(() => loadPersisted('cwd', ''));
  const [openTabs, setOpenTabs] = useState<OpenTab[]>(() => loadPersisted('openTabs', []));
  const [activeTab, setActiveTab] = useState<string | null>(() => loadPersisted('activeTab', null));
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => loadPersisted('layoutMode', 'two-col'));
  const [panelWidth, setPanelWidth] = useState(() => loadPersisted('panelWidth', 360));
  const [isResizing, setIsResizing] = useState(false);
  const [sidebarRatio, setSidebarRatio] = useState(() => loadPersisted('sidebarRatio', 0.35));
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [activityEvents, setActivityEvents] = useState<FileChangeEvent[]>([]);
  const [lastWatcherEvent, setLastWatcherEvent] = useState<FileChangeEvent | null>(null);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>(() => loadPersisted('rightPanelTab', 'preview'));
  const [aiAction, setAiAction] = useState<AiAction>('idle');
  const [costInfo, setCostInfo] = useState<CostInfo>({ cost: null, tokens: null });
  const [conversationTurns, setConversationTurns] = useState<ConversationTurn[]>([]);
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [gitBranch, setGitBranch] = useState('');

  // Initialize cwd to home directory on mount (only if no persisted cwd)
  useEffect(() => {
    if (!cwd) {
      window.cozyPane.fs.homedir().then(home => setCwd(home));
    }
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

    setActivityEvents([]);
    setSummary(null);
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
      // No diff available, open file normally
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

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
      splitCleanupRef.current?.();
    };
  }, []);

  const togglePanels = useCallback(() => {
    setPanelsOpen(prev => !prev);
  }, []);

  const toggleLayout = useCallback(() => {
    setLayoutMode(prev => prev === 'two-col' ? 'three-col' : 'two-col');
  }, []);

  const handleDirtyChange = useCallback((filePath: string, isDirty: boolean) => {
    setOpenTabs(prev => prev.map(t =>
      t.path === filePath ? { ...t, dirty: isDirty } : t
    ));
  }, []);

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

    if (rightPanelTab === 'conversation') {
      return <ConversationHistory turns={conversationTurns} />;
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
        />
      );
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
          <DiffViewer filePath={diffState.filePath} before={diffState.before} after={diffState.after} />
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
        <FilePreview filePath={activeTab} onDirtyChange={handleDirtyChange} />
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
        className={`panel-tab ${rightPanelTab === 'conversation' ? 'active' : ''}`}
        onClick={() => setRightPanelTab('conversation')}
      >
        Chat
        {conversationTurns.length > 0 && (
          <span className="panel-tab-badge">{conversationTurns.length}</span>
        )}
      </button>
      <button
        className={`panel-tab ${rightPanelTab === 'git' ? 'active' : ''}`}
        onClick={() => setRightPanelTab('git')}
      >
        Git
      </button>
      <button
        className={`panel-tab ${rightPanelTab === 'settings' ? 'active' : ''}`}
        onClick={() => setRightPanelTab('settings')}
      >
        Settings
      </button>
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
  };

  return (
    <div className="app">
      <div className="titlebar">
        <span className="titlebar-text">CozyPane</span>
        <div className="titlebar-actions">
          <button className="btn titlebar-btn" onClick={togglePanels} title="Toggle panels" aria-label="Toggle panels">
            {panelsOpen ? '>' : '<'}
          </button>
          {panelsOpen && (
            <button className="btn titlebar-btn" onClick={toggleLayout} title="Toggle layout" aria-label="Toggle layout">
              {layoutMode === 'two-col' ? '|||' : '||'}
            </button>
          )}
        </div>
      </div>

      <div className="main-content">
        <div className="terminal-pane">
          <Terminal
            cwd={cwd}
            onCwdChange={setCwd}
            onActionChange={setAiAction}
            onCostChange={setCostInfo}
            onConversationUpdate={setConversationTurns}
          />
        </div>

        {panelsOpen && (
          <>
            <div
              className={`resize-handle ${isResizing ? 'active' : ''}`}
              onMouseDown={handlePanelResizeStart}
            />

            {layoutMode === 'two-col' ? (
              <div className="right-panel" style={{ width: panelWidth }}>
                <div className="panel-section" style={{ flex: sidebarRatio }}>
                  <Sidebar {...sidebarProps} />
                </div>
                <div className="resize-handle-h" onMouseDown={handleSplitResizeStart} />
                <div className="panel-section preview-section" style={{ flex: 1 - sidebarRatio }}>
                  {panelTabBar}
                  {renderBottomPanel()}
                </div>
              </div>
            ) : (
              <>
                <div className="right-panel" style={{ width: 180, minWidth: 140, maxWidth: 240 }}>
                  <div className="panel-section" style={{ flex: 1 }}>
                    <Sidebar {...sidebarProps} />
                  </div>
                </div>
                <div className="right-panel preview-panel" style={{ width: panelWidth }}>
                  <div className="panel-section preview-section" style={{ flex: 1 }}>
                    {panelTabBar}
                    {renderBottomPanel()}
                  </div>
                </div>
              </>
            )}
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
    </div>
  );
}
