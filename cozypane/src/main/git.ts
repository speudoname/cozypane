import { ipcMain } from 'electron';
import { exec, execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { getDecryptedApiKey, getSettings, callLlm } from './settings';

const GIT = '/usr/bin/git';

function gitExec(cmd: string, cwd: string): Promise<string> {
  // Use full path to git since Electron may have a limited PATH
  const fullCmd = cmd.replace(/^git /, `${GIT} `);
  return new Promise((resolve, reject) => {
    exec(fullCmd, { cwd, timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

function gitExecFile(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(GIT, args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

interface GitFileStatus {
  path: string;
  indexStatus: string;
  workStatus: string;
  staged: boolean;
  status: 'added' | 'modified' | 'deleted' | 'untracked' | 'renamed';
}

function parseStatus(line: string): GitFileStatus | null {
  if (line.length < 4) return null;
  const indexStatus = line[0];
  const workStatus = line[1];
  let filePath = line.slice(3);

  // Handle renames: "R  old -> new"
  if (filePath.includes(' -> ')) {
    filePath = filePath.split(' -> ')[1];
  }

  const staged = indexStatus !== ' ' && indexStatus !== '?';

  let status: GitFileStatus['status'] = 'modified';
  const relevant = staged ? indexStatus : workStatus;
  if (relevant === 'A' || relevant === '?') status = 'added';
  else if (relevant === 'D') status = 'deleted';
  else if (relevant === 'R') status = 'renamed';
  else if (relevant === '?' ) status = 'untracked';

  if (indexStatus === '?' && workStatus === '?') status = 'untracked';

  return { path: filePath, indexStatus, workStatus, staged, status };
}

export function registerGitHandlers() {
  ipcMain.handle('git:isRepo', async (_event, cwd: string) => {
    try {
      await gitExec('git rev-parse --is-inside-work-tree', cwd);
      return { isRepo: true };
    } catch {
      return { isRepo: false };
    }
  });

  ipcMain.handle('git:status', async (_event, cwd: string) => {
    try {
      const output = await gitExec('git status --porcelain=v1', cwd);
      const files: GitFileStatus[] = [];
      for (const line of output.split('\n')) {
        if (!line) continue;
        const parsed = parseStatus(line);
        if (parsed) files.push(parsed);
      }
      return { files };
    } catch (err: any) {
      return { files: [], error: err.message };
    }
  });

  ipcMain.handle('git:branch', async (_event, cwd: string) => {
    try {
      const branch = (await gitExec('git branch --show-current', cwd)).trim();
      if (branch) return { branch, detached: false };
      const hash = (await gitExec('git rev-parse --short HEAD', cwd)).trim();
      return { branch: hash, detached: true };
    } catch {
      return { branch: '', detached: false };
    }
  });

  ipcMain.handle('git:log', async (_event, cwd: string) => {
    try {
      const output = await gitExec('git log --oneline --format="%h|%s|%ar" -20', cwd);
      const commits = output.trim().split('\n').filter(Boolean).map(line => {
        const [hash, message, timeAgo] = line.split('|');
        return { hash, message, timeAgo };
      });
      return { commits };
    } catch {
      return { commits: [] };
    }
  });

  ipcMain.handle('git:diffFile', async (_event, cwd: string, filePath: string) => {
    try {
      let before = '';
      try {
        before = await gitExecFile(['show', `HEAD:${filePath}`], cwd);
      } catch {
        // New file — no HEAD version
        before = '';
      }
      let after = '';
      try {
        after = await fs.readFile(path.join(cwd, filePath), 'utf-8');
      } catch {
        // Deleted file
        after = '';
      }
      return { before, after };
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle('git:remoteInfo', async (_event, cwd: string) => {
    const result = { hasRemote: false, remoteUrl: '', ghAuthed: false, ghInstalled: false };
    try {
      const remoteOut = await gitExec('git remote -v', cwd);
      const pushLine = remoteOut.split('\n').find(l => l.includes('origin') && l.includes('(push)'));
      if (pushLine) {
        result.hasRemote = true;
        result.remoteUrl = pushLine.replace(/^origin\s+/, '').replace(/\s+\(push\)$/, '').trim();
      }
    } catch {}

    // Find gh CLI
    const ghPaths = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'];
    let ghPath = '';
    try {
      const whichOut = await new Promise<string>((resolve, reject) => {
        exec('which gh', { timeout: 3000 }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
      });
      if (whichOut) ghPath = whichOut;
    } catch {}
    if (!ghPath) {
      for (const p of ghPaths) {
        try { await fs.access(p); ghPath = p; break; } catch {}
      }
    }

    if (ghPath) {
      result.ghInstalled = true;
      try {
        await new Promise<string>((resolve, reject) => {
          exec(`"${ghPath}" auth status`, { timeout: 5000 }, (err, stdout, stderr) => {
            if (err) reject(err); else resolve(stdout || stderr);
          });
        });
        result.ghAuthed = true;
      } catch {}
    }

    return result;
  });

  ipcMain.handle('git:generateCommitMsg', async (_event, cwd: string) => {
    try {
      const stat = await gitExec('git diff --cached --stat', cwd);
      if (!stat.trim()) return { error: 'No staged changes to describe.' };

      let diff = await gitExec('git diff --cached', cwd);
      if (diff.length > 4000) diff = diff.slice(0, 4000) + '\n... (truncated)';

      const prompt = `Generate a concise git commit message (one line, max 72 chars) for these staged changes. Return ONLY the commit message, no quotes, no prefix.\n\nStats:\n${stat}\n\nDiff:\n${diff}`;
      const result = await callLlm(prompt, 100);
      if (result.error) return { error: result.error };
      return { message: result.text };
    } catch (err: any) {
      return { error: err.message || 'Failed to generate commit message' };
    }
  });
}
