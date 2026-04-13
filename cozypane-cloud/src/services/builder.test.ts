import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateDockerfile, patchNextConfig } from './builder.js';
import type { ProjectAnalysis } from './detector.js';

function base(): ProjectAnalysis {
  return {
    type: 'node',
    framework: null,
    port: 3000,
    needsDatabase: false,
    orm: null,
    migrationCommand: null,
    packageManager: 'npm',
    buildCommand: null,
    startCommand: null,
    nodeVersion: '20',
    hasDockerfile: false,
    nextjsNeedsStandalone: false,
    recommendedTier: 'small',
    isMonorepo: false,
    warnings: [],
  };
}

describe('generateDockerfile', () => {
  // --- Next.js ---

  it('generates Next.js Dockerfile with multi-stage build', () => {
    const a = base();
    a.framework = 'nextjs';
    a.buildCommand = 'npm run build';
    a.startCommand = 'npm start';
    const df = generateDockerfile(a);
    expect(df).toContain('FROM node:20-alpine AS deps');
    expect(df).toContain('FROM node:20-alpine AS builder');
    expect(df).toContain('FROM node:20-alpine AS runner');
    expect(df).toContain('npm ci');
    expect(df).toContain('npm run build');
    expect(df).toContain('.next/standalone');
    expect(df).toContain('EXPOSE 3000');
    expect(df).toContain('server.js');
  });

  it('generates Next.js with migration command', () => {
    const a = base();
    a.framework = 'nextjs';
    a.migrationCommand = 'npx prisma migrate deploy';
    const df = generateDockerfile(a);
    expect(df).toContain('npx prisma migrate deploy');
    expect(df).toContain('node server.js');
  });

  it('generates Next.js with pnpm', () => {
    const a = base();
    a.framework = 'nextjs';
    a.packageManager = 'pnpm';
    const df = generateDockerfile(a);
    expect(df).toContain('corepack enable && pnpm install --frozen-lockfile');
    expect(df).toContain('pnpm-lock.yaml');
    expect(df).toContain('pnpm build');
  });

  it('generates Next.js with yarn', () => {
    const a = base();
    a.framework = 'nextjs';
    a.packageManager = 'yarn';
    const df = generateDockerfile(a);
    expect(df).toContain('yarn install --frozen-lockfile');
    expect(df).toContain('yarn.lock');
    expect(df).toContain('yarn build');
  });

  it('generates Next.js with bun', () => {
    const a = base();
    a.framework = 'nextjs';
    a.packageManager = 'bun';
    const df = generateDockerfile(a);
    expect(df).toContain('bun install --frozen-lockfile');
    expect(df).toContain('bun.lockb');
    expect(df).toContain('bun build');
  });

  // --- Vite SPA ---

  it('generates Vite SPA Dockerfile with nginx', () => {
    const a = base();
    a.framework = 'vite';
    a.buildCommand = 'npm run build';
    const df = generateDockerfile(a);
    expect(df).toContain('FROM node:20-alpine AS builder');
    expect(df).toContain('nginxinc/nginx-unprivileged:alpine');
    expect(df).toContain('/usr/share/nginx/html');
    expect(df).toContain('EXPOSE 8080');
    expect(df).toContain('try_files');
  });

  it('generates angular SPA via vite template', () => {
    const a = base();
    a.framework = 'angular';
    const df = generateDockerfile(a);
    expect(df).toContain('nginxinc/nginx-unprivileged:alpine');
  });

  it('generates CRA via vite template', () => {
    const a = base();
    a.framework = 'cra';
    const df = generateDockerfile(a);
    expect(df).toContain('nginxinc/nginx-unprivileged:alpine');
  });

  // --- Express / server frameworks ---

  it('generates Express Dockerfile without build step', () => {
    const a = base();
    a.framework = 'express';
    a.startCommand = 'npm start';
    const df = generateDockerfile(a);
    expect(df).toContain('FROM node:20-alpine');
    expect(df).not.toContain('AS builder');
    expect(df).toContain('npm ci --omit=dev');
    expect(df).toContain('EXPOSE 3000');
    expect(df).toContain('npm start');
  });

  it('generates Express Dockerfile with build step', () => {
    const a = base();
    a.framework = 'express';
    a.buildCommand = 'npm run build';
    a.startCommand = 'npm start';
    const df = generateDockerfile(a);
    expect(df).toContain('AS builder');
    expect(df).toContain('npm run build');
    expect(df).toContain('npm ci --omit=dev');
  });

  it('generates Express with migration prefix', () => {
    const a = base();
    a.framework = 'express';
    a.startCommand = 'npm start';
    a.migrationCommand = 'npx prisma migrate deploy';
    const df = generateDockerfile(a);
    expect(df).toContain('npx prisma migrate deploy && npm start');
  });

  it('generates Fastify Dockerfile', () => {
    const a = base();
    a.framework = 'fastify';
    a.startCommand = 'npm start';
    const df = generateDockerfile(a);
    expect(df).toContain('EXPOSE 3000');
  });

  it('generates NestJS Dockerfile (via express template)', () => {
    const a = base();
    a.framework = 'nestjs';
    a.buildCommand = 'npm run build';
    a.startCommand = 'npm start';
    const df = generateDockerfile(a);
    expect(df).toContain('AS builder');
    expect(df).toContain('npm run build');
  });

  it('falls back to express template for unknown node framework', () => {
    const a = base();
    a.framework = 'unknown-thing';
    a.startCommand = 'npm start';
    const df = generateDockerfile(a);
    expect(df).toContain('FROM node:20-alpine');
  });

  // --- Python frameworks ---

  it('generates Django Dockerfile', () => {
    const a = base();
    a.type = 'python';
    a.framework = 'django';
    a.port = 8000;
    a.startCommand = 'gunicorn myapp.wsgi:application --bind 0.0.0.0:8000';
    const df = generateDockerfile(a);
    expect(df).toContain('FROM python:3.12-slim');
    expect(df).toContain('pip install --no-cache-dir gunicorn');
    expect(df).toContain('collectstatic');
    expect(df).toContain('EXPOSE 8000');
    expect(df).toContain('gunicorn myapp.wsgi:application');
  });

  it('generates FastAPI Dockerfile', () => {
    const a = base();
    a.type = 'python';
    a.framework = 'fastapi';
    a.port = 8000;
    const df = generateDockerfile(a);
    expect(df).toContain('FROM python:3.12-slim');
    expect(df).toContain('pip install --no-cache-dir uvicorn');
    expect(df).toContain('EXPOSE 8000');
    expect(df).toContain('uvicorn main:app');
  });

  it('generates Flask Dockerfile', () => {
    const a = base();
    a.type = 'python';
    a.framework = 'flask';
    a.port = 5000;
    const df = generateDockerfile(a);
    expect(df).toContain('FROM python:3.12-slim');
    expect(df).toContain('pip install --no-cache-dir gunicorn');
    expect(df).toContain('EXPOSE 5000');
    expect(df).toContain('gunicorn app:app');
  });

  it('generates generic Python Dockerfile', () => {
    const a = base();
    a.type = 'python';
    a.framework = null;
    a.port = 8000;
    const df = generateDockerfile(a);
    expect(df).toContain('python app.py');
  });

  it('generates Python with migration command', () => {
    const a = base();
    a.type = 'python';
    a.framework = 'django';
    a.port = 8000;
    a.migrationCommand = 'python manage.py migrate';
    const df = generateDockerfile(a);
    expect(df).toContain('python manage.py migrate &&');
  });

  // --- Go ---

  it('generates Go Dockerfile with multi-stage build', () => {
    const a = base();
    a.type = 'go';
    a.port = 8080;
    const df = generateDockerfile(a);
    expect(df).toContain('FROM golang:1.22-alpine AS builder');
    expect(df).toContain('go mod download');
    expect(df).toContain('CGO_ENABLED=0');
    expect(df).toContain('FROM alpine:3.19');
    expect(df).toContain('EXPOSE 8080');
    expect(df).toContain('["/server"]');
  });

  it('generates Go with migration command', () => {
    const a = base();
    a.type = 'go';
    a.migrationCommand = './migrate up';
    const df = generateDockerfile(a);
    expect(df).toContain('./migrate up && /server');
  });

  // --- Static ---

  it('generates static Dockerfile with nginx', () => {
    const a = base();
    a.type = 'static';
    const df = generateDockerfile(a);
    expect(df).toContain('nginxinc/nginx-unprivileged:alpine');
    expect(df).toContain('EXPOSE 8080');
    expect(df).toContain('try_files');
  });

  // --- Lock file selection ---

  it('uses pnpm lock files for pnpm', () => {
    const a = base();
    a.framework = 'express';
    a.packageManager = 'pnpm';
    a.startCommand = 'pnpm start';
    const df = generateDockerfile(a);
    expect(df).toContain('pnpm-lock.yaml');
    expect(df).toContain('corepack enable && pnpm install --frozen-lockfile --prod');
  });

  it('uses yarn lock files for yarn', () => {
    const a = base();
    a.framework = 'express';
    a.packageManager = 'yarn';
    a.startCommand = 'yarn start';
    const df = generateDockerfile(a);
    expect(df).toContain('yarn.lock');
    expect(df).toContain('corepack enable && yarn install --frozen-lockfile --production');
  });

  it('uses bun lock files for bun', () => {
    const a = base();
    a.framework = 'express';
    a.packageManager = 'bun';
    a.startCommand = 'bun start';
    const df = generateDockerfile(a);
    expect(df).toContain('bun.lockb');
  });

  // --- Custom node version ---

  it('uses specified nodeVersion', () => {
    const a = base();
    a.framework = 'express';
    a.nodeVersion = '18';
    a.startCommand = 'npm start';
    const df = generateDockerfile(a);
    expect(df).toContain('FROM node:18-alpine');
  });
});

describe('patchNextConfig', () => {
  const dirs: string[] = [];

  function makeTmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'builder-test-'));
    dirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    dirs.length = 0;
  });

  it('patches next.config.js with const pattern', () => {
    const dir = makeTmp();
    writeFileSync(join(dir, 'next.config.js'), `const nextConfig = {\n  reactStrictMode: true,\n};\nmodule.exports = nextConfig;\n`);
    patchNextConfig(dir);
    const content = readFileSync(join(dir, 'next.config.js'), 'utf-8');
    expect(content).toContain('output: "standalone"');
  });

  it('patches next.config.mjs with export default', () => {
    const dir = makeTmp();
    writeFileSync(join(dir, 'next.config.mjs'), `export default {\n  reactStrictMode: true,\n};\n`);
    patchNextConfig(dir);
    const content = readFileSync(join(dir, 'next.config.mjs'), 'utf-8');
    expect(content).toContain('output: "standalone"');
  });

  it('does not double-patch if standalone already present', () => {
    const dir = makeTmp();
    writeFileSync(join(dir, 'next.config.js'), `const nextConfig = {\n  output: "standalone",\n};\nmodule.exports = nextConfig;\n`);
    patchNextConfig(dir);
    const content = readFileSync(join(dir, 'next.config.js'), 'utf-8');
    // Should appear exactly once
    const matches = content.match(/output.*standalone/g);
    expect(matches?.length).toBe(1);
  });

  it('creates next.config.mjs when no config file exists', () => {
    const dir = makeTmp();
    patchNextConfig(dir);
    expect(existsSync(join(dir, 'next.config.mjs'))).toBe(true);
    const content = readFileSync(join(dir, 'next.config.mjs'), 'utf-8');
    expect(content).toContain('output: "standalone"');
  });
});
