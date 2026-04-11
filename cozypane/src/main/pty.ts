import { ipcMain, WebContents } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import fs from 'fs';
import { addAllowedRoot } from './filesystem';
import { safeSend } from './windows';

const execFileAsync = promisify(execFile);

const pty = require('node-pty');

// Each PTY records the WebContents that spawned it. Data and exit events
// route back to that exact window; killing the window kills its PTYs via
// `cleanupForSender`.
const ptyMap = new Map<string, { process: any; cwd: string; sender: WebContents }>();
let nextId = 1;
let getDeployEnv: () => Record<string, string> = () => ({});

// Per-PTY CWD cache to avoid spawning ps+lsof every 400ms
const cwdCache = new Map<number, { cwd: string | null; ts: number }>();
const CWD_CACHE_TTL = 2000; // 2 seconds

function getShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/zsh';
}

function createPty(sender: WebContents, cwd?: string): { id: string; cwd: string } | { error: string } {
  const shell = getShell();
  const home = os.homedir();
  const initialCwd = cwd || home;
  const id = `term-${nextId++}`;

  // The directory the terminal is launched in automatically becomes an
  // allowed filesystem root (H2/H7). Opening a project via TabLauncher
  // creates a PTY rooted at that directory; this keeps the sidebar and
  // watcher able to operate on it without a separate pickDirectory call.
  addAllowedRoot(initialCwd);

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

    ptyMap.set(id, { process, cwd: initialCwd, sender });

    process.onData((data: string) => {
      safeSend(sender, 'terminal:data', id, data);
    });

    process.onExit(({ exitCode }: { exitCode: number }) => {
      safeSend(sender, 'terminal:exit', id, exitCode);
      ptyMap.delete(id);
    });

    return { id, cwd: initialCwd };
  } catch (err: any) {
    console.error('[CozyPane] PTY spawn failed:', err);
    return { error: err.message || 'Failed to spawn terminal' };
  }
}

/** Kill every PTY owned by a given WebContents. Called on window close. */
export function cleanupForSender(sender: WebContents): void {
  for (const [id, entry] of ptyMap) {
    if (entry.sender === sender) {
      try { entry.process.kill(); } catch { /* already dead */ }
      ptyMap.delete(id);
    }
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
    execFile('/usr/sbin/lsof', ['-a', '-p', targetPid, '-d', 'cwd', '-Fn'], { timeout: 3000 }, (err, stdout) => {
      resolve(err || !stdout ? null : parseLsofCwd(stdout));
    });
  });
}

async function getCwdForPidUncached(pid: number): Promise<string | null> {
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

async function getCwdForPid(pid: number): Promise<string | null> {
  const cached = cwdCache.get(pid);
  if (cached && Date.now() - cached.ts < CWD_CACHE_TTL) return cached.cwd;
  const cwd = await getCwdForPidUncached(pid);
  cwdCache.set(pid, { cwd, ts: Date.now() });
  return cwd;
}

export function registerPtyHandlers(envGetter?: () => Record<string, string>) {
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

  ipcMain.handle('terminal:create', (event, cwd?: string) => {
    return createPty(event.sender, cwd);
  });

  ipcMain.handle('terminal:close', (_event, id: string) => {
    const entry = ptyMap.get(id);
    if (entry) {
      try { entry.process.kill(); } catch (err) { console.error('[CozyPane] PTY kill error:', err); }
      ptyMap.delete(id);
    }
  });

  ipcMain.handle('terminal:getCwd', async (_event, id: string) => {
    const entry = ptyMap.get(id);
    if (!entry || !entry.process.pid) return null;
    const cwd = await getCwdForPid(entry.process.pid);
    // When the terminal cd's into a new directory, add it to the allowed
    // roots so the sidebar / watcher / file operations follow along (H2/H7).
    if (cwd) addAllowedRoot(cwd);
    return cwd;
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
