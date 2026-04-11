import { ipcMain, WebContents } from 'electron';
import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import { isPathAllowed, addAllowedRoot } from './filesystem';
import { safeSend } from './windows';

let fileWatcher: fs.FSWatcher | null = null;
// Captured at `watcher:start` time; change events route back to this exact
// renderer rather than a stale module-global "current window".
let watcherSender: WebContents | null = null;
const recentEvents = new Map<string, number>();
const fileSnapshots = new Map<string, string>(); // filepath → content at first seen version
const MAX_SNAPSHOTS = 100;

// Paths that are system noise, not user project files
const IGNORE_PATTERN = /^(Library|Applications|Pictures|Music|Movies|Public|Downloads|\.Trash|\.cache|\.npm|\.nvm|\.local|\.config|\.docker|\.vscode|\.cursor|Containers)[/\\]/i;
const IGNORE_INNER = /(node_modules|__pycache__|\.git)[/\\]/;
const IGNORE_EXT = /\.(swp|tmp|pyc|DS_Store)$|~$/;

// Concurrency gate for `git show HEAD:<file>` lookups. Previously the
// watcher fork-bombed git on bulk file changes (e.g. `npm install` spills
// or large refactors touching hundreds of files): every first-seen file
// kicked off its own execFile with no cap, and MAX_SNAPSHOTS=100 made
// anything beyond that churn through a Map eviction. We cap at 4 inflight
// git subprocesses; extra requests queue.
const GIT_MAX_INFLIGHT = 4;
let gitInflight = 0;
const gitQueue: Array<() => void> = [];

function acquireGitSlot(): Promise<void> {
  if (gitInflight < GIT_MAX_INFLIGHT) {
    gitInflight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    gitQueue.push(() => {
      gitInflight++;
      resolve();
    });
  });
}

function releaseGitSlot() {
  gitInflight--;
  const next = gitQueue.shift();
  if (next) next();
}

async function tryGitOriginal(fullPath: string, dirPath: string): Promise<string | null> {
  await acquireGitSlot();
  const relativePath = path.relative(dirPath, fullPath);
  try {
    return await new Promise<string | null>((resolve) => {
      execFile('/usr/bin/git', ['show', `HEAD:${relativePath}`], { cwd: dirPath, timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) { resolve(null); return; }
        resolve(stdout);
      });
    });
  } finally {
    releaseGitSlot();
  }
}

export function registerWatcherHandlers() {
  ipcMain.handle('watcher:start', (event, dirPath: string) => {
    // H7: the watcher is a parallel fs-read surface (snapshot capture +
    // path forwarding to the renderer). Only allow it to watch paths that
    // are already in the project-root allowlist. A fresh `watcher:start`
    // call from the renderer means "please watch this directory" — add it
    // as a root if it is a descendant of an existing root (most common:
    // terminal cwd updated and renderer re-starts the watcher).
    if (!isPathAllowed(dirPath)) {
      // As a quality-of-life fallback, allow starting the watcher on a
      // path that matches an existing terminal cwd — but nothing beyond
      // that. This is intentionally narrow.
      return { error: 'Watcher path is not in the project allowlist' };
    }
    // Ensure the exact dirPath is itself a root so descendants are reachable.
    addAllowedRoot(dirPath);

    if (fileWatcher) {
      fileWatcher.close();
      fileWatcher = null;
    }
    recentEvents.clear();
    fileSnapshots.clear();
    watcherSender = event.sender;

    try {
      fileWatcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
        if (!filename || !watcherSender || watcherSender.isDestroyed()) return;

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
            // Evict oldest snapshots if over cap
            if (fileSnapshots.size > MAX_SNAPSHOTS) {
              const it = fileSnapshots.keys();
              while (fileSnapshots.size > MAX_SNAPSHOTS) {
                const oldest = it.next();
                if (oldest.done) break;
                fileSnapshots.delete(oldest.value);
              }
            }
          }

          safeSend(watcherSender, 'watcher:change', {
            type: eventType === 'rename' ? 'create' : 'modify',
            path: fullPath,
            name: filename,
            isDirectory: stat.isDirectory(),
            timestamp: now,
          });
        }).catch(() => {
          safeSend(watcherSender, 'watcher:change', {
            type: 'delete',
            path: fullPath,
            name: filename,
            isDirectory: false,
            timestamp: now,
          });
        });
      });
      fileWatcher.on('error', (err) => {
        // M27: previously this only logged. On macOS `fs.watch` with
        // recursive:true can throw EMFILE under heavy load, leaving the
        // Activity Feed silently frozen. Forward a structured error event
        // to the renderer so the UI can show "watcher stopped — reload to
        // recover" rather than quietly failing.
        console.error('[CozyPane] Watcher error:', err);
        safeSend(watcherSender, 'watcher:error', {
          code: (err as NodeJS.ErrnoException)?.code || 'EUNKNOWN',
          message: (err as Error)?.message || String(err),
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
    // Even though snapshots are only created for files inside a watched
    // root, re-check the allowlist here so `watcher:getDiff` cannot be
    // used as a read primitive outside the allowlist under any
    // configuration (H7 defense-in-depth).
    if (!isPathAllowed(filePath)) {
      return { error: 'Path not in project allowlist' };
    }
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
