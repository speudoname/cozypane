import { ipcMain, app } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { getSlashCommands } from './slash-commands';

// ---- Allowlist-based path fence (H2/H7) ----
//
// Previously `assertSafePath` only checked that paths were under `os.homedir()`,
// which let a compromised renderer read `~/.ssh/id_rsa`, `~/.aws/credentials`,
// `~/.claude.json`, etc. The new policy:
//
//   1. Maintain an in-memory Set of "allowed roots" — directories the user
//      has explicitly opened (via fs:pickDirectory) or cd'd into from a PTY.
//   2. Reject any path that isn't under one of the allowed roots, with a
//      hard denylist of sensitive locations applied first.
//
// `cozypane/src/main/main.ts` and `cozypane/src/main/pty.ts` call
// `addAllowedRoot()` whenever a project is opened or a terminal's cwd moves.
// `app.getPath('userData')` is always allowed so the app's own state files
// (`deploy-auth.json`, `cozypane-mcp.json`, askpass helper) remain reachable.

const allowedRoots = new Set<string>();

/** Explicit denylist of sensitive locations inside the home directory. */
const HOME = os.homedir();
const DENYLIST: string[] = [
  path.join(HOME, '.ssh'),
  path.join(HOME, '.aws'),
  path.join(HOME, '.gnupg'),
  path.join(HOME, '.netrc'),
  path.join(HOME, '.gitconfig'),
  path.join(HOME, '.claude.json'),
  path.join(HOME, 'Library', 'Application Support', 'Google'),
  path.join(HOME, 'Library', 'Application Support', 'Slack'),
  path.join(HOME, 'Library', 'Cookies'),
  path.join(HOME, 'Library', 'Keychains'),
];

function isDenied(resolved: string): boolean {
  for (const denied of DENYLIST) {
    if (resolved === denied || resolved.startsWith(denied + path.sep)) return true;
  }
  return false;
}

function isUnderRoot(resolved: string, root: string): boolean {
  if (resolved === root) return true;
  return resolved.startsWith(root + path.sep);
}

/**
 * Add a directory (and its descendants) to the allowlist. Called by:
 *   - `fs:pickDirectory` IPC handler (user picked a project folder)
 *   - terminal `create` handler when a PTY's cwd is known
 *   - PTY cwd-polling when the terminal cd's into a new location
 *
 * Safe to call repeatedly — the Set dedupes.
 */
export function addAllowedRoot(rootPath: string): void {
  if (!rootPath) return;
  try {
    const resolved = path.resolve(rootPath);
    if (isDenied(resolved)) return;
    allowedRoots.add(resolved);
  } catch { /* ignore */ }
}

/**
 * Remove a root from the allowlist (e.g. when the user closes a project tab).
 */
export function removeAllowedRoot(rootPath: string): void {
  if (!rootPath) return;
  try {
    allowedRoots.delete(path.resolve(rootPath));
  } catch { /* ignore */ }
}

/** Snapshot of currently allowed roots — used by other modules (e.g. watcher). */
export function getAllowedRoots(): string[] {
  return Array.from(allowedRoots);
}

/** True if `filePath` is allowed under the current fence. Does NOT throw. */
export function isPathAllowed(filePath: string): boolean {
  try {
    const resolved = path.resolve(filePath);
    if (isDenied(resolved)) return false;
    // Always allow Electron's own userData directory (deploy-auth.json,
    // cozypane-mcp.json, askpass helper, etc.)
    const userData = app.getPath('userData');
    if (isUnderRoot(resolved, userData)) return true;
    // Otherwise require one of the opened project roots to be a prefix.
    for (const root of allowedRoots) {
      if (isUnderRoot(resolved, root)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function assertSafePath(filePath: string): void {
  if (!isPathAllowed(filePath)) {
    const resolved = (() => { try { return path.resolve(filePath); } catch { return filePath; } })();
    throw new Error(`Path not permitted: ${resolved}`);
  }
}

export function registerFsHandlers() {
  ipcMain.handle('fs:readdir', async (_event, dirPath: string) => {
    try {
      assertSafePath(dirPath);
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      return entries
        .filter(entry => entry.name !== '.git')
        .map(entry => ({
          name: entry.name,
          path: path.join(dirPath, entry.name),
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        }))
        .sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });
    } catch (err: any) {
      // Return [] to keep the caller's array-based contract, but log to the
      // main process so developers can distinguish permission denied /
      // missing-dir / other errors during debugging. Previously these all
      // collapsed into a silent empty directory.
      console.error('[CozyPane] fs:readdir failed', dirPath, err?.code || err?.message || err);
      return [];
    }
  });

  ipcMain.handle('fs:readfile', async (_event, filePath: string) => {
    try {
      assertSafePath(filePath);
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 1024 * 1024) {
        return { error: 'File too large to preview (>1MB)' };
      }
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return { content, size: stat.size };
    } catch (err: any) {
      // Surface the error code (ENOENT, EACCES, EISDIR, ...) so the renderer
      // can distinguish "missing file" from "permission denied" instead of
      // seeing a generic message for every failure.
      const code = err?.code || err?.message || 'EUNKNOWN';
      return { error: `Could not read file: ${code}` };
    }
  });

  // Read binary file as base64 (for images, etc.)
  ipcMain.handle('fs:readBinary', async (_event, filePath: string) => {
    try {
      assertSafePath(filePath);
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 20 * 1024 * 1024) {
        return { error: 'File too large to preview (>20MB)' };
      }
      const buffer = await fs.promises.readFile(filePath);
      const base64 = buffer.toString('base64');
      const ext = path.extname(filePath).toLowerCase().slice(1);
      const mimeMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        ico: 'image/x-icon', bmp: 'image/bmp',
        mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
        pdf: 'application/pdf',
      };
      const mime = mimeMap[ext] || 'application/octet-stream';
      return { base64, mime, size: stat.size };
    } catch {
      return { error: 'Could not read file' };
    }
  });

  ipcMain.handle('fs:writefile', async (_event, filePath: string, content: string) => {
    try {
      assertSafePath(filePath);
      await fs.promises.writeFile(filePath, content, 'utf-8');
      return { success: true };
    } catch (err: any) {
      return { error: err.message || 'Could not write file' };
    }
  });

  ipcMain.handle('fs:mkdir', async (_event, dirPath: string) => {
    try {
      assertSafePath(dirPath);
      await fs.promises.mkdir(dirPath, { recursive: true });
      return { success: true };
    } catch (err: any) {
      return { error: err.message || 'Could not create directory' };
    }
  });

  ipcMain.handle('fs:unlink', async (_event, filePath: string) => {
    try {
      assertSafePath(filePath);
      await fs.promises.unlink(filePath);
      return { success: true };
    } catch (err: any) {
      return { error: err.message || 'Could not delete file' };
    }
  });

  ipcMain.handle('fs:rmdir', async (_event, dirPath: string) => {
    try {
      assertSafePath(dirPath);
      await fs.promises.rm(dirPath, { recursive: true, force: true });
      return { success: true };
    } catch (err: any) {
      return { error: err.message || 'Could not delete directory' };
    }
  });

  ipcMain.handle('fs:rename', async (_event, oldPath: string, newPath: string) => {
    try {
      assertSafePath(oldPath);
      assertSafePath(newPath);
      await fs.promises.rename(oldPath, newPath);
      return { success: true };
    } catch (err: any) {
      return { error: err.message || 'Could not rename' };
    }
  });

  ipcMain.handle('fs:homedir', () => {
    return os.homedir();
  });

  ipcMain.handle('fs:getSlashCommands', async (_event, cwd?: string) => {
    return getSlashCommands(cwd);
  });
}
