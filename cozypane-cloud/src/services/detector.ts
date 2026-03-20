import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

  // Detect framework
  if (deps.next) {
    analysis.framework = 'nextjs';
    analysis.port = 3000;
    analysis.recommendedTier = 'medium';
    analysis.nextjsNeedsStandalone = checkNextjsStandalone(dir);
  } else if (deps.nuxt) {
    analysis.framework = 'nuxt';
    analysis.port = 3000;
    analysis.recommendedTier = 'medium';
  } else if (deps.vite && !deps.express && !deps.fastify && !deps.hono && !deps['@nestjs/core']) {
    // Vite with no server framework = SPA
    analysis.framework = 'vite';
    analysis.port = 8080;
  } else if (deps.express) {
    analysis.framework = 'express';
    analysis.port = 3000;
  } else if (deps.fastify) {
    analysis.framework = 'fastify';
    analysis.port = 3000;
  } else if (deps.hono || deps['@hono/node-server']) {
    analysis.framework = 'hono';
    analysis.port = 3000;
  } else if (deps['@nestjs/core']) {
    analysis.framework = 'nestjs';
    analysis.port = 3000;
  }

  // Detect ORM / database
  if (deps.prisma || deps['@prisma/client']) {
    analysis.orm = 'prisma';
    analysis.needsDatabase = true;
    analysis.migrationCommand = 'npx prisma migrate deploy';
  } else if (deps['drizzle-orm']) {
    analysis.orm = 'drizzle';
    analysis.needsDatabase = true;
    analysis.migrationCommand = 'npx drizzle-kit migrate';
  } else if (deps.knex) {
    analysis.orm = 'knex';
    analysis.needsDatabase = true;
    analysis.migrationCommand = 'npx knex migrate:latest';
  } else if (deps.sequelize) {
    analysis.orm = 'sequelize';
    analysis.needsDatabase = true;
    analysis.migrationCommand = 'npx sequelize-cli db:migrate';
  } else if (deps.typeorm) {
    analysis.orm = 'typeorm';
    analysis.needsDatabase = true;
    analysis.migrationCommand = 'npx typeorm migration:run -d dist/data-source.js';
  } else if (deps.pg || deps.postgres || deps['pg-promise']) {
    analysis.needsDatabase = true;
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
  }

  return analysis;
}

// Keep backward compat export name
export { analyzeProject as detectProject };
export type { ProjectAnalysis as ProjectInfo };
