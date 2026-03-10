import { app, BrowserWindow, dialog, Menu, shell, ipcMain, clipboard, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { autoUpdater } from 'electron-updater';

import { registerPtyHandlers, killAllPtys } from './pty';
import { registerFsHandlers } from './filesystem';
import { registerWatcherHandlers, closeWatcher } from './watcher';
import { registerSettingsHandlers } from './settings';
import { registerGitHandlers } from './git';

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
const isDev = !app.isPackaged;

function getWindow() { return mainWindow; }

function createWindow() {
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
        ...(isDev ? [
          { type: 'separator' as const },
          { role: 'toggleDevTools' as const },
        ] : []),
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
registerPtyHandlers(getWindow);
registerFsHandlers();
registerWatcherHandlers(getWindow);
registerSettingsHandlers();
registerGitHandlers();

// File picker dialog
ipcMain.handle('fs:pickFile', async () => {
  if (!mainWindow) return { paths: [] };
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: 'Attach File',
  });
  return { paths: result.canceled ? [] : result.filePaths };
});

// Save clipboard image to temp file
ipcMain.handle('fs:saveClipboardImage', async () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return { path: null };
  const tmpDir = path.join(os.tmpdir(), 'cozypane');
  fs.mkdirSync(tmpDir, { recursive: true });
  const fileName = `clipboard-${Date.now()}.png`;
  const filePath = path.join(tmpDir, fileName);
  fs.writeFileSync(filePath, img.toPNG());
  return { path: filePath };
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
      } catch {}
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
    dialog.showMessageBox(mainWindow!, {
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

  autoUpdater.checkForUpdates();
  // Check every 4 hours
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
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
        } catch {}
      }
    });
  }

  buildMenu();
  createWindow();
  setupAutoUpdater();
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

app.on('before-quit', () => {
  killAllPtys();
  closeWatcher();
});
