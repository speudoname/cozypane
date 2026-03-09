import { app, BrowserWindow, dialog } from 'electron';
import path from 'path';
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Register IPC handlers from modules
registerPtyHandlers(getWindow);
registerFsHandlers();
registerWatcherHandlers(getWindow);
registerSettingsHandlers();
registerGitHandlers();

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
      if (response === 0) autoUpdater.quitAndInstall();
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
