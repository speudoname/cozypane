import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Shared framework detection data — single source of truth for both
// the cloud build detector and the desktop preview panel.
const require = createRequire(import.meta.url);
const frameworkData = require('../../../shared/framework-data.json');

export interface ProjectAnalysis {
  type: 'docker' | 'node' | 'python' | 'go' | 'static';
  framework: string | null;
  port: number;
  needsDatabase: boolean;
  orm: string | null;
  migrationCommand: string | null;
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun' | null;
  buildCommand: string | null;
  startCommand: string | null;
  nodeVersion: string | null;
  hasDockerfile: boolean;
  nextjsNeedsStandalone: boolean;
  recommendedTier: 'small' | 'medium' | 'large';
  isMonorepo: boolean;
  warnings: string[];
}

const BACKEND_DIRS = ['backend', 'server', 'api'];
const FRONTEND_DIRS = ['frontend', 'client', 'web', 'app'];

function hasSubDir(dir: string, name: string): boolean {
  try {
    return existsSync(join(dir, name)) && readdirSync(join(dir, name), { withFileTypes: true }).length > 0;
  } catch {
    return false;
  }
}

function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function detectMonorepo(dir: string): boolean {
  const hasBackend = BACKEND_DIRS.some(d => hasSubDir(dir, d) && (
    existsSync(join(dir, d, 'package.json')) ||
    existsSync(join(dir, d, 'requirements.txt')) ||
    existsSync(join(dir, d, 'go.mod'))
  ));
  const hasFrontend = FRONTEND_DIRS.some(d => hasSubDir(dir, d) && (
    existsSync(join(dir, d, 'package.json')) ||
    existsSync(join(dir, d, 'index.html'))
  ));
  return hasBackend && hasFrontend;
}

function detectNodeVersion(dir: string, pkg: any): string {
  // .nvmrc
  const nvmrc = readFileSafe(join(dir, '.nvmrc'));
  if (nvmrc) {
    const ver = nvmrc.trim().replace(/^v/, '');
    if (/^\d+/.test(ver)) return ver.split('.')[0];
  }

  // .node-version
  const nodeVersion = readFileSafe(join(dir, '.node-version'));
  if (nodeVersion) {
    const ver = nodeVersion.trim().replace(/^v/, '');
    if (/^\d+/.test(ver)) return ver.split('.')[0];
  }

  // engines.node in package.json
  if (pkg?.engines?.node) {
    const match = pkg.engines.node.match(/(\d+)/);
    if (match) return match[1];
  }

  return '20';
}

function detectPackageManager(dir: string): 'npm' | 'yarn' | 'pnpm' | 'bun' {
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function checkNextjsStandalone(dir: string): boolean {
  // Check next.config.{js,mjs,ts}
  const configFiles = ['next.config.js', 'next.config.mjs', 'next.config.ts'];
  for (const configFile of configFiles) {
    const content = readFileSafe(join(dir, configFile));
    if (content) {
      // Check if output: "standalone" is already set
      if (/output\s*:\s*['"`]standalone['"`]/.test(content)) {
        return false; // Already has standalone — no patching needed
      }
      return true; // Has next.config but no standalone
    }
  }
  // No next.config file at all — needs standalone
  return true;
}

function analyzeNodeProject(dir: string, analysis: ProjectAnalysis): void {
  const pkgContent = readFileSafe(join(dir, 'package.json'));
  if (!pkgContent) return;

  let pkg: any;
  try {
    pkg = JSON.parse(pkgContent);
  } catch {
    return;
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  // Detect framework from shared data (shared/framework-data.json).
  // Single source of truth for both cloud detector and desktop preview.
  for (const [name, info] of Object.entries(frameworkData.frameworks) as [string, any][]) {
    const allDeps = [info.dep, ...(info.altDeps || [])];
    const hasFramework = allDeps.some((d: string) => d in deps);
    if (!hasFramework) continue;
    if (info.excludeIfPresent?.some((d: string) => d in deps)) continue;
    analysis.framework = name;
    analysis.port = info.port;
    if (info.tier) analysis.recommendedTier = info.tier;
    // Next.js-specific standalone check
    if (name === 'nextjs') {
      analysis.nextjsNeedsStandalone = checkNextjsStandalone(dir);
    }
    break;
  }

  // Detect ORM / database from shared data
  for (const [ormName, ormInfo] of Object.entries(frameworkData.orms) as [string, any][]) {
    if (ormInfo.deps.some((d: string) => d in deps)) {
      analysis.orm = ormName;
      analysis.needsDatabase = true;
      analysis.migrationCommand = ormInfo.migrationCommand;
      break;
    }
  }
  // Check for raw DB drivers if no ORM matched
  if (!analysis.needsDatabase) {
    analysis.needsDatabase = frameworkData.dbDeps.some((d: string) => d in deps);
  }

  // Package manager
  analysis.packageManager = detectPackageManager(dir);

  // Node version
  analysis.nodeVersion = detectNodeVersion(dir, pkg);

  // Build command
  if (pkg.scripts?.build) {
    analysis.buildCommand = `${analysis.packageManager === 'npm' ? 'npm run' : analysis.packageManager} build`;
  }

  // Start command
  if (pkg.scripts?.start) {
    analysis.startCommand = `${analysis.packageManager === 'npm' ? 'npm' : analysis.packageManager} start`;
  } else if (pkg.main) {
    analysis.startCommand = `node ${pkg.main}`;
  }

  // Warnings
  if (!pkg.scripts?.start && !pkg.main && analysis.framework !== 'nextjs' && analysis.framework !== 'vite') {
    analysis.warnings.push(
      'No "start" script in package.json. Add a start script or the server may not launch correctly.'
    );
  }
}

function analyzePythonProject(dir: string, analysis: ProjectAnalysis): void {
  // Read requirements
  const reqs = readFileSafe(join(dir, 'requirements.txt')) || '';
  const pyproject = readFileSafe(join(dir, 'pyproject.toml')) || '';
  const allDeps = reqs + '\n' + pyproject;

  // Detect framework
  if (allDeps.includes('django') || existsSync(join(dir, 'manage.py'))) {
    analysis.framework = 'django';
    analysis.port = 8000;

    // Detect WSGI module by scanning for wsgi.py
    let wsgiModule = 'app';
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && existsSync(join(dir, entry.name, 'wsgi.py'))) {
          wsgiModule = entry.name;
          break;
        }
      }
    } catch {}
    analysis.startCommand = `gunicorn ${wsgiModule}.wsgi:application --bind 0.0.0.0:8000`;
    analysis.migrationCommand = 'python manage.py migrate';
    analysis.needsDatabase = true;
    analysis.orm = 'django';
  } else if (allDeps.includes('fastapi')) {
    analysis.framework = 'fastapi';
    analysis.port = 8000;

    // Detect entry point
    let entry = 'main';
    if (existsSync(join(dir, 'app.py'))) entry = 'app';
    else if (existsSync(join(dir, 'main.py'))) entry = 'main';
    analysis.startCommand = `uvicorn ${entry}:app --host 0.0.0.0 --port 8000`;
  } else if (allDeps.includes('flask')) {
    analysis.framework = 'flask';
    analysis.port = 5000;

    let entry = 'app';
    if (existsSync(join(dir, 'app.py'))) entry = 'app';
    else if (existsSync(join(dir, 'main.py'))) entry = 'main';
    analysis.startCommand = `gunicorn ${entry}:app --bind 0.0.0.0:5000`;
  }

  // Detect database (beyond django)
  if (!analysis.needsDatabase) {
    if (/psycopg2|asyncpg|sqlalchemy|databases/.test(allDeps)) {
      analysis.needsDatabase = true;
    }
  }

  // Detect ORM for non-django
  if (!analysis.orm) {
    if (allDeps.includes('sqlalchemy')) {
      analysis.orm = 'sqlalchemy';
      if (allDeps.includes('alembic')) {
        analysis.migrationCommand = 'alembic upgrade head';
      }
    }
  }
}

function analyzeGoProject(dir: string, analysis: ProjectAnalysis): void {
  analysis.port = 8080;

  const goMod = readFileSafe(join(dir, 'go.mod')) || '';
  const goSum = readFileSafe(join(dir, 'go.sum')) || '';
  const allDeps = goMod + '\n' + goSum;

  if (/pgx|gorm|lib\/pq/.test(allDeps)) {
    analysis.needsDatabase = true;
  }
}

export function analyzeProject(dir: string): ProjectAnalysis {
  const analysis: ProjectAnalysis = {
    type: 'static',
    framework: null,
    port: 8080,
    needsDatabase: false,
    orm: null,
    migrationCommand: null,
    packageManager: null,
    buildCommand: null,
    startCommand: null,
    nodeVersion: null,
    hasDockerfile: false,
    nextjsNeedsStandalone: false,
    recommendedTier: 'small',
    isMonorepo: false,
    warnings: [],
  };

  // Check for Dockerfile
  analysis.hasDockerfile = existsSync(join(dir, 'Dockerfile'));

  // Detect monorepo
  analysis.isMonorepo = detectMonorepo(dir);
  if (analysis.isMonorepo) {
    analysis.warnings.push(
      'Monorepo detected (frontend + backend subdirectories). Deploy each service separately with a shared group name.'
    );
  }

  // Detect project type and details (even if Dockerfile exists, for metadata)
  if (existsSync(join(dir, 'package.json'))) {
    analysis.type = 'node';
    analyzeNodeProject(dir, analysis);
  } else if (
    existsSync(join(dir, 'requirements.txt')) ||
    existsSync(join(dir, 'pyproject.toml')) ||
    existsSync(join(dir, 'Pipfile'))
  ) {
    analysis.type = 'python';
    analyzePythonProject(dir, analysis);
  } else if (existsSync(join(dir, 'go.mod'))) {
    analysis.type = 'go';
    analyzeGoProject(dir, analysis);
  } else if (existsSync(join(dir, 'index.html'))) {
    analysis.type = 'static';
    analysis.port = 8080;
  }

  // If user has a Dockerfile, set type to docker but keep all detected metadata
  if (analysis.hasDockerfile) {
    analysis.type = 'docker';
    // Default to medium tier for user Dockerfiles (safe default)
    if (analysis.recommendedTier === 'small' && analysis.needsDatabase) {
      analysis.recommendedTier = 'medium';
    }
    // Read EXPOSE port from user's Dockerfile so health checks and Traefik use the right port
    const dockerfileContent = readFileSafe(join(dir, 'Dockerfile')) || '';
    const exposeMatch = dockerfileContent.match(/^EXPOSE\s+(\d+)/m);
    if (exposeMatch) {
      analysis.port = parseInt(exposeMatch[1], 10);
    }
  }

  return analysis;
}
// (Dead re-exports `detectProject` / `ProjectInfo` removed — audit L13.)
