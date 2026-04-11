import { useState, useEffect, useRef, useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useDragResize } from './useDragResize';
import { usePersistedState } from './usePersistedState';

// usePanelLayout — owns the window-chrome layout state that App.tsx
// used to carry inline: persisted panel sizes, layout mode, right-panel
// tab selection, preview panel visibility, and the three drag-resize
// handlers that were previously ~30 lines of boilerplate in the
// component body.
//
// Audit findings closed by this hook:
//   - H19 (App.tsx decomposition, CP3)
//
// The three drag handlers already use the shared `useDragResize` from
// Wave 4; moving them into this hook means App.tsx stops seeing the
// width-ref pattern at all.

export type LayoutMode = 'two-col' | 'three-col';
export type RightPanelTab = 'preview' | 'settings' | 'git' | 'deploy';

const VALID_RIGHT_PANEL_TABS: RightPanelTab[] = ['preview', 'settings', 'git', 'deploy'];

export interface UsePanelLayoutReturn {
  // Persisted state slices
  panelsOpen: boolean;
  setPanelsOpen: Dispatch<SetStateAction<boolean>>;
  layoutMode: LayoutMode;
  setLayoutMode: Dispatch<SetStateAction<LayoutMode>>;
  panelWidth: number;
  setPanelWidth: Dispatch<SetStateAction<number>>;
  previewWidth: number;
  setPreviewWidth: Dispatch<SetStateAction<number>>;
  sidebarRatio: number;
  setSidebarRatio: Dispatch<SetStateAction<number>>;
  rightPanelTab: RightPanelTab;
  setRightPanelTab: Dispatch<SetStateAction<RightPanelTab>>;
  previewOpen: boolean;
  setPreviewOpen: Dispatch<SetStateAction<boolean>>;

  // Session-only drag-in-progress flags
  isResizing: boolean;
  isResizingPreview: boolean;

  // Convenience toggles
  togglePanels: () => void;
  toggleLayout: () => void;

  // Resize handlers — ready to attach to onMouseDown
  handlePanelResizeStart: (e: React.MouseEvent) => void;
  handleSplitResizeStart: (e: React.MouseEvent) => void;
  handlePreviewResizeStart: (e: React.MouseEvent) => void;
}

export function usePanelLayout(): UsePanelLayoutReturn {
  // Resize-in-progress flags are declared first because the persisted
  // width slices below gate their save-through-to-localStorage on them.
  const [isResizing, setIsResizing] = useState(false);
  const [isResizingPreview, setIsResizingPreview] = useState(false);

  const [panelsOpen, setPanelsOpen] = usePersistedState('panelsOpen', true);
  const [layoutMode, setLayoutMode] = usePersistedState<LayoutMode>('layoutMode', 'two-col');
  const [panelWidth, setPanelWidth] = usePersistedState('panelWidth', 360, {
    skipSave: () => isResizing,
  });
  const [previewWidth, setPreviewWidth] = usePersistedState('previewWidth', 500, {
    skipSave: () => isResizingPreview,
  });
  const [sidebarRatio, setSidebarRatio] = usePersistedState('sidebarRatio', 0.35);
  const [rightPanelTab, setRightPanelTab] = usePersistedState<RightPanelTab>('rightPanelTab', 'preview');
  const [previewOpen, setPreviewOpen] = usePersistedState('previewOpen', false);

  // Sanitize stale `rightPanelTab` values from older builds that may have
  // stored a tab name we no longer support. Runs once on mount. Kept
  // inside this hook rather than App.tsx because this hook owns the slice.
  useEffect(() => {
    if (!VALID_RIGHT_PANEL_TABS.includes(rightPanelTab)) {
      setRightPanelTab('preview');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ref mirrors for the drag handlers (they read the start value without
  // re-subscribing when width changes between drags).
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;
  const previewWidthRef = useRef(previewWidth);
  previewWidthRef.current = previewWidth;

  const handlePanelResizeStart = useDragResize({
    onStart: () => setIsResizing(true),
    onEnd: () => setIsResizing(false),
    getStartValue: () => panelWidthRef.current,
    onMove: (e, ctx) => {
      const delta = ctx.startX - e.clientX;
      setPanelWidth(
        Math.max(200, Math.min(ctx.startWidth + delta, window.innerWidth * 0.6)),
      );
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
    onEnd: () => setIsResizingPreview(false),
    getStartValue: () => previewWidthRef.current,
    onMove: (e, ctx) => {
      const delta = ctx.startX - e.clientX;
      setPreviewWidth(
        Math.max(250, Math.min(ctx.startWidth + delta, window.innerWidth * 0.6)),
      );
    },
  });

  const togglePanels = useCallback(() => {
    setPanelsOpen((prev) => !prev);
  }, [setPanelsOpen]);

  const toggleLayout = useCallback(() => {
    setLayoutMode((prev) => (prev === 'two-col' ? 'three-col' : 'two-col'));
  }, [setLayoutMode]);

  return {
    panelsOpen,
    setPanelsOpen,
    layoutMode,
    setLayoutMode,
    panelWidth,
    setPanelWidth,
    previewWidth,
    setPreviewWidth,
    sidebarRatio,
    setSidebarRatio,
    rightPanelTab,
    setRightPanelTab,
    previewOpen,
    setPreviewOpen,
    isResizing,
    isResizingPreview,
    togglePanels,
    toggleLayout,
    handlePanelResizeStart,
    handleSplitResizeStart,
    handlePreviewResizeStart,
  };
}
