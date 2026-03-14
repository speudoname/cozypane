import { ipcMain } from 'electron';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { callLlm } from './settings';

const COMMON_DEV_PORTS = [3000, 3001, 5173, 5174, 4200, 8000, 8080, 8888, 4000, 3333, 1234, 9000];

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
 * Detect project type and suggest dev command.
 */
function detectProjectInfo(cwd: string): { type: string | null; devCommand: string | null; productionUrl: string | null } {
  let type: string | null = null;
  let devCommand: string | null = null;
  let productionUrl: string | null = null;

  // Check package.json for scripts and homepage
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
  // Static
  else if (fs.existsSync(path.join(cwd, 'index.html'))) {
    type = 'static'; devCommand = 'npx serve .';
  }

  return { type, devCommand, productionUrl };
}

/**
 * Use AI to analyze the project and suggest how to run/preview it.
 */
async function aiAnalyzeProject(cwd: string): Promise<{ devCommand?: string; productionUrl?: string; summary?: string; error?: string }> {
  // Gather context files
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
      // Extract JSON from response
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

export function registerPreviewHandlers() {
  ipcMain.handle('preview:scanPorts', async () => {
    const ports = await scanDevPorts();
    return { ports };
  });

  ipcMain.handle('preview:detectProject', async (_event, cwd: string) => {
    const info = detectProjectInfo(cwd);
    return info;
  });

  ipcMain.handle('preview:aiAnalyze', async (_event, cwd: string) => {
    return await aiAnalyzeProject(cwd);
  });
}
