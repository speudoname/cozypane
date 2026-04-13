import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useConfirm } from './lib/confirmContext';
import { useTerminalTabs } from './lib/useTerminalTabs';
import { usePanelLayout } from './lib/usePanelLayout';
import { useFontSizes } from './lib/useFontSizes';
import { useKeyboardShortcuts } from './lib/useKeyboardShortcuts';
import { useDeployState } from './lib/useDeployState';
import { useFileEditorTabs } from './lib/useFileEditorTabs';
import { usePreviewState } from './lib/usePreviewState';
import { Eye, GitBranch, Rocket, Settings2, Cloud, Activity } from 'lucide-react';
import Sidebar from './components/Sidebar';
import FilePreview from './components/FilePreview';
import Terminal from './components/Terminal';
import StatusBar from './components/StatusBar';
import DiffViewer from './components/DiffViewer';
import Settings from './components/Settings';
import GitPanel from './components/GitPanel';
import DeployTab from './components/DeployTab';
import DeployManagement from './components/DeployManagement';
import Preview from './components/Preview';
import InspectPanel from './components/InspectPanel';
import ErrorBoundary from './components/ErrorBoundary';
import TabLauncher from './components/TabLauncher';
import UpdateBanner from './components/UpdateBanner';
import { enableCozyMode } from './lib/cozyMode';

import CommandPalette from './components/CommandPalette';
import type { PaletteAction } from './components/CommandPalette';
import TerminalTabBar from './components/TerminalTabBar';

export default function App() {
  const confirm = useConfirm();

  const {
    panelsOpen, setPanelsOpen,
    layoutMode, setLayoutMode,
    panelWidth,
    previewWidth,
    sidebarRatio,
    rightPanelTab, setRightPanelTab,
    previewOpen, setPreviewOpen,
    deployPanelOpen, setDeployPanelOpen,
    deployPanelWidth,
    isResizing, isResizingPreview, isResizingDeployPanel,
    togglePanels, toggleLayout,
    handlePanelResizeStart, handleSplitResizeStart, handlePreviewResizeStart,
    handleDeployPanelResizeStart,
  } = usePanelLayout();

  const {
    terminalFontSize, setTerminalFontSize,
    editorFontSize, setEditorFontSize,
    sidebarFontSize, setSidebarFontSize,
    panelFontSize,
    adjustZoom,
    hoverZoneRef,
  } = useFontSizes();

  // --- Remaining session-only state ---
  const [gitBranch, setGitBranch] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);

  // --- Deploy state (auth + deployments) ---
  const {
    deployAuth, deployments,
    handleDeployLogin, handleDeployLogout,
    refreshDeployments: loadDeployments,
  } = useDeployState();

  // Terminal tab state machine + per-tab watcher. Variable names aliased
  // at destructure so existing JSX call sites read naturally.
  const {
    tabs: terminalTabs,
    activeId: activeTerminalId,
    splitId: splitTerminalId,
    cwd,
    aiAction,
    isClaudeRunning,
    activityEvents,
    lastWatcherEvent,
    changedFiles,
    activeIdRef: activeTerminalIdRef,
    tabsRef: terminalTabsRef,
    addTab: addTerminalTab,
    closeTab: closeTerminalTab,
    closeActiveTab: closeActiveTerminalTab,
    switchTab: switchTerminalTab,
    toggleSplit,
    updateTab,
    setActiveCwd: setCwd,
    reorderTabs,
  } = useTerminalTabs({ confirm });

  // --- File editor tabs (Monaco) ---
  const {
    openTabs, activeTab, setActiveTab,
    diffState, setDiffState,
    handleFileSelect, handleDiffClick, handleGitDiffClick,
    handleCloseTab, handleDirtyChange,
    closeEditorTabIfActive,
  } = useFileEditorTabs({ confirm, setRightPanelTab });

  // --- Preview / Inspect state ---
  const {
    previewLocalUrl, previewLocalUrls, previewProdUrl,
    previewInitialErrors, previewInitialConsoleLogs, previewInitialNetworkErrors,
    networkRequests, liveConsoleLogs,
    screenshotPath, screenshotTimestamp,
    autoPreviewDisabled, autoPreviewDisabledRef, toggleAutoPreview,
    autoPreviewToast, setAutoPreviewToast,
    handleRefreshSnapshot, handleDevServerStateChange,
    handleLocalUrlDetected, handleLocalUrlsDetected, handleProdUrlDetected,
    setLiveConsoleLogs, setNetworkRequests,
    setScreenshotPath, setScreenshotTimestamp,
  } = usePreviewState({
    terminalTabsRef,
    activeTerminalIdRef,
    activeTerminalId,
    cwd,
    updateTab,
    setPreviewOpen,
  });

  // Persist `cwd` whenever the active terminal's cwd changes. This stays
  // as a manual effect because `cwd` is DERIVED from the active terminal
  // tab (inside the hook), not a dedicated state slice that
  // usePersistedState could own.
  useEffect(() => {
    if (cwd) {
      try { localStorage.setItem('cozyPane:cwd', JSON.stringify(cwd)); } catch {}
    }
  }, [cwd]);

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

  // Auto-spawn a companion dev server tab if the project has a dev command.
  // Called after launching the main (Claude) tab for a project.
  const maybeSpawnDevServer = useCallback(async (projectCwd: string) => {
    if (autoPreviewDisabledRef.current) return;
    try {
      const [info, portResult] = await Promise.all([
        window.cozyPane.preview.detectProject(projectCwd),
        window.cozyPane.preview.suggestPort(),
      ]);
      if (!info?.devCommand) return;
      // Don't auto-start for server-only projects (express, fastify, etc.) — no UI to preview
      if (info.type && /express|fastify|koa|hapi|nest/i.test(info.type)) return;
      const port = portResult?.port || 3000;
      const cmd = info.devCommand;
      const portFlag = cmd.includes('vite') || cmd.includes('next') || cmd.includes('nuxi')
        ? ` --port ${port}`
        : cmd.includes('ng serve') ? ` --port ${port}`
        : '';
      // Remember which tab is the main (Claude) tab so we can switch back
      const mainTabId = activeTerminalIdRef.current;
      addTerminalTab({
        cwd: projectCwd,
        customLabel: 'Dev Server',
        autoCommand: cmd + portFlag,
        launched: true,
        isDevServer: true,
      });
      // addTerminalTab makes the new tab active — switch back to the Claude tab
      // Use requestAnimationFrame to let the state update settle first
      requestAnimationFrame(() => {
        switchTerminalTab(mainTabId);
      });
    } catch {}
  }, [addTerminalTab, switchTerminalTab]);

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
    // Auto-spawn dev server in a companion tab for web projects
    maybeSpawnDevServer(cwd);
  }, [updateTab, buildClaudeAutoCommand, maybeSpawnDevServer]);

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
    maybeSpawnDevServer(fullPath);
  }, [updateTab, buildClaudeAutoCommand, confirm, maybeSpawnDevServer]);

  const launchNewTerminal = useCallback(async () => {
    const tab = terminalTabsRef.current.find(t => t.id === activeTerminalIdRef.current);
    const dir = tab?.cwd || await window.cozyPane.fs.homedir();
    updateTab(activeTerminalIdRef.current, {
      cwd: dir,
      launched: true,
    });
  }, [updateTab]);

  // Cmd+W editor-vs-terminal routing (M44): returning `false` from the
  // editor-close callback tells the hook to fall through to terminal-tab
  // close when there's no active editor file.
  const openPalette = useCallback(() => setPaletteOpen(prev => !prev), []);

  useKeyboardShortcuts({
    onOpenPalette: openPalette,
    onNewTab: addTerminalTab,
    onCloseTerminalTab: () => { void closeActiveTerminalTab(); },
    onCloseEditorTab: closeEditorTabIfActive,
    onZoom: adjustZoom,
    hoverZoneRef,
  });

  // Menu event listeners from Electron main process
  useEffect(() => {
    const cleanups = [
      window.cozyPane.onMenuAction('menu:new-tab', addTerminalTab),
      window.cozyPane.onMenuAction('menu:close-tab', () => { void closeActiveTerminalTab(); }),
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
  }, [addTerminalTab, closeActiveTerminalTab, togglePanels, toggleLayout, toggleSplit, adjustZoom]);

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
    { id: 'tab-inspect', label: 'Show Inspect', category: 'Tab', action: () => setRightPanelTab('inspect') },
    { id: 'toggle-preview', label: 'Toggle Preview Panel', category: 'View', action: () => setPreviewOpen(p => !p) },
    { id: 'toggle-auto-preview', label: `Auto-Preview on Dev Server: ${autoPreviewDisabled ? 'OFF' : 'ON'}`, category: 'View', action: toggleAutoPreview },
    { id: 'git-stage-all', label: 'Stage All Changes', category: 'Git', action: () => { sendTerminalCommand('git add -A'); setRightPanelTab('git'); } },
    { id: 'git-commit', label: 'Open Git to Commit', category: 'Git', action: () => setRightPanelTab('git') },
    { id: 'git-push', label: 'Push', category: 'Git', action: () => { sendTerminalCommand('git push'); setRightPanelTab('git'); } },
    { id: 'git-pull', label: 'Pull', category: 'Git', action: () => { sendTerminalCommand('git pull'); setRightPanelTab('git'); } },
    { id: 'theme-cozy', label: 'Theme: Cozy Dark', category: 'Theme', action: () => applyTheme('cozy-dark') },
    { id: 'theme-ocean', label: 'Theme: Ocean', category: 'Theme', action: () => applyTheme('ocean') },
    { id: 'theme-forest', label: 'Theme: Forest', category: 'Theme', action: () => applyTheme('forest') },
    { id: 'theme-light', label: 'Theme: Light', category: 'Theme', action: () => applyTheme('cozy-light') },
  ], [addTerminalTab, sendTerminalCommand, applyTheme, autoPreviewDisabled, toggleAutoPreview]);

  // Run update command in a new terminal tab
  const handleRunUpdate = useCallback((command: string) => {
    const home = terminalTabsRef.current.find(t => t.cwd)?.cwd || '';
    addTerminalTab({
      cwd: home,
      customLabel: 'Updates',
      autoCommand: command,
      launched: true,
    });
  }, [addTerminalTab, terminalTabsRef]);

  // Monaco container must ALWAYS stay mounted (CLAUDE.md rule) — Monaco
  // spin-up is expensive and visibly flickers. FilePreview is rendered
  // once, permanently; its container is toggled via `display: none` for
  // diff/empty sub-views. Same trick used for terminal tabs.
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
          <ErrorBoundary panel="Editor">
            <div style={{ display: showEditor ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
              <FilePreview filePath={activeTab} onDirtyChange={handleDirtyChange} fontSize={editorFontSize} />
            </div>
          </ErrorBoundary>

          {/* Diff viewer — mounted only when a diff is active. DiffViewer
              is less expensive to remount than FilePreview and its content
              (before/after) is diff-specific, so conditional mounting is
              fine here. */}
          {showDiff && diffState && (
            <ErrorBoundary panel="Diff Viewer">
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <DiffViewer filePath={diffState.filePath} before={diffState.before} after={diffState.after} fontSize={editorFontSize} />
              </div>
            </ErrorBoundary>
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
            <DeployTab
              cwd={cwd}
              auth={deployAuth}
              deployments={deployments}
              onLogin={handleDeployLogin}
              onTerminalCommand={sendTerminalCommand}
              onRefresh={loadDeployments}
              onOpenManagement={() => setDeployPanelOpen(true)}
            />
          </ErrorBoundary>
        )}
        {rightPanelTab === 'inspect' && (
          <ErrorBoundary panel="Inspect">
            <InspectPanel
              consoleLogs={liveConsoleLogs}
              networkRequests={networkRequests}
              devServerState={terminalTabsRef.current.find(t => t.isDevServer && t.cwd === cwd)?.devServerState}
              previewUrl={previewLocalUrl || previewProdUrl || null}
              screenshotPath={screenshotPath}
              screenshotTimestamp={screenshotTimestamp}
              onRefreshSnapshot={handleRefreshSnapshot}
            />
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
      <button
        className={`panel-tab ${rightPanelTab === 'inspect' ? 'active' : ''}`}
        onClick={() => setRightPanelTab('inspect')}
      >
        <Activity size={13} /> Inspect
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
            className={`btn titlebar-btn ${deployPanelOpen ? 'titlebar-btn-active' : ''}`}
            onClick={() => setDeployPanelOpen(p => !p)}
            title="Toggle deploy management"
            aria-label="Toggle deploy management"
          >
            <Cloud size={14} />
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
        {(isResizing || isResizingPreview || isResizingDeployPanel) && (
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
            onReorder={reorderTabs}
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
                      switchTerminalTab(tab.id);
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
                      onLocalUrlDetected={(url) => handleLocalUrlDetected(tab.id, url)}
                      onLocalUrlsDetected={(urls) => handleLocalUrlsDetected(tab.id, urls)}
                      onProdUrlDetected={(url) => handleProdUrlDetected(tab.id, url)}
                      onDevServerStateChange={tab.isDevServer
                        ? (state) => handleDevServerStateChange(tab.id, state)
                        : undefined
                      }
                      bufferSize={tab.isDevServer ? 150 : 50}
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

        {/* Deploy Management Panel — global, between right panel and preview */}
        {deployPanelOpen && (
          <>
            <div
              className={`resize-handle ${isResizingDeployPanel ? 'active' : ''}`}
              onMouseDown={handleDeployPanelResizeStart}
            />
            <div className="right-panel preview-panel" style={{ width: deployPanelWidth }}>
              <ErrorBoundary panel="Deploy Management">
                <DeployManagement
                  auth={deployAuth}
                  deployments={deployments}
                  onLogin={handleDeployLogin}
                  onLogout={handleDeployLogout}
                  onRefresh={loadDeployments}
                  onTerminalCommand={sendTerminalCommand}
                />
              </ErrorBoundary>
            </div>
          </>
        )}

        {/* Preview Panel — always mounted, hidden via display:none.
            Webview elements crash Chromium if destroyed while event
            listeners are still attached (same pattern as Monaco). */}
        <div
          className={`resize-handle ${isResizingPreview ? 'active' : ''}`}
          onMouseDown={handlePreviewResizeStart}
          style={{ display: previewOpen ? undefined : 'none' }}
        />
        <div className="right-panel preview-panel" style={{ width: previewWidth, display: previewOpen ? undefined : 'none' }}>
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
                setLiveConsoleLogs(consoleLogs);
              }}
              onNetworkRequest={(req) => {
                setNetworkRequests(prev => [...prev.slice(-199), req]);
              }}
              onScreenshotCaptured={(path) => { setScreenshotPath(path); setScreenshotTimestamp(Date.now()); }}
            />
          </ErrorBoundary>
        </div>
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

      {autoPreviewToast && (
        <div className="auto-preview-toast" onClick={() => setAutoPreviewToast(null)}>
          Dev server detected — Preview opened
          <span className="auto-preview-toast-url">{autoPreviewToast}</span>
        </div>
      )}
    </div>
  );
}
