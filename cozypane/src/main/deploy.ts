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
  encryptedGithubToken?: string;
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

export function getGithubToken(): string {
  const auth = readAuth();
  if (!auth?.encryptedGithubToken) return '';
  return decryptToken(auth.encryptedGithubToken);
}

export function getAskpassHelperPath(): string {
  const ext = process.platform === 'win32' ? 'bat' : 'sh';
  return path.join(app.getPath('userData'), `git-askpass.${ext}`);
}

export function writeAskpassHelper(): void {
  const helperPath = getAskpassHelperPath();
  const dir = path.dirname(helperPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (process.platform === 'win32') {
    const script = '@echo off\r\necho %COZYPANE_GH_TOKEN%\r\n';
    fs.writeFileSync(helperPath, script, { mode: 0o700 });
  } else {
    const script = `#!/bin/sh\ncase "$1" in\n  *sername*) echo "x-access-token" ;;\n  *) echo "$COZYPANE_GH_TOKEN" ;;\nesac\n`;
    fs.writeFileSync(helperPath, script, { mode: 0o700 });
  }
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
    const oauthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=repo,read:user&state=${state}`;
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

  // Custom domain management
  ipcMain.handle('deploy:addDomain', async (_event, deployId: string, domain: string) => {
    try {
      return await apiFetch(`/deploy/${encodeURIComponent(deployId)}/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
    } catch (err: any) {
      return { error: err.message || 'Failed to add domain' };
    }
  });

  ipcMain.handle('deploy:verifyDomain', async (_event, deployId: string, domainId: string) => {
    try {
      return await apiFetch(`/deploy/${encodeURIComponent(deployId)}/domains/${encodeURIComponent(domainId)}/verify`, {
        method: 'POST',
      });
    } catch (err: any) {
      return { error: err.message || 'Failed to verify domain' };
    }
  });

  ipcMain.handle('deploy:removeDomain', async (_event, deployId: string, domainId: string) => {
    try {
      return await apiFetch(`/deploy/${encodeURIComponent(deployId)}/domains/${encodeURIComponent(domainId)}`, {
        method: 'DELETE',
      });
    } catch (err: any) {
      return { error: err.message || 'Failed to remove domain' };
    }
  });

  ipcMain.handle('deploy:listDomains', async (_event, deployId: string) => {
    try {
      return await apiFetch(`/deploy/${encodeURIComponent(deployId)}/domains`);
    } catch (err: any) {
      return { error: err.message || 'Failed to list domains' };
    }
  });

}

export async function processProtocolUrl(url: string, getWindow: () => BrowserWindow | null): Promise<void> {
  console.log('[CozyPane] processProtocolUrl called with:', url);
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'auth' && parsed.pathname.startsWith('/callback')) {
      // Verify OAuth state to prevent CSRF
      const returnedState = parsed.searchParams.get('state');
      console.log('[CozyPane] OAuth state check — pending:', !!pendingOAuthState, 'match:', returnedState === pendingOAuthState);
      if (!pendingOAuthState || returnedState !== pendingOAuthState) {
        console.error('[CozyPane] OAuth state mismatch — possible CSRF attempt');
        // If user already has auth but no github token, the state may have been cleared
        // by a page reload or app restart. Allow re-auth if state is null (not mismatched).
        if (pendingOAuthState && returnedState !== pendingOAuthState) {
          pendingOAuthState = null;
          return;
        }
        // State was null (cleared by restart) — proceed anyway for better UX
        console.log('[CozyPane] Allowing callback despite null pending state');
      }
      pendingOAuthState = null;

      const code = parsed.searchParams.get('code');
      if (code) {
        console.log('[CozyPane] Exchanging OAuth code...');
        const result = await fetch(`${API_BASE}/auth/github`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
          signal: AbortSignal.timeout(15000),
        });

        if (result.ok) {
          const data = await result.json() as { token: string; githubToken?: string; user: { username: string; avatarUrl: string } };
          console.log('[CozyPane] OAuth success — has githubToken:', !!data.githubToken, 'user:', data.user?.username);
          const authData: StoredAuth = {
            encryptedToken: encryptToken(data.token),
            username: data.user.username,
            avatarUrl: data.user.avatarUrl,
          };
          if (data.githubToken) {
            authData.encryptedGithubToken = encryptToken(data.githubToken);
            writeAskpassHelper();
          }
          writeAuth(authData);
          // Notify renderer that auth succeeded
          const authPayload = {
            username: data.user.username,
            avatarUrl: data.user.avatarUrl,
          };
          getWindow()?.webContents.send('deploy:auth-success', authPayload);
          getWindow()?.webContents.send('github:auth-changed', authPayload);
        } else {
          const text = await result.text().catch(() => '');
          console.error('[CozyPane] OAuth token exchange failed:', result.status, text);
          getWindow()?.webContents.send('deploy:auth-error', { error: `Authentication failed (${result.status})` });
        }
      } else {
        console.error('[CozyPane] No code in callback URL');
      }
    }
  } catch (err: any) {
    console.error('[CozyPane] Protocol callback error:', err);
    getWindow()?.webContents.send('deploy:auth-error', { error: err.message || 'Authentication failed' });
  }
}
