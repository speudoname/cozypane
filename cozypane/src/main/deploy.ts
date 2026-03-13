import { ipcMain, safeStorage, app, shell, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const API_BASE = process.env.COZYPANE_API_URL || 'https://api.cozypane.com';

interface StoredAuth {
  encryptedToken: string;
  username: string;
  avatarUrl: string;
}

function getAuthPath(): string {
  return path.join(app.getPath('userData'), 'deploy-auth.json');
}

function readAuth(): StoredAuth | null {
  try {
    const data = fs.readFileSync(getAuthPath(), 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function writeAuth(auth: StoredAuth) {
  const dir = path.dirname(getAuthPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getAuthPath(), JSON.stringify(auth, null, 2));
}

function clearAuth() {
  try {
    fs.unlinkSync(getAuthPath());
  } catch {}
}

function encryptToken(token: string): string {
  if (token && safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(token).toString('base64');
  }
  return token ? Buffer.from(token).toString('base64') : '';
}

function decryptToken(encrypted: string): string {
  if (!encrypted) return '';
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      try { return Buffer.from(encrypted, 'base64').toString('utf-8'); } catch { return ''; }
    }
  }
  try { return Buffer.from(encrypted, 'base64').toString('utf-8'); } catch { return ''; }
}

function getToken(): string {
  const auth = readAuth();
  if (!auth) return '';
  return decryptToken(auth.encryptedToken);
}

async function apiFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  // Don't set Content-Type for FormData (fetch sets it with boundary)
  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`API error ${response.status}: ${text || response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

function detectProjectTypeInDir(dir: string): string | null {
  if (fs.existsSync(path.join(dir, 'Dockerfile'))) return 'docker';
  if (fs.existsSync(path.join(dir, 'package.json'))) return 'node';
  if (fs.existsSync(path.join(dir, 'requirements.txt'))) return 'python';
  if (fs.existsSync(path.join(dir, 'go.mod'))) return 'go';
  if (fs.existsSync(path.join(dir, 'index.html'))) return 'static';
  return null;
}

function detectProjectType(cwd: string): { type: string; name: string } {
  const name = path.basename(cwd);

  // Check root directory first
  const rootType = detectProjectTypeInDir(cwd);
  if (rootType) return { type: rootType, name };

  // Check one level deep for monorepo structures (frontend/, backend/, app/, etc.)
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const subType = detectProjectTypeInDir(path.join(cwd, entry.name));
        if (subType) return { type: subType, name };
      }
    }
  } catch {}

  return { type: 'unknown', name };
}

async function createTarball(cwd: string): Promise<string> {
  const tmpDir = path.join(app.getPath('temp'), 'cozypane-deploy');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tarPath = path.join(tmpDir, `deploy-${Date.now()}.tar.gz`);

  const excludeArgs = [
    '--exclude=.git',
    '--exclude=node_modules',
    '--exclude=.env',
    '--exclude=__pycache__',
    '--exclude=.venv',
    '--exclude=.DS_Store',
  ];

  // Also use .gitignore if it exists
  const gitignorePath = path.join(cwd, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    excludeArgs.push(`--exclude-from=${gitignorePath}`);
  }

  await execFileAsync('tar', ['czf', tarPath, ...excludeArgs, '-C', cwd, '.']);
  return tarPath;
}

export function registerDeployHandlers(getWindow: () => BrowserWindow | null) {
  ipcMain.handle('deploy:login', async () => {
    const clientId = 'Ov23liUojbnQSvCY9Eq9';
    const redirectUri = encodeURIComponent('cozypane://auth/callback');
    const oauthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=read:user`;
    await shell.openExternal(oauthUrl);
  });

  ipcMain.handle('deploy:logout', async () => {
    clearAuth();
    return { success: true };
  });

  ipcMain.handle('deploy:getAuth', async () => {
    const auth = readAuth();
    if (!auth || !decryptToken(auth.encryptedToken)) {
      return { authenticated: false };
    }
    return {
      authenticated: true,
      username: auth.username,
      avatarUrl: auth.avatarUrl,
    };
  });

  ipcMain.handle('deploy:handleCallback', async (_event, code: string) => {
    try {
      // Exchange auth code for JWT
      const result = await fetch(`${API_BASE}/auth/github`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(15000),
      });

      if (!result.ok) {
        throw new Error(`Auth failed: ${result.status}`);
      }

      const data = await result.json() as { token: string; user: { username: string; avatarUrl: string } };

      writeAuth({
        encryptedToken: encryptToken(data.token),
        username: data.user.username,
        avatarUrl: data.user.avatarUrl,
      });

      return { success: true, username: data.user.username, avatarUrl: data.user.avatarUrl };
    } catch (err: any) {
      return { error: err.message || 'Authentication failed' };
    }
  });

  ipcMain.handle('deploy:detectProject', async (_event, cwd: string) => {
    return detectProjectType(cwd);
  });

  ipcMain.handle('deploy:start', async (_event, cwd: string, appName: string, tier?: string) => {
    try {
      const tarPath = await createTarball(cwd);
      const tarBuffer = fs.readFileSync(tarPath);

      // Clean up temp file
      try { fs.unlinkSync(tarPath); } catch {}

      // Upload as multipart
      const blob = new Blob([tarBuffer], { type: 'application/gzip' });
      const formData = new FormData();
      formData.append('file', blob, 'deploy.tar.gz');
      formData.append('appName', appName);
      if (tier) formData.append('tier', tier);

      const project = detectProjectType(cwd);
      formData.append('projectType', project.type);

      const result = await apiFetch('/deploy', {
        method: 'POST',
        body: formData,
      });

      return result;
    } catch (err: any) {
      throw new Error(err.message || 'Deploy failed');
    }
  });

  ipcMain.handle('deploy:list', async () => {
    return apiFetch('/deploy/list');
  });

  ipcMain.handle('deploy:get', async (_event, id: string) => {
    return apiFetch(`/deploy/${id}`);
  });

  ipcMain.handle('deploy:logs', async (_event, id: string) => {
    return apiFetch(`/deploy/${id}/logs`);
  });

  ipcMain.handle('deploy:delete', async (_event, id: string) => {
    return apiFetch(`/deploy/${id}`, { method: 'DELETE' });
  });

  ipcMain.handle('deploy:redeploy', async (_event, id: string) => {
    return apiFetch(`/deploy/${id}/redeploy`, { method: 'POST' });
  });

  // Handle protocol callback URL on macOS (forwarded from main.ts open-url)
  ipcMain.on('deploy:processProtocolUrl', async (_event, url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'auth' && parsed.pathname.startsWith('/callback')) {
        const code = parsed.searchParams.get('code');
        if (code) {
          const result = await fetch(`${API_BASE}/auth/github`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
            signal: AbortSignal.timeout(15000),
          });

          if (result.ok) {
            const data = await result.json() as { token: string; user: { username: string; avatarUrl: string } };
            writeAuth({
              encryptedToken: encryptToken(data.token),
              username: data.user.username,
              avatarUrl: data.user.avatarUrl,
            });
            // Notify renderer that auth succeeded
            getWindow()?.webContents.send('deploy:auth-success', {
              username: data.user.username,
              avatarUrl: data.user.avatarUrl,
            });
          }
        }
      }
    } catch (err) {
      console.error('[CozyPane] Protocol callback error:', err);
    }
  });
}
