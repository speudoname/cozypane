import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { HoverZone } from './useFontSizes';

// Global keyboard shortcut wiring: Cmd+K (palette), Cmd+T (new tab),
// Cmd+W (editor-vs-terminal routed close), Cmd+/- / Cmd+0 (zoom).

export interface UseKeyboardShortcutsOptions {
  onOpenPalette: () => void;
  onNewTab: () => void;
  /**
   * Called when the user wants to close the active *terminal* tab. The
   * editor-tab case is resolved inline: if hoverZoneRef points at
   * 'editor', we close the editor file tab instead of the terminal.
   */
  onCloseTerminalTab: () => void;
  /**
   * Called when the user wants to close an open editor file tab while
   * the editor pane is hovered. May return false if close was cancelled
   * (e.g. dirty-check prompt declined). If this callback is absent or
   * the editor zone has no active file, Cmd+W falls through to
   * `onCloseTerminalTab`.
   */
  onCloseEditorTab?: () => boolean | void;
  onZoom: (delta: number, reset?: boolean) => void;
  hoverZoneRef: MutableRefObject<HoverZone>;
}

export function useKeyboardShortcuts(opts: UseKeyboardShortcutsOptions): void {
  const {
    onOpenPalette,
    onNewTab,
    onCloseTerminalTab,
    onCloseEditorTab,
    onZoom,
    hoverZoneRef,
  } = opts;

  useEffect(() => {
    const isMac = navigator.platform.includes('Mac');
    const handler = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;

      // Cmd+K — palette
      if (mod && e.key === 'k') {
        e.preventDefault();
        onOpenPalette();
        return;
      }

      // Cmd+T — new terminal tab
      if (mod && e.key === 't') {
        e.preventDefault();
        onNewTab();
        return;
      }

      // Cmd+W — close tab (editor vs terminal aware, M44)
      if (mod && e.key === 'w') {
        e.preventDefault();
        if (hoverZoneRef.current === 'editor' && onCloseEditorTab) {
          const handled = onCloseEditorTab();
          if (handled !== false) return;
        }
        onCloseTerminalTab();
        return;
      }

      // Cmd+= / Cmd++ — zoom in
      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        onZoom(1);
        return;
      }

      // Cmd+- — zoom out
      if (mod && e.key === '-') {
        e.preventDefault();
        onZoom(-1);
        return;
      }

      // Cmd+0 — reset zoom
      if (mod && e.key === '0') {
        e.preventDefault();
        onZoom(0, true);
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onOpenPalette, onNewTab, onCloseTerminalTab, onCloseEditorTab, onZoom, hoverZoneRef]);
}
