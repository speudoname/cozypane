// Shared deploy utilities — no Electron imports (used by both deploy.ts and mcp-server.ts)

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Must match the server's APP_NAME_REGEX in routes/deploy.ts.
// Client-side validation for fast feedback; the server re-validates.
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

  // Hard-coded excludes that should always be skipped
  const alwaysExclude = [
    '.git', 'node_modules', '.env', '.env.local', '.env.production',
    '__pycache__', '.venv', 'venv', '.DS_Store',
    '.next', 'out', 'dist', 'build',
    '.turbo', '.cache', 'coverage',
  ];

  const excludeArgs = alwaysExclude.map(p => `--exclude=./${p}`);

  // Also parse .dockerignore and .gitignore, normalizing leading-slash patterns
  // (tar --exclude-from doesn't understand git's leading-slash anchoring)
  for (const ignoreFile of ['.dockerignore', '.gitignore']) {
    const ignorePath = path.join(cwd, ignoreFile);
    if (fs.existsSync(ignorePath)) {
      const lines = fs.readFileSync(ignorePath, 'utf-8').split('\n');
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        // Normalize: strip leading slash so tar understands it
        const pattern = line.replace(/^\//, '');
        if (pattern && !alwaysExclude.includes(pattern.replace(/\/$/, ''))) {
          excludeArgs.push(`--exclude=./${pattern}`);
        }
      }
    }
  }

  await execFileAsync('tar', ['czf', tarPath, ...excludeArgs, '-C', cwd, '.'], { timeout: 120000 });
  return tarPath;
}
