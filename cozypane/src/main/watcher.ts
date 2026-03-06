import { ipcMain, BrowserWindow } from 'electron';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';

let fileWatcher: fs.FSWatcher | null = null;
let watchedDir: string = '';
const recentEvents = new Map<string, number>();
const fileSnapshots = new Map<string, string>(); // filepath → content at first seen version

// Paths that are system noise, not user project files
const IGNORE_PATTERN = /^(Library|Applications|Pictures|Music|Movies|Public|Downloads|\.Trash|\.cache|\.npm|\.nvm|\.local|\.config|\.docker|\.vscode|\.cursor|Containers)[/\\]/i;
const IGNORE_INNER = /(node_modules|__pycache__|\.git)[/\\]/;
const IGNORE_EXT = /\.(swp|tmp|pyc|DS_Store)$|~$/;

function tryGitOriginal(fullPath: string, dirPath: string): Promise<string | null> {
  const relativePath = path.relative(dirPath, fullPath);
  return new Promise(resolve => {
    exec(`git show HEAD:${JSON.stringify(relativePath)}`, { cwd: dirPath, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      resolve(stdout);
    });
  });
}

export function registerWatcherHandlers(getWindow: () => BrowserWindow | null) {
  ipcMain.handle('watcher:start', (_event, dirPath: string) => {
    if (fileWatcher) {
      fileWatcher.close();
      fileWatcher = null;
    }
    recentEvents.clear();
    fileSnapshots.clear();
    watchedDir = dirPath;

    try {
      fileWatcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
        const win = getWindow();
        if (!filename || !win || win.isDestroyed()) return;

        // Filter noise
        if (IGNORE_PATTERN.test(filename)) return;
        if (IGNORE_INNER.test(filename)) return;
        if (IGNORE_EXT.test(filename)) return;
        if (filename.startsWith('.git/') || filename.startsWith('.git\\')) return;

        // Deduplicate: ignore same file within 500ms (macOS fires duplicates)
        const now = Date.now();
        const lastTime = recentEvents.get(filename);
        if (lastTime && now - lastTime < 500) return;
        recentEvents.set(filename, now);

        if (recentEvents.size > 500) {
          for (const [key, time] of recentEvents) {
            if (now - time > 5000) recentEvents.delete(key);
          }
        }

        const fullPath = path.join(dirPath, filename);

        fs.promises.stat(fullPath).then(async stat => {
          // Capture snapshot for diff on modify events (non-directory files only)
          if (!stat.isDirectory() && !fileSnapshots.has(fullPath)) {
            // First time seeing this file modified — try git for original
            const gitContent = await tryGitOriginal(fullPath, dirPath);
            if (gitContent !== null) {
              fileSnapshots.set(fullPath, gitContent);
            } else {
              // No git — store current content as baseline (first change won't have diff)
              try {
                const content = await fs.promises.readFile(fullPath, 'utf-8');
                fileSnapshots.set(fullPath, content);
              } catch {}
            }
          }

          const w = getWindow();
          if (w && !w.isDestroyed()) {
            w.webContents.send('watcher:change', {
              type: eventType === 'rename' ? 'create' : 'modify',
              path: fullPath,
              name: filename,
              isDirectory: stat.isDirectory(),
              timestamp: now,
            });
          }
        }).catch(() => {
          const w = getWindow();
          if (w && !w.isDestroyed()) {
            w.webContents.send('watcher:change', {
              type: 'delete',
              path: fullPath,
              name: filename,
              isDirectory: false,
              timestamp: now,
            });
          }
        });
      });
      return { success: true };
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle('watcher:stop', () => {
    if (fileWatcher) {
      fileWatcher.close();
      fileWatcher = null;
    }
    return { success: true };
  });

  ipcMain.handle('watcher:getDiff', async (_event, filePath: string) => {
    const before = fileSnapshots.get(filePath);
    if (before === undefined) {
      return { error: 'No snapshot available for this file' };
    }

    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 1024 * 1024) return { error: 'File too large for diff' };
      const after = await fs.promises.readFile(filePath, 'utf-8');
      return { before, after };
    } catch {
      return { error: 'Could not read current file' };
    }
  });
}

export function closeWatcher() {
  if (fileWatcher) {
    fileWatcher.close();
  }
}
