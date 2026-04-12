import { useState, useCallback, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { usePersistedState } from './usePersistedState';
import type { ConfirmFn } from './useTerminalTabs';
import type { RightPanelTab } from './usePanelLayout';

export interface OpenTab {
  path: string;
  name: string;
  dirty?: boolean;
}

export interface DiffState {
  filePath: string;
  before: string;
  after: string;
}

export interface UseFileEditorTabsOptions {
  confirm: ConfirmFn;
  setRightPanelTab: Dispatch<SetStateAction<RightPanelTab>>;
}

export interface UseFileEditorTabsReturn {
  openTabs: OpenTab[];
  activeTab: string | null;
  setActiveTab: React.Dispatch<React.SetStateAction<string | null>>;
  diffState: DiffState | null;
  setDiffState: React.Dispatch<React.SetStateAction<DiffState | null>>;
  handleFileSelect: (filePath: string, fileName: string) => void;
  handleDiffClick: (filePath: string) => Promise<void>;
  handleGitDiffClick: (filePath: string, before: string, after: string) => void;
  handleCloseTab: (filePath: string, e: React.MouseEvent) => void;
  handleDirtyChange: (filePath: string, isDirty: boolean) => void;
  closeEditorTabIfActive: () => boolean | void;
}

export function useFileEditorTabs({
  confirm,
  setRightPanelTab,
}: UseFileEditorTabsOptions): UseFileEditorTabsReturn {
  const [openTabs, setOpenTabs] = usePersistedState<OpenTab[]>('openTabs', []);
  const [activeTab, setActiveTab] = usePersistedState<string | null>('activeTab', null);
  const [diffState, setDiffState] = useState<DiffState | null>(null);

  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;

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
  }, [setRightPanelTab]);

  const handleDiffClick = useCallback(async (filePath: string) => {
    const result = await window.cozyPane.watcher.getDiff(filePath);
    if (result.error || result.before === undefined || result.after === undefined) {
      const fileName = filePath.split('/').pop() || filePath;
      handleFileSelect(filePath, fileName);
      return;
    }
    setDiffState({ filePath, before: result.before, after: result.after });
    setRightPanelTab('preview');
  }, [handleFileSelect, setRightPanelTab]);

  const handleGitDiffClick = useCallback((filePath: string, before: string, after: string) => {
    setDiffState({ filePath, before, after });
    setRightPanelTab('preview');
  }, [setRightPanelTab]);

  const closeFileTab = useCallback(async (filePath: string): Promise<boolean> => {
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

  const handleDirtyChange = useCallback((filePath: string, isDirty: boolean) => {
    setOpenTabs(prev => prev.map(t =>
      t.path === filePath && t.dirty !== isDirty ? { ...t, dirty: isDirty } : t
    ));
  }, []);

  const closeEditorTabIfActive = useCallback((): boolean | void => {
    if (!activeTab) return false;
    void closeFileTab(activeTab);
  }, [activeTab, closeFileTab]);

  return {
    openTabs,
    activeTab,
    setActiveTab,
    diffState,
    setDiffState,
    handleFileSelect,
    handleDiffClick,
    handleGitDiffClick,
    handleCloseTab,
    handleDirtyChange,
    closeEditorTabIfActive,
  };
}
