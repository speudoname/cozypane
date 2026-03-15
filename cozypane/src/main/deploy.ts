import { ipcMain, app, shell, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { encryptString, decryptString } from './crypto';
import { apiFetch as sharedApiFetch, createTarball as sharedCreateTarball, APP_NAME_REGEX } from './deploy-shared';

let pendingOAuthState: string | null = null;

export const API_BASE = process.env.COZYPANE_API_URL || 'https://api.cozypane.com';

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
  fs.writeFileSync(getAuthPath(), JSON.stringify(auth, null, 2), { mode: 0o600 });
}

function clearAuth() {
  try {
    fs.unlinkSync(getAuthPath());
  } catch {}
}

// Use shared encrypt/decrypt from crypto.ts
const encryptToken = encryptString;
const decryptToken = decryptString;

export function getToken(): string {
  const auth = readAuth();
  if (!auth) return '';
  return decryptToken(auth.encryptedToken);
}

function apiFetch(endpoint: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<any> {
  return sharedApiFetch(API_BASE, endpoint, getToken, options);
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

function createTarball(cwd: string): Promise<string> {
  const tmpDir = path.join(app.getPath('temp'), 'cozypane-deploy');
  return sharedCreateTarball(cwd, tmpDir);
}

export function registerDeployHandlers(getWindow: () => BrowserWindow | null) {
  ipcMain.handle('deploy:login', async () => {
    const clientId = 'Ov23liUojbnQSvCY9Eq9';
    const redirectUri = encodeURIComponent('cozypane://auth/callback');
    const state = crypto.randomUUID();
    pendingOAuthState = state;
    const oauthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=read:user&state=${state}`;
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

  ipcMain.handle('deploy:detectProject', async (_event, cwd: string) => {
    return detectProjectType(cwd);
  });

  ipcMain.handle('deploy:start', async (_event, cwd: string, appName: string, tier?: string) => {
    if (!APP_NAME_REGEX.test(appName)) {
      return { error: `Invalid app name "${appName}". Must be 2-64 chars, lowercase alphanumeric and hyphens, start/end with letter or number.` };
    }
    try {
      const tarPath = await createTarball(cwd);
      const tarBuffer = await fs.promises.readFile(tarPath);

      // Clean up temp file
      try { fs.unlinkSync(tarPath); } catch {}

      // Upload as multipart — text fields MUST come before the file field.
      // Fastify's multipart parser only exposes fields that appear before the file stream.
      const blob = new Blob([tarBuffer], { type: 'application/gzip' });
      const project = detectProjectType(cwd);
      const formData = new FormData();
      formData.append('appName', appName);
      if (tier) formData.append('tier', tier);
      formData.append('projectType', project.type);
      formData.append('file', blob, 'deploy.tar.gz');

      const result = await apiFetch('/deploy', {
        method: 'POST',
        body: formData,
        timeoutMs: 300000, // 5 minutes — Docker builds can be slow
      });

      return result;
    } catch (err: any) {
      return { error: err.message || 'Deploy failed' };
    }
  });

  ipcMain.handle('deploy:list', async () => {
    try {
      return await apiFetch('/deploy/list');
    } catch (err: any) {
      return { error: err.message || 'Failed to list deployments' };
    }
  });

  ipcMain.handle('deploy:get', async (_event, id: string) => {
    try {
      return await apiFetch(`/deploy/${encodeURIComponent(id)}`);
    } catch (err: any) {
      return { error: err.message || 'Failed to get deployment' };
    }
  });

  ipcMain.handle('deploy:logs', async (_event, id: string) => {
    try {
      return await apiFetch(`/deploy/${encodeURIComponent(id)}/logs`);
    } catch (err: any) {
      return { error: err.message || 'Failed to get logs' };
    }
  });

  ipcMain.handle('deploy:delete', async (_event, id: string) => {
    try {
      return await apiFetch(`/deploy/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (err: any) {
      return { error: err.message || 'Failed to delete deployment' };
    }
  });

  ipcMain.handle('deploy:redeploy', async (_event, id: string) => {
    try {
      return await apiFetch(`/deploy/${encodeURIComponent(id)}/redeploy`, { method: 'POST' });
    } catch (err: any) {
      return { error: err.message || 'Failed to redeploy' };
    }
  });

}

export async function processProtocolUrl(url: string, getWindow: () => BrowserWindow | null): Promise<void> {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'auth' && parsed.pathname.startsWith('/callback')) {
      // Verify OAuth state to prevent CSRF
      const returnedState = parsed.searchParams.get('state');
      if (!pendingOAuthState || returnedState !== pendingOAuthState) {
        console.error('[CozyPane] OAuth state mismatch — possible CSRF attempt');
        pendingOAuthState = null;
        return;
      }
      pendingOAuthState = null;

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
        } else {
          const text = await result.text().catch(() => '');
          console.error('[CozyPane] OAuth token exchange failed:', result.status, text);
          getWindow()?.webContents.send('deploy:auth-error', { error: `Authentication failed (${result.status})` });
        }
      }
    }
  } catch (err: any) {
    console.error('[CozyPane] Protocol callback error:', err);
    getWindow()?.webContents.send('deploy:auth-error', { error: err.message || 'Authentication failed' });
  }
}
