import { ipcMain, BrowserWindow } from 'electron';
import { exec } from 'child_process';
import os from 'os';
import fs from 'fs';

const pty = require('node-pty');

let ptyProcess: any = null;

function getShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/zsh';
}

function createPty(getWindow: () => BrowserWindow | null, cwd?: string) {
  const shell = getShell();
  const home = os.homedir();
  const initialCwd = cwd || home;

  if (ptyProcess) {
    ptyProcess.kill();
  }

  try {
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: initialCwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        CLAUDECODE: '',
      },
    });
  } catch (err: any) {
    console.error('[CozyPane] PTY spawn failed:', err);
    return { error: err.message || 'Failed to spawn terminal' };
  }

  ptyProcess.onData((data: string) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:data', data);
    }
  });

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:exit', exitCode);
    }
  });

  return initialCwd;
}

export function registerPtyHandlers(getWindow: () => BrowserWindow | null) {
  ipcMain.on('terminal:write', (_event, data: string) => {
    if (ptyProcess) {
      try { ptyProcess.write(data); } catch {}
    }
  });

  ipcMain.on('terminal:resize', (_event, cols: number, rows: number) => {
    if (ptyProcess) {
      try { ptyProcess.resize(cols, rows); } catch {}
    }
  });

  ipcMain.handle('terminal:create', (_event, cwd?: string) => {
    return createPty(getWindow, cwd);
  });

  ipcMain.handle('terminal:getCwd', async () => {
    if (!ptyProcess || !ptyProcess.pid) return null;
    const pid = ptyProcess.pid;

    if (process.platform === 'linux') {
      try {
        return await fs.promises.readlink(`/proc/${pid}/cwd`);
      } catch {
        return null;
      }
    }

    // macOS: find the foreground shell process and get its cwd
    return new Promise<string | null>((resolve) => {
      exec(`/bin/ps -o pid= -ax -o ppid= | awk '$2 == ${pid} { print $1 }'`, (err, childOut) => {
        const childPids = (childOut || '').trim().split('\n').filter(Boolean);
        const targetPid = childPids.length > 0 ? childPids[childPids.length - 1].trim() : String(pid);

        if (!/^\d+$/.test(targetPid)) { resolve(null); return; }

        exec(`/usr/sbin/lsof -a -p ${targetPid} -d cwd -Fn 2>/dev/null`, (err2, stdout) => {
          if (err2 || !stdout) {
            if (targetPid !== String(pid)) {
              exec(`/usr/sbin/lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, (err3, stdout2) => {
                if (err3 || !stdout2) { resolve(null); return; }
                const lines = stdout2.split('\n');
                for (const line of lines) {
                  if (line.startsWith('n/')) { resolve(line.slice(1)); return; }
                }
                resolve(null);
              });
            } else {
              resolve(null);
            }
            return;
          }
          const lines = stdout.split('\n');
          for (const line of lines) {
            if (line.startsWith('n/')) { resolve(line.slice(1)); return; }
          }
          resolve(null);
        });
      });
    });
  });
}

export function killPty() {
  if (ptyProcess) {
    ptyProcess.kill();
  }
}
