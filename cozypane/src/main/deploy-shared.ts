// Shared deploy utilities — no Electron imports (used by both deploy.ts and mcp-server.ts)

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const APP_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export async function apiFetch(
  apiBase: string,
  endpoint: string,
  tokenGetter: () => string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<any> {
  const token = tokenGetter();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  // Only set Content-Type for requests that actually have a body
  // (Fastify rejects empty bodies when Content-Type is application/json)
  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const timeout = options.timeoutMs || 60000;
  const response = await fetch(`${apiBase}${endpoint}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(timeout),
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

export async function createTarball(cwd: string, tmpDir: string): Promise<string> {
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

  const gitignorePath = path.join(cwd, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    excludeArgs.push(`--exclude-from=${gitignorePath}`);
  }

  await execFileAsync('tar', ['czf', tarPath, ...excludeArgs, '-C', cwd, '.'], { timeout: 120000 });
  return tarPath;
}
