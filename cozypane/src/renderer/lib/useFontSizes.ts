import { useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { usePersistedState } from './usePersistedState';

// useFontSizes — per-panel zoom levels plus the hover-zone-aware
// `adjustZoom` helper that Cmd+/- keyboard shortcuts and menu actions
// delegate to. Previously four persisted useState hooks + an inline
// `adjustZoom` callback that had to be re-declared inside App.tsx.
//
// Audit findings closed by this hook:
//   - H19 (App.tsx decomposition, CP5)
//
// The hover-zone ref is owned here rather than App.tsx because the
// `adjustZoom` logic reads from it; the ref itself is exposed back so
// that pane onMouseEnter handlers in App.tsx can update it.

export type HoverZone = 'terminal' | 'sidebar' | 'editor' | 'panel';

export interface UseFontSizesReturn {
  terminalFontSize: number;
  setTerminalFontSize: Dispatch<SetStateAction<number>>;
  editorFontSize: number;
  setEditorFontSize: Dispatch<SetStateAction<number>>;
  sidebarFontSize: number;
  setSidebarFontSize: Dispatch<SetStateAction<number>>;
  panelFontSize: number;
  setPanelFontSize: Dispatch<SetStateAction<number>>;
  /** Cmd+/- / Cmd+0 adjuster. Routes by hover zone. */
  adjustZoom: (delta: number, reset?: boolean) => void;
  /** The pane that last received pointer hover — mutated by onMouseEnter. */
  hoverZoneRef: MutableRefObject<HoverZone>;
}

export function useFontSizes(): UseFontSizesReturn {
  const [terminalFontSize, setTerminalFontSize] = usePersistedState('terminalFontSize', 13);
  const [editorFontSize, setEditorFontSize] = usePersistedState('editorFontSize', 13);
  const [sidebarFontSize, setSidebarFontSize] = usePersistedState('sidebarFontSize', 13);
  const [panelFontSize, setPanelFontSize] = usePersistedState('panelFontSize', 12);

  const hoverZoneRef = useRef<HoverZone>('terminal');

  const adjustZoom = useCallback((delta: number, reset?: boolean) => {
    const zone = hoverZoneRef.current;
    const clamp = (v: number, min: number, max: number) =>
      Math.max(min, Math.min(max, v));
    if (zone === 'terminal') {
      setTerminalFontSize((prev) => (reset ? 13 : clamp(prev + delta, 8, 28)));
    } else if (zone === 'editor') {
      setEditorFontSize((prev) => (reset ? 13 : clamp(prev + delta, 8, 28)));
    } else if (zone === 'sidebar') {
      setSidebarFontSize((prev) => (reset ? 13 : clamp(prev + delta, 9, 22)));
    } else {
      setPanelFontSize((prev) => (reset ? 12 : clamp(prev + delta, 8, 22)));
    }
  }, [setTerminalFontSize, setEditorFontSize, setSidebarFontSize, setPanelFontSize]);

  return {
    terminalFontSize,
    setTerminalFontSize,
    editorFontSize,
    setEditorFontSize,
    sidebarFontSize,
    setSidebarFontSize,
    panelFontSize,
    setPanelFontSize,
    adjustZoom,
    hoverZoneRef,
  };
}
