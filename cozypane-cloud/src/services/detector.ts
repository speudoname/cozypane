import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ProjectInfo {
  type: 'docker' | 'node' | 'python' | 'go' | 'static';
  port: number;
  warnings: string[];
}

/** Common subdirectory names for backend/frontend in monorepos */
const BACKEND_DIRS = ['backend', 'server', 'api'];
const FRONTEND_DIRS = ['frontend', 'client', 'web', 'app'];

function hasSubDir(dir: string, name: string): boolean {
  return existsSync(join(dir, name)) && readdirSync(join(dir, name), { withFileTypes: true }).length > 0;
}

export function detectProject(dir: string): ProjectInfo {
  const warnings: string[] = [];

  // 1. Dockerfile — user-defined, highest priority
  if (existsSync(join(dir, 'Dockerfile'))) {
    return { type: 'docker', port: 3000, warnings };
  }

  // Check for monorepo/full-stack patterns before single-project detection
  const hasBackend = BACKEND_DIRS.some(d => hasSubDir(dir, d) && (
    existsSync(join(dir, d, 'package.json')) ||
    existsSync(join(dir, d, 'requirements.txt')) ||
    existsSync(join(dir, d, 'go.mod'))
  ));
  const hasFrontend = FRONTEND_DIRS.some(d => hasSubDir(dir, d) && (
    existsSync(join(dir, d, 'package.json')) ||
    existsSync(join(dir, d, 'index.html'))
  ));

  if (hasBackend && hasFrontend) {
    warnings.push(
      'Full-stack project detected (backend + frontend subdirectories). ' +
      'No Dockerfile found. A multi-stage Dockerfile is required to build and serve ' +
      'both the frontend and backend together. The AI agent should create one before deploying.'
    );
  } else if (hasBackend && !hasFrontend) {
    warnings.push(
      'Backend project detected in a subdirectory but no root Dockerfile found. ' +
      'A Dockerfile is needed to build and serve it correctly.'
    );
  }

  // 2. Node.js
  if (existsSync(join(dir, 'package.json'))) {
    let port = 3000;
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps?.next) port = 3000;
      else if (deps?.nuxt) port = 3000;
      else if (deps?.express) port = 3000;
      else if (deps?.fastify) port = 3000;
      else if (deps?.['@hono/node-server'] || deps?.hono) port = 3000;

      // Warn if no "start" script — npm start will fail
      if (!pkg.scripts?.start && !pkg.scripts?.serve) {
        warnings.push(
          'No "start" script found in package.json. The default Node.js Dockerfile runs "npm start". ' +
          'Add a start script or provide a custom Dockerfile.'
        );
      }
    } catch {
      // ignore parse errors
    }
    return { type: 'node', port, warnings };
  }

  // 3. Python
  if (
    existsSync(join(dir, 'requirements.txt')) ||
    existsSync(join(dir, 'pyproject.toml')) ||
    existsSync(join(dir, 'Pipfile'))
  ) {
    let port = 8000;
    try {
      const reqs = readFileSync(join(dir, 'requirements.txt'), 'utf-8');
      if (reqs.includes('flask')) port = 5000;
    } catch {
      // ignore
    }
    return { type: 'python', port, warnings };
  }

  // 4. Go
  if (existsSync(join(dir, 'go.mod'))) {
    return { type: 'go', port: 8080, warnings };
  }

  // 5. Static site (index.html)
  if (existsSync(join(dir, 'index.html'))) {
    return { type: 'static', port: 8080, warnings };
  }

  // Default — warn if deploying as static with no index.html
  if (hasBackend || hasFrontend) {
    warnings.push(
      'No root-level project files found (no Dockerfile, package.json, etc.). ' +
      'Backend/frontend subdirectories detected — this needs a Dockerfile to deploy correctly. ' +
      'Without one, it will be deployed as a static site which will likely fail.'
    );
  }

  return { type: 'static', port: 8080, warnings };
}
