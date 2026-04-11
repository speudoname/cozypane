import { ipcMain, app, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { encryptString, decryptString } from './crypto';
import { apiFetch as sharedApiFetch } from './deploy-shared';
import { broadcastAll } from './windows';
// NOTE: Direct upload deploy path (deploy:start / deploy:detectProject /
// deploy:get IPC handlers and createTarball/detectProjectType helpers) was
// removed — the UI deploys exclusively via the MCP tool `cozypane_deploy`
// (see DeployPanel.tsx → sendTerminalCommand('cozydeploy …')). The MCP
// server (src/main/mcp-server.ts) owns the tarball + upload path.

const pendingOAuthStates = new Map<string, number>(); // state → expiry timestamp (ms)

function sweepExpiredOAuthStates(): void {
  const now = Date.now();
  for (const [state, expiry] of pendingOAuthStates) {
    if (expiry < now) pendingOAuthStates.delete(state);
  }
}

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

export function getToken(): string {
  const auth = readAuth();
  if (!auth) return '';
  return decryptString(auth.encryptedToken);
}

export function getGithubToken(): string {
  const auth = readAuth();
  if (!auth?.encryptedGithubToken) return '';
  return decryptString(auth.encryptedGithubToken);
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

export function registerDeployHandlers() {
  ipcMain.handle('deploy:login', async () => {
    const clientId = 'Ov23liUojbnQSvCY9Eq9';
    const redirectUri = encodeURIComponent('cozypane://auth/callback');
    const state = crypto.randomUUID();
    sweepExpiredOAuthStates();
    pendingOAuthStates.set(state, Date.now() + 5 * 60 * 1000); // 5-min expiry
    const oauthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=repo,read:user&state=${state}`;
    await shell.openExternal(oauthUrl);
  });

  ipcMain.handle('deploy:logout', async () => {
    clearAuth();
    return { success: true };
  });

  ipcMain.handle('deploy:getAuth', async () => {
    const auth = readAuth();
    if (!auth || !decryptString(auth.encryptedToken)) {
      return { authenticated: false };
    }
    return {
      authenticated: true,
      username: auth.username,
      avatarUrl: auth.avatarUrl,
    };
  });

  ipcMain.handle('deploy:list', async () => {
    try {
      return await apiFetch('/deploy/list');
    } catch (err: any) {
      return { error: err.message || 'Failed to list deployments' };
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

export async function processProtocolUrl(url: string): Promise<void> {
  console.log('[CozyPane] processProtocolUrl called with:', url);
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'auth' && parsed.pathname.startsWith('/callback')) {
      // Verify OAuth state to prevent CSRF
      const returnedState = parsed.searchParams.get('state');
      const expiry = returnedState ? pendingOAuthStates.get(returnedState) : undefined;
      const isValid = expiry !== undefined && Date.now() < expiry;
      console.log('[CozyPane] OAuth state check — known:', isValid, 'returned:', !!returnedState);
      if (!isValid) {
        console.error('[CozyPane] OAuth state mismatch or expired — rejecting callback');
        if (returnedState) pendingOAuthStates.delete(returnedState);
        return;
      }
      pendingOAuthStates.delete(returnedState!);

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
          // H10: the server no longer returns the GitHub token in the body.
          // It is stored encrypted server-side and fetched on demand via
          // GET /auth/github-token (which requires the cozypane JWT).
          const data = await result.json() as { token: string; user: { username: string; avatarUrl: string } };
          console.log('[CozyPane] OAuth success — user:', data.user?.username);
          try {
            const authData: StoredAuth = {
              encryptedToken: encryptString(data.token),
              username: data.user.username,
              avatarUrl: data.user.avatarUrl,
            };
            writeAuth(authData);
          } catch (err: any) {
            // M8: no keyring available and fallback disabled. Surface a
            // clear error to the UI rather than silently base64-persisting.
            console.error('[CozyPane] Credential store refused:', err.message);
            broadcastAll('deploy:auth-error', {
              error: err.message || 'Credential store unavailable. Install a keyring or set COZYPANE_ALLOW_UNENCRYPTED_CREDENTIALS=1.',
            });
            return;
          }

          // Fetch the GitHub token via the new authenticated endpoint and
          // cache it locally (safeStorage-encrypted, same as the cozypane JWT).
          try {
            const ghResult = await fetch(`${API_BASE}/auth/github-token`, {
              headers: { Authorization: `Bearer ${data.token}` },
              signal: AbortSignal.timeout(15000),
            });
            if (ghResult.ok) {
              const ghData = await ghResult.json() as { token: string };
              if (ghData.token) {
                const stored = readAuth();
                if (stored) {
                  try {
                    stored.encryptedGithubToken = encryptString(ghData.token);
                    writeAuth(stored);
                    writeAskpassHelper();
                  } catch (err: any) {
                    // GitHub token fallback refuses — non-fatal for the
                    // session since the cozypane JWT already went through.
                    console.warn('[CozyPane] GitHub token not persisted:', err.message);
                  }
                }
              }
            } else {
              console.warn('[CozyPane] Could not fetch GitHub token:', ghResult.status);
            }
          } catch (err: any) {
            console.warn('[CozyPane] Fetching GitHub token failed:', err?.message || err);
          }

          // Notify renderer that auth succeeded
          const authPayload = {
            username: data.user.username,
            avatarUrl: data.user.avatarUrl,
          };
          broadcastAll('deploy:auth-success', authPayload);
          broadcastAll('github:auth-changed', authPayload);
        } else {
          const text = await result.text().catch(() => '');
          console.error('[CozyPane] OAuth token exchange failed:', result.status, text);
          broadcastAll('deploy:auth-error', { error: `Authentication failed (${result.status})` });
        }
      } else {
        console.error('[CozyPane] No code in callback URL');
      }
    }
  } catch (err: any) {
    console.error('[CozyPane] Protocol callback error:', err);
    broadcastAll('deploy:auth-error', { error: err.message || 'Authentication failed' });
  }
}
