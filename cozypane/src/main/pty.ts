import { ipcMain, BrowserWindow } from 'electron';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import fs from 'fs';

const execFileAsync = promisify(execFile);

const pty = require('node-pty');

const ptyMap = new Map<string, { process: any; cwd: string }>();
let nextId = 1;
let getDeployEnv: () => Record<string, string> = () => ({});

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
        ...getDeployEnv(),
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

async function getCwdForPid(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    return fs.promises.readlink(`/proc/${pid}/cwd`).catch(() => null);
  }

  // macOS: find the foreground shell process and get its cwd
  try {
    const { stdout: childOut } = await execFileAsync('/bin/ps', ['-o', 'pid=', '-ax', '-o', 'ppid='], { timeout: 3000 });
    const pidStr = String(pid);
    const childPids = (childOut || '').trim().split('\n')
      .map(line => line.trim().split(/\s+/))
      .filter(parts => parts[1] === pidStr)
      .map(parts => parts[0]);
    const targetPid = childPids.length > 0 ? childPids[childPids.length - 1] : pidStr;

    if (!/^\d+$/.test(targetPid)) return null;

    const cwd = await lsofCwd(targetPid);
    if (cwd) return cwd;
    if (targetPid !== pidStr) return lsofCwd(pidStr);
    return null;
  } catch {
    return null;
  }
}

export function registerPtyHandlers(getWindow: () => BrowserWindow | null, envGetter?: () => Record<string, string>) {
  if (envGetter) getDeployEnv = envGetter;
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
