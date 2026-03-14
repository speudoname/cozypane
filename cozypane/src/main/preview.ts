import { ipcMain, app } from 'electron';
import net from 'net';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { callLlm } from './settings';

const COMMON_DEV_PORTS = [3000, 3001, 5173, 5174, 4200, 8000, 8080, 8888, 4000, 3333, 1234, 9000];

// --- Static file server ---

const staticServers = new Map<string, { server: http.Server; port: number }>();

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.webp': 'image/webp', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.txt': 'text/plain', '.xml': 'application/xml',
  '.mjs': 'application/javascript', '.map': 'application/json',
};

function findFreePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(start, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      // Port in use, try next
      if (start < 9200) resolve(findFreePort(start + 1));
      else reject(new Error('No free port found'));
    });
  });
}

function startStaticServer(cwd: string): Promise<{ port: number }> {
  // Already running for this cwd
  const existing = staticServers.get(cwd);
  if (existing) return Promise.resolve({ port: existing.port });

  return new Promise(async (resolve, reject) => {
    try {
      const port = await findFreePort(9100);
      const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${port}`);
        let filePath = path.join(cwd, decodeURIComponent(url.pathname));

        // Path traversal protection
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(path.resolve(cwd))) {
          res.writeHead(403); res.end('Forbidden'); return;
        }

        // Directory → index.html
        try {
          if (fs.statSync(filePath).isDirectory()) {
            filePath = path.join(filePath, 'index.html');
          }
        } catch {}

        fs.readFile(filePath, (err, data) => {
          if (err) {
            // SPA fallback: try root index.html
            const indexPath = path.join(cwd, 'index.html');
            fs.readFile(indexPath, (err2, indexData) => {
              if (err2) { res.writeHead(404); res.end('Not found'); return; }
              res.writeHead(200, {
                'Content-Type': 'text/html',
                'Access-Control-Allow-Origin': '*',
              });
              res.end(indexData);
            });
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(data);
        });
      });

      server.listen(port, '127.0.0.1', () => {
        staticServers.set(cwd, { server, port });
        resolve({ port });
      });
      server.on('error', reject);
    } catch (e) { reject(e); }
  });
}

function stopStaticServer(cwd: string) {
  const entry = staticServers.get(cwd);
  if (entry) {
    entry.server.close();
    staticServers.delete(cwd);
  }
}

function stopAllStaticServers() {
  for (const [cwd] of staticServers) stopStaticServer(cwd);
}

// --- URL persistence ---

function getPreviewUrlsPath(): string {
  return path.join(app.getPath('userData'), 'preview-urls.json');
}

function loadPreviewUrls(): Record<string, { productionUrl?: string; lastDevCommand?: string }> {
  try {
    return JSON.parse(fs.readFileSync(getPreviewUrlsPath(), 'utf-8'));
  } catch { return {}; }
}

function savePreviewUrls(data: Record<string, any>) {
  fs.writeFileSync(getPreviewUrlsPath(), JSON.stringify(data, null, 2));
}

// --- CWD-aware port scanning ---

let cwdPortCache: { timestamp: number; cwd: string; ports: number[] } | null = null;

function scanPortsForCwd(cwd: string): Promise<number[]> {
  // Return cache if fresh (2s)
  if (cwdPortCache && cwdPortCache.cwd === cwd && Date.now() - cwdPortCache.timestamp < 2000) {
    return Promise.resolve(cwdPortCache.ports);
  }

  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', ['-iTCP', '-sTCP:LISTEN', '-n', '-P', '-F', 'pn'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        // Fallback to old global scan
        scanDevPorts().then(resolve);
        return;
      }

      // Parse lsof -F output: p<pid>\nn<name> pairs
      const entries: { pid: string; port: number }[] = [];
      let currentPid = '';
      for (const line of stdout.split('\n')) {
        if (line.startsWith('p')) currentPid = line.slice(1);
        else if (line.startsWith('n') && currentPid) {
          const match = line.match(/:(\d+)$/);
          if (match) entries.push({ pid: currentPid, port: parseInt(match[1]) });
        }
      }

      if (entries.length === 0) {
        cwdPortCache = { timestamp: Date.now(), cwd, ports: [] };
        resolve([]);
        return;
      }

      // Check each PID's cwd to see if it's inside our target cwd
      const uniquePids = [...new Set(entries.map(e => e.pid))];
      const pidCwdChecks = uniquePids.map(pid => new Promise<{ pid: string; match: boolean }>((res) => {
        execFile('/usr/sbin/lsof', ['-p', pid, '-Fn', '-a', '-d', 'cwd'], { timeout: 3000 }, (err, out) => {
          if (err) { res({ pid, match: false }); return; }
          // Look for n<path> line
          for (const line of out.split('\n')) {
            if (line.startsWith('n')) {
              const procCwd = line.slice(1);
              res({ pid, match: procCwd.startsWith(path.resolve(cwd)) });
              return;
            }
          }
          res({ pid, match: false });
        });
      }));

      Promise.all(pidCwdChecks).then(results => {
        const matchingPids = new Set(results.filter(r => r.match).map(r => r.pid));
        let ports: number[];

        if (matchingPids.size > 0) {
          ports = [...new Set(entries.filter(e => matchingPids.has(e.pid)).map(e => e.port))];
        } else {
          // No cwd matches — fall back to checking common dev ports that are open
          ports = [...new Set(entries.map(e => e.port))].filter(p => COMMON_DEV_PORTS.includes(p));
        }

        cwdPortCache = { timestamp: Date.now(), cwd, ports };
        resolve(ports);
      });
    });
  });
}

// --- Database dependency detection ---

const DB_DEPS = ['pg', 'mysql2', 'prisma', '@prisma/client', 'mongoose', 'sequelize', 'typeorm', 'knex', 'drizzle-orm', 'better-sqlite3'];

function checkDatabaseDeps(cwd: string): boolean {
  const pkgPath = path.join(cwd, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    return DB_DEPS.some(d => d in allDeps);
  } catch { return false; }
}

// --- Monorepo detection ---

const FRONTEND_SUBDIRS = ['frontend', 'client', 'web', 'app', 'packages/web', 'packages/frontend', 'packages/client'];
const FRONTEND_TYPES = new Set(['nextjs', 'vite', 'cra', 'angular', 'vue', 'svelte', 'nuxt', 'static']);

interface SubProject {
  path: string;
  name: string;
  type: string;
  devCommand: string | null;
}

function detectSubProjects(cwd: string): SubProject[] {
  const subs: SubProject[] = [];
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);

    // Check known frontend subdirs + any top-level dirs with package.json
    const candidates = [...new Set([
      ...FRONTEND_SUBDIRS.filter(d => dirs.includes(d.split('/')[0])),
      ...dirs,
    ])];

    for (const dir of candidates) {
      const subPath = path.join(cwd, dir);
      if (!fs.existsSync(subPath)) continue;
      const info = detectProjectInfoBase(subPath);
      if (info.type) {
        subs.push({ path: subPath, name: dir, type: info.type, devCommand: info.devCommand });
      }
    }
  } catch {}

  // Sort: frontend frameworks first
  subs.sort((a, b) => {
    const aFront = FRONTEND_TYPES.has(a.type) ? 0 : 1;
    const bFront = FRONTEND_TYPES.has(b.type) ? 0 : 1;
    return aFront - bFront;
  });

  return subs;
}

/**
 * Check if a port is listening on localhost.
 */
function checkPort(port: number, timeout = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Scan common dev ports and return which ones are listening.
 */
async function scanDevPorts(): Promise<number[]> {
  const results = await Promise.all(
    COMMON_DEV_PORTS.map(async (port) => ({ port, open: await checkPort(port) }))
  );
  return results.filter(r => r.open).map(r => r.port);
}

/**
 * Core project detection (no sub-project scanning to avoid recursion).
 */
function detectProjectInfoBase(cwd: string): { type: string | null; devCommand: string | null; productionUrl: string | null; serveStatic: boolean; needsDatabase: boolean } {
  let type: string | null = null;
  let devCommand: string | null = null;
  let productionUrl: string | null = null;
  let serveStatic = false;
  let needsDatabase = false;

  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const scripts = pkg.scripts || {};
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps['next']) { type = 'nextjs'; devCommand = scripts.dev ? 'npm run dev' : 'npx next dev'; }
      else if (deps['vite']) { type = 'vite'; devCommand = scripts.dev ? 'npm run dev' : 'npx vite'; }
      else if (deps['react-scripts']) { type = 'cra'; devCommand = 'npm start'; }
      else if (deps['@angular/core']) { type = 'angular'; devCommand = 'ng serve'; }
      else if (deps['vue']) { type = 'vue'; devCommand = scripts.dev ? 'npm run dev' : 'npx vite'; }
      else if (deps['svelte'] || deps['@sveltejs/kit']) { type = 'svelte'; devCommand = scripts.dev ? 'npm run dev' : 'npx vite'; }
      else if (deps['nuxt'] || deps['nuxt3']) { type = 'nuxt'; devCommand = scripts.dev ? 'npm run dev' : 'npx nuxi dev'; }
      else if (scripts.dev) { type = 'node'; devCommand = 'npm run dev'; }
      else if (scripts.start) { type = 'node'; devCommand = 'npm start'; }

      needsDatabase = DB_DEPS.some(d => d in deps);
      if (pkg.homepage) productionUrl = pkg.homepage;
    } catch {}
  }
  // Python
  else if (fs.existsSync(path.join(cwd, 'manage.py'))) {
    type = 'django'; devCommand = 'python manage.py runserver';
  } else if (fs.existsSync(path.join(cwd, 'app.py')) || fs.existsSync(path.join(cwd, 'wsgi.py'))) {
    type = 'flask'; devCommand = 'flask run';
  }
  // Go
  else if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    type = 'go'; devCommand = 'go run .';
  }
  // Ruby
  else if (fs.existsSync(path.join(cwd, 'Gemfile'))) {
    type = 'rails'; devCommand = 'rails server';
  }
  // Static HTML
  else if (fs.existsSync(path.join(cwd, 'index.html'))) {
    type = 'static'; devCommand = null; serveStatic = true;
  }

  return { type, devCommand, productionUrl, serveStatic, needsDatabase };
}

/**
 * Full project detection with sub-project scanning.
 */
function detectProjectInfo(cwd: string) {
  const base = detectProjectInfoBase(cwd);
  let subProjects: SubProject[] = [];

  // If no web framework detected at root, scan subdirs
  if (!base.type || (!base.devCommand && !base.serveStatic)) {
    subProjects = detectSubProjects(cwd);
  }

  return { ...base, subProjects };
}

/**
 * Use AI to analyze the project and suggest how to run/preview it.
 */
async function aiAnalyzeProject(cwd: string): Promise<{ devCommand?: string; productionUrl?: string; summary?: string; error?: string }> {
  const files: string[] = [];
  try {
    const entries = fs.readdirSync(cwd).slice(0, 30);
    files.push(...entries);
  } catch {}

  let pkgContent = '';
  try { pkgContent = fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8').slice(0, 2000); } catch {}

  let readmeContent = '';
  for (const f of ['README.md', 'readme.md', 'README']) {
    try { readmeContent = fs.readFileSync(path.join(cwd, f), 'utf-8').slice(0, 1500); break; } catch {}
  }

  const prompt = `You are analyzing a software project to help with live preview.

Project directory files: ${files.join(', ')}

${pkgContent ? `package.json:\n${pkgContent}\n` : ''}
${readmeContent ? `README:\n${readmeContent}\n` : ''}

Respond ONLY with valid JSON (no markdown):
{
  "devCommand": "the command to start the dev server (e.g. npm run dev)",
  "productionUrl": "the production URL if detectable from package.json homepage or readme, or null",
  "summary": "one sentence describing what this project is"
}`;

  try {
    const result = await callLlm(prompt, 300);
    if (result.error) return { error: result.error };
    if (result.text) {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          devCommand: parsed.devCommand || undefined,
          productionUrl: parsed.productionUrl || undefined,
          summary: parsed.summary || undefined,
        };
      }
    }
    return { error: 'Could not parse AI response' };
  } catch (err: any) {
    return { error: err.message || 'AI analysis failed' };
  }
}

/**
 * Probe multiple ports and prefer the one serving HTML (frontend) over JSON (API).
 */
async function selectBestPort(ports: number[]): Promise<number> {
  if (ports.length === 0) return 0;

  // Always validate — even a single port might be an API server serving JSON
  const results = await Promise.all(ports.map(port =>
    new Promise<{ port: number; isHtml: boolean }>(resolve => {
      const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 2000 }, res => {
        const ct = res.headers['content-type'] || '';
        res.destroy();
        resolve({ port, isHtml: ct.includes('text/html') });
      });
      req.on('error', () => resolve({ port, isHtml: false }));
      req.on('timeout', () => { req.destroy(); resolve({ port, isHtml: false }); });
    })
  ));

  const htmlPorts = results.filter(r => r.isHtml);
  if (htmlPorts.length > 0) return htmlPorts[0].port;
  return 0; // No HTML-serving (frontend) port found — don't auto-load API ports
}

export function registerPreviewHandlers() {
  ipcMain.handle('preview:scanPorts', async () => {
    const ports = await scanDevPorts();
    return { ports };
  });

  ipcMain.handle('preview:detectProject', async (_event, cwd: string) => {
    return detectProjectInfo(cwd);
  });

  ipcMain.handle('preview:aiAnalyze', async (_event, cwd: string) => {
    return await aiAnalyzeProject(cwd);
  });

  // Static file server
  ipcMain.handle('preview:serveStatic', async (_event, cwd: string) => {
    return await startStaticServer(cwd);
  });

  ipcMain.handle('preview:stopStatic', async (_event, cwd: string) => {
    stopStaticServer(cwd);
  });

  // CWD-aware port scanning
  ipcMain.handle('preview:scanPortsForCwd', async (_event, cwd: string) => {
    const ports = await scanPortsForCwd(cwd);
    return { ports };
  });

  // Smart port selection (prefer HTML-serving ports)
  ipcMain.handle('preview:selectBestPort', async (_event, ports: number[]) => {
    return await selectBestPort(ports);
  });

  // URL persistence
  ipcMain.handle('preview:getStoredUrl', async (_event, cwd: string) => {
    const all = loadPreviewUrls();
    return all[cwd] || null;
  });

  ipcMain.handle('preview:storeUrl', async (_event, cwd: string, data: { productionUrl?: string; lastDevCommand?: string }) => {
    const all = loadPreviewUrls();
    all[cwd] = { ...all[cwd], ...data };
    savePreviewUrls(all);
  });

  // Cleanup on quit
  app.on('will-quit', () => {
    stopAllStaticServers();
  });
}
