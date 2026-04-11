import { app, BrowserWindow, dialog, Menu, shell, ipcMain, clipboard } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { autoUpdater } from 'electron-updater';

import { registerPtyHandlers, killAllPtys, hasActivePtys } from './pty';
import { registerFsHandlers } from './filesystem';
import { registerWatcherHandlers, closeWatcher } from './watcher';
import { registerSettingsHandlers } from './settings';
import { registerGitHandlers } from './git';
import { registerDeployHandlers, processProtocolUrl, getToken, getGithubToken, getAskpassHelperPath, writeAskpassHelper, API_BASE } from './deploy';
import { registerPreviewHandlers } from './preview';
import { registerUpdateCheckerHandlers, startPeriodicCheck, stopPeriodicCheck } from './update-checker';

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('[CozyPane] Uncaught exception:', err);
  dialog.showErrorBox('CozyPane Error', `An unexpected error occurred:\n${err.message}`);
  killAllPtys();
  closeWatcher();
  app.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CozyPane] Unhandled rejection:', reason);
});

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
  // Focus existing window
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }

  // Find cozypane:// URL in argv (last arg on Windows, varies on Linux)
  const protocolUrl = argv.find(arg => arg.startsWith('cozypane://'));
  if (protocolUrl) {
    mainWindow?.webContents.send('deploy:protocol-callback', protocolUrl);
    processProtocolUrl(protocolUrl, getWindow);
  }
});

function getWindow() { return mainWindow; }

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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        {
          label: 'Settings...',
          accelerator: 'Cmd+,' as const,
          click: () => mainWindow?.webContents.send('menu:settings'),
        },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        ...(isMac ? [
          { type: 'separator' as const },
          {
            label: 'Speech',
            submenu: [
              { role: 'startSpeaking' as const },
              { role: 'stopSpeaking' as const },
            ],
          },
        ] : []),
      ],
    },
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => mainWindow?.webContents.send('menu:new-tab'),
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => mainWindow?.webContents.send('menu:close-tab'),
        },
        { type: 'separator' },
        {
          label: 'Split View',
          click: () => mainWindow?.webContents.send('menu:split-view'),
        },
        {
          label: 'Clear Terminal',
          accelerator: 'CmdOrCtrl+K',
          click: () => mainWindow?.webContents.send('menu:clear-terminal'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Panels',
          accelerator: 'CmdOrCtrl+B',
          click: () => mainWindow?.webContents.send('menu:toggle-panels'),
        },
        {
          label: 'Switch Layout',
          click: () => mainWindow?.webContents.send('menu:toggle-layout'),
        },
        { type: 'separator' },
        {
          label: 'Zoom In (Focused Panel)',
          accelerator: 'CmdOrCtrl+=',
          click: () => mainWindow?.webContents.send('menu:zoom-in'),
        },
        {
          label: 'Zoom Out (Focused Panel)',
          accelerator: 'CmdOrCtrl+-',
          click: () => mainWindow?.webContents.send('menu:zoom-out'),
        },
        {
          label: 'Reset Zoom (Focused Panel)',
          accelerator: 'CmdOrCtrl+0',
          click: () => mainWindow?.webContents.send('menu:zoom-reset'),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' as const },
        { role: 'toggleDevTools' as const },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : [
          { role: 'close' as const },
        ]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'CozyPane Website',
          click: () => shell.openExternal('https://cozypane.com'),
        },
        {
          label: 'Report Issue',
          click: () => shell.openExternal('https://github.com/speudoname/cozypane/issues'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Register IPC handlers from modules
registerPtyHandlers(getWindow, () => {
  const token = getToken();
  const env: Record<string, string> = {
    COZYPANE_API_URL: API_BASE,
    COZYPANE_USER_DATA: app.getPath('userData'),
  };
  if (token) env.COZYPANE_DEPLOY_TOKEN = token;
  const ghToken = getGithubToken();
  if (ghToken) {
    env.COZYPANE_GH_TOKEN = ghToken;
    env.GIT_ASKPASS = getAskpassHelperPath();
  }
  return env;
});
registerFsHandlers();
registerWatcherHandlers(getWindow);
registerSettingsHandlers();
registerGitHandlers();
registerDeployHandlers(getWindow);
registerPreviewHandlers();
registerUpdateCheckerHandlers(getWindow);

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
  return { paths: result.canceled ? [] : result.filePaths };
});

// Create directory
ipcMain.handle('fs:mkdir', async (_event, dirPath: string) => {
  const fs = await import('fs');
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return { success: true };
  } catch (err: any) {
    return { error: err.message };
  }
});

// Save clipboard image to temp file
ipcMain.handle('fs:saveClipboardImage', async () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return { path: null };
  try {
    const tmpDir = path.join(os.tmpdir(), 'cozypane');
    fs.mkdirSync(tmpDir, { recursive: true });
    const fileName = `clipboard-${Date.now()}.png`;
    const filePath = path.join(tmpDir, fileName);
    fs.writeFileSync(filePath, img.toPNG());
    return { path: filePath };
  } catch (err: any) {
    return { path: null, error: err.message };
  }
});

// Write/remove the cozypane entry in a project's local .mcp.json.
// Called from the renderer when a project is opened/created or when the cozy
// mode toggle is flipped, so the MCP tools only appear in cozy-mode projects.
ipcMain.handle('mcp:writeProjectConfig', async (_event, projectDir: string, enable: boolean) => {
  try {
    if (typeof projectDir !== 'string' || !projectDir) {
      return { error: 'projectDir is required' };
    }
    writeProjectMcpConfig(projectDir, !!enable);
    return { success: true };
  } catch (err: any) {
    return { error: err?.message || 'Failed to write project MCP config' };
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
    mainWindow?.webContents.send('updater:status', { status: 'available', version: info.version });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[CozyPane] Update downloaded:', info.version);
    mainWindow?.webContents.send('updater:status', { status: 'downloaded', version: info.version });
    if (!mainWindow) return;
    dialog.showMessageBox(mainWindow, {
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
    console.error('[CozyPane] Auto-update error:', err.message);
  });

  autoUpdater.checkForUpdates().catch((err: any) => console.error('[CozyPane] checkForUpdates failed:', err.message));
  // Check every 4 hours
  setInterval(() => autoUpdater.checkForUpdates().catch((err: any) => console.error('[CozyPane] checkForUpdates failed:', err.message)), 4 * 60 * 60 * 1000);
}

// MCP server config is written per-project (project-local .mcp.json) rather than to
// ~/.claude.json globally. A project gets the cozypane MCP entry only when cozy mode
// is enabled for it. Wiring lives in the renderer (App.tsx open/create, DeployPanel
// toggle) and calls the 'mcp:writeProjectConfig' IPC handler below.

let extractedMcpServerPath: string | null = null;

function ensureMcpServerExtracted(): string {
  if (extractedMcpServerPath) return extractedMcpServerPath;

  if (isDev) {
    extractedMcpServerPath = path.join(__dirname, 'mcp-server.js');
    return extractedMcpServerPath;
  }

  // Node.js can't require files from inside an asar archive directly.
  // Extract the MCP server to a real path on disk so Claude Code can run it.
  const asarSource = path.join(process.resourcesPath!, 'app.asar', 'dist', 'main', 'mcp-server.js');
  const extractDir = path.join(app.getPath('userData'), 'mcp');
  const extractPath = path.join(extractDir, 'mcp-server.js');

  if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
  // Always overwrite to keep in sync with app version
  fs.copyFileSync(asarSource, extractPath);
  extractedMcpServerPath = extractPath;
  return extractedMcpServerPath;
}

function writeProjectMcpConfig(projectDir: string, enable: boolean): void {
  const mcpJsonPath = path.join(projectDir, '.mcp.json');

  let config: Record<string, any> = {};
  try {
    const raw = fs.readFileSync(mcpJsonPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      config = parsed;
    }
  } catch {
    // Missing or malformed — start fresh (preserving existing is only meaningful when readable)
  }

  const servers: Record<string, any> =
    (config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers))
      ? config.mcpServers
      : {};

  if (enable) {
    const mcpServerPath = ensureMcpServerExtracted();
    servers.cozypane = {
      type: 'stdio',
      command: 'node',
      args: [mcpServerPath],
    };
  } else {
    delete servers.cozypane;
  }

  if (Object.keys(servers).length > 0) {
    config.mcpServers = servers;
  } else {
    delete config.mcpServers;
  }

  if (Object.keys(config).length === 0) {
    // Don't leave an empty .mcp.json lying around.
    try {
      if (fs.existsSync(mcpJsonPath)) fs.unlinkSync(mcpJsonPath);
    } catch (err) {
      console.error('[CozyPane] Failed to remove empty .mcp.json:', err);
    }
    return;
  }

  try {
    fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('[CozyPane] Failed to write project .mcp.json:', err);
  }
}

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

  buildMenu();
  createWindow();
  setupAutoUpdater();
  startPeriodicCheck(getWindow);
  // Write askpass helper if GitHub token exists (for git push/pull auth)
  if (getGithubToken()) writeAskpassHelper();
});

// Handle cozypane:// protocol URLs on macOS
app.on('open-url', (event, url) => {
  event.preventDefault();
  mainWindow?.webContents.send('deploy:protocol-callback', url);
  // Also process in main process for token exchange
  processProtocolUrl(url, getWindow);
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
  }
});
