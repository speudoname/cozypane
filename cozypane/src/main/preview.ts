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

// --- Project detection (for static HTML serving) ---

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

      if (deps['next']) { type = 'nextjs'; devCommand = scripts.dev ? 'npm run dev' : 'npx next dev'; }
      else if (deps['vite']) { type = 'vite'; devCommand = scripts.dev ? 'npm run dev' : 'npx vite'; }
      else if (deps['react-scripts']) { type = 'cra'; devCommand = 'npm start'; }
      else if (deps['@angular/core']) { type = 'angular'; devCommand = 'ng serve'; }
      else if (deps['vue']) { type = 'vue'; devCommand = scripts.dev ? 'npm run dev' : 'npx vite'; }
      else if (deps['svelte'] || deps['@sveltejs/kit']) { type = 'svelte'; devCommand = scripts.dev ? 'npm run dev' : 'npx vite'; }
      else if (deps['nuxt'] || deps['nuxt3']) { type = 'nuxt'; devCommand = scripts.dev ? 'npm run dev' : 'npx nuxi dev'; }
      else if (scripts.dev) { type = 'node'; devCommand = 'npm run dev'; }
      else if (scripts.start) { type = 'node'; devCommand = 'npm start'; }

      const DB_DEPS = ['pg', 'mysql2', 'prisma', '@prisma/client', 'mongoose', 'sequelize', 'typeorm', 'knex', 'drizzle-orm', 'better-sqlite3'];
      needsDatabase = DB_DEPS.some(d => d in deps);
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

  ipcMain.handle('preview:writeDevToolsData', async (_event, data: object) => {
    const filePath = path.join(app.getPath('userData'), 'preview-devtools.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  });

  ipcMain.handle('preview:captureScreenshot', async (_event, base64Png: string) => {
    const filePath = path.join(app.getPath('userData'), 'preview-screenshot.png');
    fs.writeFileSync(filePath, Buffer.from(base64Png, 'base64'));
    return filePath;
  });

  // Cleanup on quit
  app.on('will-quit', () => {
    stopAllStaticServers();
  });
}
