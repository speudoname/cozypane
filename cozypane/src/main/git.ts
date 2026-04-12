import { ipcMain } from 'electron';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { callLlm } from './settings';
import { getGithubToken, getAskpassHelperPath } from './deploy';

const GIT = '/usr/bin/git';

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
      await gitExecFile(['rev-parse', '--is-inside-work-tree'], cwd);
      return { isRepo: true };
    } catch {
      return { isRepo: false };
    }
  });

  ipcMain.handle('git:status', async (_event, cwd: string) => {
    try {
      const output = await gitExecFile(['status', '--porcelain=v1'], cwd);
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
      const branch = (await gitExecFile(['branch', '--show-current'], cwd)).trim();
      if (branch) return { branch, detached: false };
      const hash = (await gitExecFile(['rev-parse', '--short', 'HEAD'], cwd)).trim();
      return { branch: hash, detached: true };
    } catch {
      return { branch: '', detached: false };
    }
  });

  ipcMain.handle('git:log', async (_event, cwd: string) => {
    try {
      const output = await gitExecFile(['log', '--oneline', '--format=%h|%s|%ar', '-5'], cwd);
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
      const resolved = path.resolve(cwd, filePath);
      if (!resolved.startsWith(path.resolve(cwd) + path.sep)) return { error: 'Invalid path' };
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
    const result: { hasRemote: boolean; remoteUrl: string; githubAuthed: boolean; isSSH: boolean; error?: string } =
      { hasRemote: false, remoteUrl: '', githubAuthed: false, isSSH: false };
    try {
      const remoteOut = await gitExecFile(['remote', '-v'], cwd);
      const pushLine = remoteOut.split('\n').find(l => l.includes('origin') && l.includes('(push)'));
      if (pushLine) {
        result.hasRemote = true;
        result.remoteUrl = pushLine.replace(/^origin\s+/, '').replace(/\s+\(push\)$/, '').trim();
        result.isSSH = result.remoteUrl.startsWith('git@');
      }
    } catch (err: any) {
      result.error = err.message || 'Failed to read git remote info';
    }

    result.githubAuthed = !!getGithubToken();
    return result;
  });

  const ALLOWED_WRAP_PREFIXES = ['git push', 'git pull', 'git fetch'];

  ipcMain.handle('git:wrapCommand', async (_event, cmd: string) => {
    // Only inject tokens for safe git commands — reject arbitrary shell strings
    const trimmed = cmd.trim();
    if (!ALLOWED_WRAP_PREFIXES.some(p => trimmed === p || trimmed.startsWith(p + ' '))) {
      return cmd; // pass through unchanged, no token injection
    }
    const ghToken = getGithubToken();
    if (!ghToken) return cmd;
    const helper = getAskpassHelperPath();
    if (process.platform === 'win32') {
      // Escape CMD special characters to prevent injection
      const esc = (s: string) => s.replace(/["%^&|<>]/g, '^$&');
      return `set "COZYPANE_GH_TOKEN=${esc(ghToken)}" && set "GIT_ASKPASS=${esc(helper)}" && ${cmd}`;
    }
    // Shell-quote values to prevent injection
    const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    return `COZYPANE_GH_TOKEN=${q(ghToken)} GIT_ASKPASS=${q(helper)} ${cmd}`;
  });

  ipcMain.handle('git:createRepo', async (_event, cwd: string, isPrivate: boolean = true) => {
    const ghToken = getGithubToken();
    if (!ghToken) return { error: 'Not authenticated with GitHub' };

    try {
      const name = path.basename(cwd);
      const res = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as any;
        return { error: body.message || `GitHub API error (${res.status})` };
      }

      const repo = await res.json() as { clone_url: string; html_url: string; full_name: string };

      // Set remote origin
      try {
        await gitExecFile(['remote', 'add', 'origin', repo.clone_url], cwd);
      } catch {
        // Remote might already exist — update it
        await gitExecFile(['remote', 'set-url', 'origin', repo.clone_url], cwd);
      }

      return { url: repo.html_url, cloneUrl: repo.clone_url, fullName: repo.full_name };
    } catch (err: any) {
      return { error: err.message || 'Failed to create repository' };
    }
  });

  ipcMain.handle('git:listRepos', async (_event, query: string) => {
    const ghToken = getGithubToken();
    if (!ghToken) return { repos: [], error: 'Not authenticated' };

    try {
      // Use search API if query provided, otherwise list user's repos sorted by recent
      let url: string;
      if (query.trim()) {
        const q = encodeURIComponent(`${query.trim()} in:name user:@me`);
        url = `https://api.github.com/search/repositories?q=${q}&sort=updated&per_page=20`;
      } else {
        url = 'https://api.github.com/user/repos?sort=updated&per_page=20&affiliation=owner';
      }

      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) return { repos: [], error: `GitHub API error (${res.status})` };

      const data = await res.json() as any;
      const items = Array.isArray(data) ? data : data.items || [];
      const repos = items.map((r: any) => ({
        fullName: r.full_name,
        cloneUrl: r.clone_url,
        htmlUrl: r.html_url,
        private: r.private,
        description: r.description || '',
      }));

      return { repos };
    } catch (err: any) {
      return { repos: [], error: err.message };
    }
  });

  ipcMain.handle('git:addRemote', async (_event, cwd: string, cloneUrl: string) => {
    // Reject transports that git supports but are RCE vectors once a fetch/pull
    // runs against them. In particular, `ext::sh -c '...'` executes the payload
    // as an ext transport helper on the next `git fetch origin`, turning a
    // compromised cloneUrl into persistent code execution.
    if (typeof cloneUrl !== 'string' || !/^(https:\/\/|git@[^\s:]+:|ssh:\/\/git@)/.test(cloneUrl)) {
      return { error: 'Unsupported remote URL. Use https:// or git@host:owner/repo.' };
    }
    try {
      try {
        await gitExecFile(['remote', 'add', 'origin', cloneUrl], cwd);
      } catch {
        await gitExecFile(['remote', 'set-url', 'origin', cloneUrl], cwd);
      }
      return { success: true };
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle('git:generateCommitMsg', async (_event, cwd: string) => {
    try {
      const stat = await gitExecFile(['diff', '--cached', '--stat'], cwd);
      if (!stat.trim()) return { error: 'No staged changes to describe.' };

      let diff = await gitExecFile(['diff', '--cached'], cwd);
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
