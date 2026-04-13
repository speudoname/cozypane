import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeProject } from './detector.js';

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'detector-test-'));
}

function writePkg(dir: string, pkg: Record<string, unknown>): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
}

const dirs: string[] = [];
function tmp(): string {
  const d = makeTmp();
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  dirs.length = 0;
});

describe('analyzeProject', () => {
  // --- Node.js projects ---

  it('detects Node + Next.js project', () => {
    const dir = tmp();
    writePkg(dir, {
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
      scripts: { build: 'next build', start: 'next start' },
    });
    const result = analyzeProject(dir);
    expect(result.type).toBe('node');
    expect(result.framework).toBe('nextjs');
    expect(result.port).toBe(3000);
    expect(result.recommendedTier).toBe('medium');
    expect(result.packageManager).toBe('npm');
    expect(result.buildCommand).toBe('npm run build');
    expect(result.startCommand).toBe('npm start');
    expect(result.nextjsNeedsStandalone).toBe(true);
  });

  it('detects Next.js standalone already set', () => {
    const dir = tmp();
    writePkg(dir, { dependencies: { next: '^14.0.0' } });
    writeFileSync(join(dir, 'next.config.js'), `module.exports = { output: "standalone" };`);
    const result = analyzeProject(dir);
    expect(result.framework).toBe('nextjs');
    expect(result.nextjsNeedsStandalone).toBe(false);
  });

  it('detects Node + Vite (SPA)', () => {
    const dir = tmp();
    writePkg(dir, {
      dependencies: { vite: '^5.0.0', react: '^18.0.0' },
      scripts: { build: 'vite build' },
    });
    const result = analyzeProject(dir);
    expect(result.type).toBe('node');
    expect(result.framework).toBe('vite');
    expect(result.port).toBe(8080);
  });

  it('excludes vite when express is present', () => {
    const dir = tmp();
    writePkg(dir, {
      dependencies: { vite: '^5.0.0', express: '^4.0.0' },
      scripts: { build: 'tsc', start: 'node dist/index.js' },
    });
    const result = analyzeProject(dir);
    expect(result.type).toBe('node');
    expect(result.framework).toBe('express');
  });

  it('detects Express project', () => {
    const dir = tmp();
    writePkg(dir, {
      dependencies: { express: '^4.18.0' },
      scripts: { start: 'node server.js' },
    });
    const result = analyzeProject(dir);
    expect(result.type).toBe('node');
    expect(result.framework).toBe('express');
    expect(result.port).toBe(3000);
  });

  it('detects Fastify project', () => {
    const dir = tmp();
    writePkg(dir, {
      dependencies: { fastify: '^5.0.0' },
      scripts: { start: 'node index.js' },
    });
    const result = analyzeProject(dir);
    expect(result.framework).toBe('fastify');
    expect(result.port).toBe(3000);
  });

  // --- Package manager detection ---

  it('detects bun lockfile', () => {
    const dir = tmp();
    writePkg(dir, { dependencies: { express: '^4.0.0' } });
    writeFileSync(join(dir, 'bun.lockb'), '');
    const result = analyzeProject(dir);
    expect(result.packageManager).toBe('bun');
  });

  it('detects pnpm lockfile', () => {
    const dir = tmp();
    writePkg(dir, { dependencies: { express: '^4.0.0' } });
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    const result = analyzeProject(dir);
    expect(result.packageManager).toBe('pnpm');
  });

  it('detects yarn lockfile', () => {
    const dir = tmp();
    writePkg(dir, { dependencies: { express: '^4.0.0' } });
    writeFileSync(join(dir, 'yarn.lock'), '');
    const result = analyzeProject(dir);
    expect(result.packageManager).toBe('yarn');
  });

  it('defaults to npm when no lockfile', () => {
    const dir = tmp();
    writePkg(dir, { dependencies: { express: '^4.0.0' } });
    const result = analyzeProject(dir);
    expect(result.packageManager).toBe('npm');
  });

  // --- Node version detection ---

  it('extracts version from .nvmrc', () => {
    const dir = tmp();
    writePkg(dir, { dependencies: { express: '^4.0.0' } });
    writeFileSync(join(dir, '.nvmrc'), 'v18.17.0\n');
    const result = analyzeProject(dir);
    expect(result.nodeVersion).toBe('18');
  });

  it('extracts version from .node-version', () => {
    const dir = tmp();
    writePkg(dir, { dependencies: { express: '^4.0.0' } });
    writeFileSync(join(dir, '.node-version'), '20.11.0');
    const result = analyzeProject(dir);
    expect(result.nodeVersion).toBe('20');
  });

  it('extracts version from engines.node', () => {
    const dir = tmp();
    writePkg(dir, {
      dependencies: { express: '^4.0.0' },
      engines: { node: '>=16.0.0' },
    });
    const result = analyzeProject(dir);
    expect(result.nodeVersion).toBe('16');
  });

  it('defaults node version to 20', () => {
    const dir = tmp();
    writePkg(dir, { dependencies: { express: '^4.0.0' } });
    const result = analyzeProject(dir);
    expect(result.nodeVersion).toBe('20');
  });

  // --- ORM / database detection ---

  it('detects Prisma ORM', () => {
    const dir = tmp();
    writePkg(dir, {
      dependencies: { express: '^4.0.0', '@prisma/client': '^5.0.0' },
      devDependencies: { prisma: '^5.0.0' },
    });
    const result = analyzeProject(dir);
    expect(result.orm).toBe('prisma');
    expect(result.needsDatabase).toBe(true);
    expect(result.migrationCommand).toBe('npx prisma migrate deploy');
  });

  it('detects Drizzle ORM', () => {
    const dir = tmp();
    writePkg(dir, {
      dependencies: { express: '^4.0.0', 'drizzle-orm': '^0.29.0' },
    });
    const result = analyzeProject(dir);
    expect(result.orm).toBe('drizzle');
    expect(result.needsDatabase).toBe(true);
    expect(result.migrationCommand).toBe('npx drizzle-kit migrate');
  });

  it('detects raw database dependency (pg) without ORM', () => {
    const dir = tmp();
    writePkg(dir, {
      dependencies: { express: '^4.0.0', pg: '^8.0.0' },
    });
    const result = analyzeProject(dir);
    expect(result.orm).toBeNull();
    expect(result.needsDatabase).toBe(true);
  });

  // --- Python projects ---

  it('detects Python + Django', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'requirements.txt'), 'django==4.2\npsycopg2==2.9\n');
    writeFileSync(join(dir, 'manage.py'), '');
    // Create a directory with wsgi.py
    mkdirSync(join(dir, 'myapp'));
    writeFileSync(join(dir, 'myapp', 'wsgi.py'), '');
    const result = analyzeProject(dir);
    expect(result.type).toBe('python');
    expect(result.framework).toBe('django');
    expect(result.port).toBe(8000);
    expect(result.needsDatabase).toBe(true);
    expect(result.orm).toBe('django');
    expect(result.startCommand).toContain('gunicorn myapp.wsgi:application');
  });

  it('detects Python + FastAPI', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'requirements.txt'), 'fastapi==0.100.0\nuvicorn\n');
    writeFileSync(join(dir, 'main.py'), '');
    const result = analyzeProject(dir);
    expect(result.type).toBe('python');
    expect(result.framework).toBe('fastapi');
    expect(result.port).toBe(8000);
    expect(result.startCommand).toContain('uvicorn main:app');
  });

  it('detects Python + Flask', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'requirements.txt'), 'flask==3.0.0\n');
    writeFileSync(join(dir, 'app.py'), '');
    const result = analyzeProject(dir);
    expect(result.type).toBe('python');
    expect(result.framework).toBe('flask');
    expect(result.port).toBe(5000);
    expect(result.startCommand).toContain('gunicorn app:app');
  });

  it('detects Python sqlalchemy ORM', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'requirements.txt'), 'fastapi\nsqlalchemy\nalembic\n');
    writeFileSync(join(dir, 'main.py'), '');
    const result = analyzeProject(dir);
    expect(result.orm).toBe('sqlalchemy');
    expect(result.needsDatabase).toBe(true);
    expect(result.migrationCommand).toBe('alembic upgrade head');
  });

  // --- Go projects ---

  it('detects Go project', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'go.mod'), 'module example.com/myapp\n\ngo 1.22\n');
    const result = analyzeProject(dir);
    expect(result.type).toBe('go');
    expect(result.port).toBe(8080);
  });

  it('detects Go project with database dependency', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'go.mod'), 'module example.com/myapp\ngo 1.22\nrequire github.com/jackc/pgx v5\n');
    const result = analyzeProject(dir);
    expect(result.type).toBe('go');
    expect(result.needsDatabase).toBe(true);
  });

  // --- Docker projects ---

  it('detects Docker project with Dockerfile', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:20\nEXPOSE 4000\nCMD ["node", "index.js"]');
    const result = analyzeProject(dir);
    expect(result.type).toBe('docker');
    expect(result.hasDockerfile).toBe(true);
    expect(result.port).toBe(4000);
  });

  it('Dockerfile overrides type but keeps metadata from package.json', () => {
    const dir = tmp();
    writePkg(dir, {
      dependencies: { express: '^4.0.0', '@prisma/client': '^5.0.0' },
      devDependencies: { prisma: '^5.0.0' },
    });
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:20\nEXPOSE 5000\nCMD ["node", "index.js"]');
    const result = analyzeProject(dir);
    expect(result.type).toBe('docker');
    expect(result.hasDockerfile).toBe(true);
    expect(result.port).toBe(5000);
    // metadata still detected
    expect(result.orm).toBe('prisma');
    expect(result.needsDatabase).toBe(true);
    expect(result.recommendedTier).toBe('medium');
  });

  // --- Static projects ---

  it('detects static project with just index.html', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    const result = analyzeProject(dir);
    expect(result.type).toBe('static');
    expect(result.port).toBe(8080);
    expect(result.framework).toBeNull();
  });

  // --- Monorepo detection ---

  it('detects monorepo with backend + frontend', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'backend'));
    writeFileSync(join(dir, 'backend', 'package.json'), '{}');
    mkdirSync(join(dir, 'frontend'));
    writeFileSync(join(dir, 'frontend', 'package.json'), '{}');
    const result = analyzeProject(dir);
    expect(result.isMonorepo).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('Monorepo');
  });

  it('does not flag monorepo without both sides', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'backend'));
    writeFileSync(join(dir, 'backend', 'package.json'), '{}');
    // no frontend dir
    writePkg(dir, { dependencies: { express: '^4.0.0' } });
    const result = analyzeProject(dir);
    expect(result.isMonorepo).toBe(false);
  });

  // --- Empty / unknown project ---

  it('returns static for empty directory', () => {
    const dir = tmp();
    const result = analyzeProject(dir);
    expect(result.type).toBe('static');
    expect(result.framework).toBeNull();
  });

  // --- Warnings ---

  it('warns when no start script and no main field', () => {
    const dir = tmp();
    writePkg(dir, {
      dependencies: { express: '^4.0.0' },
      scripts: { build: 'tsc' },
    });
    const result = analyzeProject(dir);
    expect(result.warnings.some(w => w.includes('start'))).toBe(true);
  });

  it('does not warn for nextjs without start script', () => {
    const dir = tmp();
    writePkg(dir, {
      dependencies: { next: '^14.0.0' },
      scripts: { build: 'next build' },
    });
    const result = analyzeProject(dir);
    expect(result.warnings.some(w => w.includes('start'))).toBe(false);
  });
});
