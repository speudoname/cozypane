import { app, BrowserWindow } from 'electron';
import path from 'path';

import { registerPtyHandlers, killPty } from './pty';
import { registerFsHandlers } from './filesystem';
import { registerWatcherHandlers, closeWatcher } from './watcher';
import { registerSettingsHandlers } from './settings';
import { registerGitHandlers } from './git';

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('[CozyPane] Uncaught exception:', err);
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

// App lifecycle
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  killPty();
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
  killPty();
  closeWatcher();
});
