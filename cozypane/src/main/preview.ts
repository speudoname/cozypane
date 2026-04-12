import { ipcMain, app } from 'electron';
import net from 'net';
import http from 'http';
import fs from 'fs';
import path from 'path';

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
      if (start < 9200) resolve(findFreePort(start + 1));
      else reject(new Error('No free port found'));
    });
  });
}

function startStaticServer(cwd: string): Promise<{ port: number }> {
  const existing = staticServers.get(cwd);
  if (existing) return Promise.resolve({ port: existing.port });

  return new Promise(async (resolve, reject) => {
    try {
      const port = await findFreePort(9100);
      const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${port}`);
        let filePath = path.join(cwd, decodeURIComponent(url.pathname));

        // Path traversal protection — must use path.sep so that a sibling
        // directory like /home/user/project-leak is NOT treated as a child of
        // /home/user/project. Without the trailing separator, startsWith() was
        // permissive and allowed cross-project reads.
        const root = path.resolve(cwd);
        const resolved = path.resolve(filePath);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) {
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
              });
              res.end(indexData);
            });
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          // No Access-Control-Allow-Origin header: the preview server is only
          // reached from the same-origin Electron webview. A wildcard CORS
          // header combined with brute-forceable ports (9100-9200) let any
          // website the user visited read project files cross-origin.
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
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
  try {
    fs.writeFileSync(getPreviewUrlsPath(), JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[CozyPane] Failed to save preview URLs:', err);
  }
}

// --- Project detection (for static HTML serving) ---

// Framework detection data — shared with cozypane-cloud/src/services/detector.ts.
// Source of truth is shared/framework-data.json; this is a copy kept in sync.
import frameworkData from './framework-data.json';

function detectProjectInfo(cwd: string): { type: string | null; devCommand: string | null; productionUrl: string | null; serveStatic: boolean; needsDatabase: boolean } {
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

      // Match framework from shared data — order matters (next before vite)
      for (const [name, info] of Object.entries(frameworkData.frameworks) as [string, any][]) {
        const allDeps = [info.dep, ...(info.altDeps || [])];
        const hasFramework = allDeps.some((d: string) => d in deps);
        if (!hasFramework) continue;
        // Skip vite if backend framework is present
        if (info.excludeIfPresent?.some((d: string) => d in deps)) continue;
        type = name;
        devCommand = info.devCommand
          ? (scripts.dev ? info.devCommand : (info.devFallback || info.devCommand))
          : null;
        break;
      }

      // Fallback for node projects without a known framework
      if (!type) {
        if (scripts.dev) { type = 'node'; devCommand = 'npm run dev'; }
        else if (scripts.start) { type = 'node'; devCommand = 'npm start'; }
      }

      needsDatabase = frameworkData.dbDeps.some(d => d in deps);
      if (pkg.homepage) productionUrl = pkg.homepage;
    } catch {}
  }
  else if (fs.existsSync(path.join(cwd, 'manage.py'))) {
    type = 'django'; devCommand = 'python manage.py runserver';
  } else if (fs.existsSync(path.join(cwd, 'app.py')) || fs.existsSync(path.join(cwd, 'wsgi.py'))) {
    type = 'flask'; devCommand = 'flask run';
  }
  else if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    type = 'go'; devCommand = 'go run .';
  }
  else if (fs.existsSync(path.join(cwd, 'Gemfile'))) {
    type = 'rails'; devCommand = 'rails server';
  }
  // Static HTML — the main case we care about for auto-serving
  else if (fs.existsSync(path.join(cwd, 'index.html'))) {
    type = 'static'; devCommand = null; serveStatic = true;
  }

  return { type, devCommand, productionUrl, serveStatic, needsDatabase };
}

// --- IPC Handlers ---

export function registerPreviewHandlers() {
  ipcMain.handle('preview:detectProject', async (_event, cwd: string) => {
    return detectProjectInfo(cwd);
  });

  ipcMain.handle('preview:serveStatic', async (_event, cwd: string) => {
    try {
      return await startStaticServer(cwd);
    } catch (err: any) {
      return { error: err.message || 'Failed to start static server' };
    }
  });

  ipcMain.handle('preview:stopStatic', async (_event, cwd: string) => {
    stopStaticServer(cwd);
  });

  ipcMain.handle('preview:getStoredUrl', async (_event, cwd: string) => {
    const all = loadPreviewUrls();
    return all[cwd] || null;
  });

  ipcMain.handle('preview:storeUrl', async (_event, cwd: string, data: { productionUrl?: string; lastDevCommand?: string }) => {
    const all = loadPreviewUrls();
    all[cwd] = { ...all[cwd], ...data };
    savePreviewUrls(all);
  });

  ipcMain.handle('preview:writeDevToolsData', async (_event, data: any) => {
    try {
      // M2: the devtools blob flows from the webview (possibly attacker-
      // controlled) → disk → MCP server → Claude's context. Cap individual
      // fields so a hostile page can't fill the disk or stuff a giant
      // prompt-injection payload into Claude's input. 256 KB total is way
      // more than legitimate console+network data ever needs.
      const MAX_FIELD_CHARS = 64 * 1024;
      const MAX_TOTAL_CHARS = 256 * 1024;
      const truncate = (value: any): any => {
        if (typeof value === 'string') {
          return value.length > MAX_FIELD_CHARS
            ? value.slice(0, MAX_FIELD_CHARS) + '\n...[truncated by CozyPane]'
            : value;
        }
        if (Array.isArray(value)) return value.slice(0, 200).map(truncate);
        if (value && typeof value === 'object') {
          const out: Record<string, any> = {};
          for (const [k, v] of Object.entries(value)) out[k] = truncate(v);
          return out;
        }
        return value;
      };
      const capped = truncate(data);
      let serialized = JSON.stringify(capped, null, 2);
      if (serialized.length > MAX_TOTAL_CHARS) {
        serialized = serialized.slice(0, MAX_TOTAL_CHARS) + '\n...[truncated by CozyPane]\n}';
      }
      const filePath = path.join(app.getPath('userData'), 'preview-devtools.json');
      fs.writeFileSync(filePath, serialized, { mode: 0o600 });
    } catch (err: any) {
      return { error: err.message || 'Failed to write devtools data' };
    }
  });

  ipcMain.handle('preview:captureScreenshot', async (_event, base64Png: string) => {
    try {
      // Cap screenshot size at 2 MB (decoded). PNG base64 is ~4/3 the binary
      // size, so a 3 MB base64 string maps to ~2 MB of image — enough for a
      // full-viewport capture at retina density, too small for a hostile
      // page to use as a disk-fill vector.
      const MAX_BASE64_LEN = 3 * 1024 * 1024;
      const safe = typeof base64Png === 'string' && base64Png.length > MAX_BASE64_LEN
        ? base64Png.slice(0, MAX_BASE64_LEN)
        : base64Png;
      const filePath = path.join(app.getPath('userData'), 'preview-screenshot.png');
      fs.writeFileSync(filePath, Buffer.from(safe, 'base64'), { mode: 0o600 });
      return filePath;
    } catch (err: any) {
      return { error: err.message || 'Failed to capture screenshot' };
    }
  });

  ipcMain.handle('preview:suggestPort', async (_event, preferredPort?: number) => {
    // Check a preferred port first, then fall back to common dev ports
    const portsToTry = preferredPort
      ? [preferredPort, 3000, 5173, 8080, 4200, 4321, 5000, 8000]
      : [3000, 5173, 8080, 4200, 4321, 5000, 8000];
    const seen = new Set<number>();
    for (const port of portsToTry) {
      if (seen.has(port)) continue;
      seen.add(port);
      const free = await new Promise<boolean>((resolve) => {
        const s = net.createServer();
        s.listen(port, '127.0.0.1', () => { s.close(() => resolve(true)); });
        s.on('error', () => resolve(false));
      });
      if (free) return { port };
    }
    // All common ports taken — find any free one
    try {
      const port = await findFreePort(3000);
      return { port };
    } catch {
      return { port: 3000 };
    }
  });

  // Cleanup on quit
  app.on('will-quit', () => {
    stopAllStaticServers();
  });
}
