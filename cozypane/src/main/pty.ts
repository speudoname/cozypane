import { ipcMain, BrowserWindow } from 'electron';
import { exec } from 'child_process';
import os from 'os';
import fs from 'fs';

const pty = require('node-pty');

const ptyMap = new Map<string, { process: any; cwd: string }>();
let nextId = 1;

function getShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/zsh';
}

function createPty(getWindow: () => BrowserWindow | null, cwd?: string): { id: string; cwd: string } | { error: string } {
  const shell = getShell();
  const home = os.homedir();
  const initialCwd = cwd || home;
  const id = `term-${nextId++}`;

  try {
    const process = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: initialCwd,
      env: {
        ...globalThis.process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        CLAUDECODE: '',
      },
    });

    ptyMap.set(id, { process, cwd: initialCwd });

    process.onData((data: string) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('terminal:data', id, data);
      }
    });

    process.onExit(({ exitCode }: { exitCode: number }) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('terminal:exit', id, exitCode);
      }
      ptyMap.delete(id);
    });

    return { id, cwd: initialCwd };
  } catch (err: any) {
    console.error('[CozyPane] PTY spawn failed:', err);
    return { error: err.message || 'Failed to spawn terminal' };
  }
}

function parseLsofCwd(output: string): string | null {
  for (const line of output.split('\n')) {
    if (line.startsWith('n/')) return line.slice(1);
  }
  return null;
}

function lsofCwd(targetPid: string): Promise<string | null> {
  return new Promise(resolve => {
    exec(`/usr/sbin/lsof -a -p ${targetPid} -d cwd -Fn 2>/dev/null`, { timeout: 3000 }, (err, stdout) => {
      resolve(err || !stdout ? null : parseLsofCwd(stdout));
    });
  });
}

function getCwdForPid(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    return fs.promises.readlink(`/proc/${pid}/cwd`).catch(() => null);
  }

  // macOS: find the foreground shell process and get its cwd
  return new Promise<string | null>((resolve) => {
    exec(`/bin/ps -o pid= -ax -o ppid= | awk '$2 == ${pid} { print $1 }'`, { timeout: 3000 }, async (err, childOut) => {
      const childPids = (childOut || '').trim().split('\n').filter(Boolean);
      const targetPid = childPids.length > 0 ? childPids[childPids.length - 1].trim() : String(pid);

      if (!/^\d+$/.test(targetPid)) { resolve(null); return; }

      const cwd = await lsofCwd(targetPid);
      if (cwd) { resolve(cwd); return; }
      // Fallback to parent pid if child lookup failed
      if (targetPid !== String(pid)) {
        resolve(await lsofCwd(String(pid)));
      } else {
        resolve(null);
      }
    });
  });
}

export function registerPtyHandlers(getWindow: () => BrowserWindow | null) {
  ipcMain.on('terminal:write', (_event, id: string, data: string) => {
    const entry = ptyMap.get(id);
    if (entry) {
      try { entry.process.write(data); } catch (err) { console.error('[CozyPane] PTY write error:', err); }
    }
  });

  ipcMain.on('terminal:resize', (_event, id: string, cols: number, rows: number) => {
    const entry = ptyMap.get(id);
    if (entry) {
      try { entry.process.resize(cols, rows); } catch (err) { console.error('[CozyPane] PTY resize error:', err); }
    }
  });

  ipcMain.handle('terminal:create', (_event, cwd?: string) => {
    return createPty(getWindow, cwd);
  });

  ipcMain.handle('terminal:close', (_event, id: string) => {
    const entry = ptyMap.get(id);
    if (entry) {
      try { entry.process.kill(); } catch {}
      ptyMap.delete(id);
    }
  });

  ipcMain.handle('terminal:getCwd', async (_event, id: string) => {
    const entry = ptyMap.get(id);
    if (!entry || !entry.process.pid) return null;
    return getCwdForPid(entry.process.pid);
  });
}

export function hasActivePtys(): boolean {
  return ptyMap.size > 0;
}

export function killAllPtys() {
  for (const [, entry] of ptyMap) {
    try { entry.process.kill(); } catch {}
  }
  ptyMap.clear();
}
