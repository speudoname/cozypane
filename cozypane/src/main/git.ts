import { ipcMain } from 'electron';
import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

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

  ipcMain.handle('git:stage', async (_event, cwd: string, filePath: string) => {
    try {
      await gitExec(`git add -- "${filePath}"`, cwd);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git:unstage', async (_event, cwd: string, filePath: string) => {
    try {
      // On a fresh repo with no commits, reset HEAD fails — use rm --cached instead
      try {
        await gitExec(`git reset HEAD -- "${filePath}"`, cwd);
      } catch {
        await gitExec(`git rm --cached -- "${filePath}"`, cwd);
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git:stageAll', async (_event, cwd: string) => {
    try {
      await gitExec('git add -A', cwd);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git:unstageAll', async (_event, cwd: string) => {
    try {
      try {
        await gitExec('git reset HEAD', cwd);
      } catch {
        await gitExec('git rm --cached -r .', cwd);
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git:commit', async (_event, cwd: string, message: string) => {
    try {
      const output = await gitExec(`git commit -m "${message.replace(/"/g, '\\"')}"`, cwd);
      const hashMatch = output.match(/\[[\w/.-]+ ([a-f0-9]+)\]/);
      return { success: true, hash: hashMatch ? hashMatch[1] : '' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git:diffFile', async (_event, cwd: string, filePath: string) => {
    try {
      let before = '';
      try {
        before = await gitExec(`git show HEAD:"${filePath}"`, cwd);
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

  ipcMain.handle('git:revertFile', async (_event, cwd: string, filePath: string) => {
    try {
      await gitExec(`git checkout HEAD -- "${filePath}"`, cwd);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git:revertFiles', async (_event, cwd: string, filePaths: string[]) => {
    try {
      const escaped = filePaths.map(p => `"${p}"`).join(' ');
      await gitExec(`git checkout HEAD -- ${escaped}`, cwd);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}
