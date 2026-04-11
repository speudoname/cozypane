import { BrowserWindow, WebContents } from 'electron';

// Window registry. The contract sub-handlers live by:
//   - IPC handlers reply via `event.sender` (the calling window's WebContents).
//   - PTY data/exit callbacks capture the spawning window's WebContents at
//     creation time and send directly to it; cleanupForSender tears them
//     down when the window closes.
//   - The watcher captures the sender of `watcher:start` and routes change
//     events back to it.
//   - Menu actions use `getFocusedWindow()` so clicks target the foreground.
//   - Main-process-initiated events (autoUpdater, protocol callbacks,
//     periodic update checker) use `broadcastAll()`.

let primary: BrowserWindow | null = null;

/**
 * Register a window as the primary (most-recently-created) window.
 * Automatically clears itself when the window is closed.
 */
export function registerPrimaryWindow(win: BrowserWindow): void {
  primary = win;
  win.on('closed', () => {
    if (primary === win) primary = null;
  });
}

/**
 * Return the primary window, or the first open window as a fallback, or
 * null if no windows exist. Use this for code paths that need "some"
 * window to send an event to and don't care which (e.g. protocol
 * callbacks on app boot, before any window is focused).
 */
export function getPrimaryWindow(): BrowserWindow | null {
  if (primary && !primary.isDestroyed()) return primary;
  const all = BrowserWindow.getAllWindows();
  return all.length > 0 ? all[0] : null;
}

/**
 * Return the currently focused window, falling back to the primary
 * window if nothing is focused (e.g. user clicked the menu bar while
 * the window was behind another app). Use this for menu actions.
 */
export function getFocusedWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  return getPrimaryWindow();
}

/**
 * Broadcast an IPC message to every open, non-destroyed window. Use
 * this for main-process-initiated events like auto-updater status and
 * periodic update-checker results, where every window's UI should
 * reflect the new state.
 */
export function broadcastAll(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send(channel, ...args);
    }
  }
}

/**
 * Send to a specific WebContents if it's still alive. Used by handlers
 * that stored `event.sender` at some earlier point (e.g. the watcher
 * captures the sender of `watcher:start`). Returns true on success.
 */
export function safeSend(sender: WebContents | null | undefined, channel: string, ...args: unknown[]): boolean {
  if (!sender || sender.isDestroyed()) return false;
  sender.send(channel, ...args);
  return true;
}
