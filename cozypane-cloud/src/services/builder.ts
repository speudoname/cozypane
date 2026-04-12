import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectAnalysis } from './detector.js';
import { docker } from './container.js';

// --- Dockerfile templates by framework ---

function installCmd(pm: string): string {
  switch (pm) {
    case 'pnpm': return 'corepack enable && pnpm install --frozen-lockfile';
    case 'yarn': return 'corepack enable && yarn install --frozen-lockfile';
    case 'bun': return 'npm i -g bun && bun install --frozen-lockfile';
    default: return 'npm ci';
  }
}

function installProdCmd(pm: string): string {
  switch (pm) {
    case 'pnpm': return 'corepack enable && pnpm install --frozen-lockfile --prod';
    case 'yarn': return 'corepack enable && yarn install --frozen-lockfile --production';
    case 'bun': return 'npm i -g bun && bun install --frozen-lockfile --production';
    default: return 'npm ci --omit=dev';
  }
}

function lockFiles(pm: string): string {
  switch (pm) {
    case 'pnpm': return 'package.json pnpm-lock.yaml';
    case 'yarn': return 'package.json yarn.lock';
    case 'bun': return 'package.json bun.lockb bun.lock';
    default: return 'package*.json';
  }
}

function migrationPrefix(analysis: ProjectAnalysis): string {
  if (!analysis.migrationCommand) return '';
  return `${analysis.migrationCommand} && `;
}

function nextjsDockerfile(analysis: ProjectAnalysis): string {
  const pm = analysis.packageManager || 'npm';
  const nodeVer = analysis.nodeVersion || '20';
  return `FROM node:${nodeVer}-alpine AS deps
WORKDIR /app
COPY ${lockFiles(pm)} ./
RUN ${installCmd(pm)}

FROM node:${nodeVer}-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_OPTIONS="--max-old-space-size=1536"
ENV NEXT_TELEMETRY_DISABLED=1
RUN ${pm === 'npm' ? 'npm run' : pm} build

FROM node:${nodeVer}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ${analysis.migrationCommand ? `sh -c "${migrationPrefix(analysis)}node server.js"` : '["node", "server.js"]'}
`;
}

function viteSpaDockerfile(analysis: ProjectAnalysis): string {
  const pm = analysis.packageManager || 'npm';
  const nodeVer = analysis.nodeVersion || '20';
  return `FROM node:${nodeVer}-alpine AS builder
WORKDIR /app
COPY ${lockFiles(pm)} ./
RUN ${installCmd(pm)}
COPY . .
RUN ${pm === 'npm' ? 'npm run' : pm} build

FROM nginxinc/nginx-unprivileged:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
RUN echo 'server { listen 8080; root /usr/share/nginx/html; index index.html; location / { try_files $uri $uri/ /index.html; } }' > /etc/nginx/conf.d/default.conf
EXPOSE 8080
`;
}

function expressDockerfile(analysis: ProjectAnalysis): string {
  const pm = analysis.packageManager || 'npm';
  const nodeVer = analysis.nodeVersion || '20';
  const startCmd = analysis.startCommand || 'npm start';
  const hasBuild = !!analysis.buildCommand;

  if (hasBuild) {
    return `FROM node:${nodeVer}-alpine AS builder
WORKDIR /app
COPY ${lockFiles(pm)} ./
RUN ${installCmd(pm)}
COPY . .
RUN ${analysis.buildCommand}

FROM node:${nodeVer}-alpine
WORKDIR /app
COPY --from=builder /app ./
RUN ${installProdCmd(pm)}
EXPOSE ${analysis.port}
CMD sh -c "${migrationPrefix(analysis)}${startCmd}"
`;
  }

  return `FROM node:${nodeVer}-alpine
WORKDIR /app
COPY ${lockFiles(pm)} ./
RUN ${installProdCmd(pm)}
COPY . .
EXPOSE ${analysis.port}
CMD sh -c "${migrationPrefix(analysis)}${startCmd}"
`;
}

/** Shared Python Dockerfile builder — all Python frameworks share the same
 *  base structure, differing only in extra pip packages, extra build steps,
 *  and the CMD. */
function pythonDockerfile(
  analysis: ProjectAnalysis,
  opts: { extraInstall?: string; extraStep?: string; defaultCmd: string },
): string {
  const cmd = analysis.startCommand || opts.defaultCmd;
  const lines = [
    'FROM python:3.12-slim',
    'WORKDIR /app',
    'COPY requirements.txt* pyproject.toml* ./',
    'RUN pip install --no-cache-dir -r requirements.txt 2>/dev/null || pip install --no-cache-dir . 2>/dev/null || true',
  ];
  if (opts.extraInstall) lines.push(`RUN pip install --no-cache-dir ${opts.extraInstall}`);
  lines.push('COPY . .');
  if (opts.extraStep) lines.push(`RUN ${opts.extraStep}`);
  lines.push(`EXPOSE ${analysis.port}`);
  lines.push(`CMD sh -c "${migrationPrefix(analysis)}${cmd}"`);
  return lines.join('\n') + '\n';
}

function djangoDockerfile(analysis: ProjectAnalysis): string {
  return pythonDockerfile(analysis, {
    extraInstall: 'gunicorn',
    extraStep: 'python manage.py collectstatic --noinput 2>/dev/null || true',
    defaultCmd: 'gunicorn app.wsgi:application --bind 0.0.0.0:8000',
  });
}

function fastapiDockerfile(analysis: ProjectAnalysis): string {
  return pythonDockerfile(analysis, {
    extraInstall: 'uvicorn',
    defaultCmd: 'uvicorn main:app --host 0.0.0.0 --port 8000',
  });
}

function flaskDockerfile(analysis: ProjectAnalysis): string {
  return pythonDockerfile(analysis, {
    extraInstall: 'gunicorn',
    defaultCmd: 'gunicorn app:app --bind 0.0.0.0:5000',
  });
}

function genericPythonDockerfile(analysis: ProjectAnalysis): string {
  return pythonDockerfile(analysis, {
    defaultCmd: 'python app.py',
  });
}

function goDockerfile(analysis: ProjectAnalysis): string {
  return `FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /server .

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=builder /server /server
EXPOSE 8080
CMD ${analysis.migrationCommand ? `sh -c "${migrationPrefix(analysis)}/server"` : '["/server"]'}
`;
}

function staticDockerfile(): string {
  return `FROM nginxinc/nginx-unprivileged:alpine
COPY . /usr/share/nginx/html
RUN echo 'server { listen 8080; root /usr/share/nginx/html; index index.html; location / { try_files $uri $uri/ /index.html; } }' > /etc/nginx/conf.d/default.conf
EXPOSE 8080
`;
}

export function generateDockerfile(analysis: ProjectAnalysis): string {
  // Node.js frameworks
  if (analysis.type === 'node') {
    switch (analysis.framework) {
      case 'nextjs': return nextjsDockerfile(analysis);
      case 'vite':
      case 'angular': // `ng build` → static files, nginx-served like vite SPA
      case 'cra':     // Create React App — static bundle after `npm run build`
        return viteSpaDockerfile(analysis);
      case 'express':
      case 'fastify':
      case 'hono':
      case 'nestjs':
        return expressDockerfile(analysis);
      default:
        return expressDockerfile(analysis); // Generic node fallback
    }
  }

  // Python frameworks
  if (analysis.type === 'python') {
    switch (analysis.framework) {
      case 'django': return djangoDockerfile(analysis);
      case 'fastapi': return fastapiDockerfile(analysis);
      case 'flask': return flaskDockerfile(analysis);
      default: return genericPythonDockerfile(analysis);
    }
  }

  if (analysis.type === 'go') return goDockerfile(analysis);
  return staticDockerfile();
}

/**
 * Patch next.config to add output: "standalone" if missing.
 */
export function patchNextConfig(projectDir: string): void {
  const configFiles = ['next.config.mjs', 'next.config.js', 'next.config.ts'];

  for (const configFile of configFiles) {
    const filePath = join(projectDir, configFile);
    if (!existsSync(filePath)) continue;

    let content = readFileSync(filePath, 'utf-8');

    // Already has standalone
    if (/output\s*:\s*['"`]standalone['"`]/.test(content)) return;

    // Try to inject output: "standalone" into the config object
    // Pattern 1: const nextConfig = { ... } or export default { ... }
    const patterns = [
      // const nextConfig = {
      /((?:const|let|var)\s+\w+\s*=\s*\{)/,
      // export default {
      /(export\s+default\s*\{)/,
      // module.exports = {
      /(module\.exports\s*=\s*\{)/,
    ];

    let patched = false;
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        content = content.replace(pattern, `$1\n  output: "standalone",`);
        patched = true;
        break;
      }
    }

    if (patched) {
      writeFileSync(filePath, content);
      return;
    }
  }

  // No config file found — create one
  writeFileSync(join(projectDir, 'next.config.mjs'), `/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
};
export default nextConfig;
`);
}

/** Build memory limits by analysis */
function buildMemoryLimit(analysis: ProjectAnalysis): number {
  if (analysis.hasDockerfile) return 2048 * 1024 * 1024; // 2GB for user Dockerfiles
  switch (analysis.framework) {
    case 'nextjs':
    case 'nuxt':
      return 2048 * 1024 * 1024; // 2GB
    case 'vite':
    case 'express':
    case 'fastify':
    case 'hono':
    case 'nestjs':
      return 1024 * 1024 * 1024; // 1GB
    default:
      break;
  }
  switch (analysis.type) {
    case 'go': return 1024 * 1024 * 1024;
    case 'python':
    case 'static':
      return 512 * 1024 * 1024;
    default:
      return 1024 * 1024 * 1024;
  }
}

export interface BuildResult {
  tag: string;
  buildLog: string;
}

export async function buildImage(
  projectDir: string,
  analysis: ProjectAnalysis,
  appName: string,
  userId: number,
): Promise<BuildResult> {
  const tag = `cozypane/${userId}-${appName}:latest`;

  // Generate Dockerfile if none exists
  if (!analysis.hasDockerfile) {
    const dockerfile = generateDockerfile(analysis);
    writeFileSync(join(projectDir, 'Dockerfile'), dockerfile);
  }

  // Patch Next.js config if needed
  if (analysis.nextjsNeedsStandalone && !analysis.hasDockerfile) {
    patchNextConfig(projectDir);
  }

  // Build image using Docker API
  const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
  const stream = await docker.buildImage(
    {
      context: projectDir,
      src: ['.'],
    } as any,
    {
      t: tag,
      rm: true,
      forcerm: true,
      memory: buildMemoryLimit(analysis),
      cpuquota: 200000,
    },
  );

  // Wait for build to complete with timeout, capturing output
  const buildLines: string[] = [];
  const buildPromise = new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      },
      (event: { stream?: string; error?: string }) => {
        if (event.stream) {
          buildLines.push(event.stream);
          process.stdout.write(event.stream);
        }
        if (event.error) {
          buildLines.push(`ERROR: ${event.error}`);
          reject(new Error(event.error));
        }
      },
    );
  });

  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Build timed out after 10 minutes')), BUILD_TIMEOUT_MS);
  });

  try {
    await Promise.race([buildPromise, timeoutPromise]);
    clearTimeout(timer!);
  } catch (err: any) {
    clearTimeout(timer!);
    // Kill the Docker build stream so the daemon stops the build and
    // releases CPU/memory. Without this, timed-out builds continue
    // consuming host resources indefinitely.
    try { (stream as any).destroy?.(); } catch {}
    // Attach partial build log to the error so callers can store it
    err.buildLog = buildLines.join('');
    throw err;
  }

  return { tag, buildLog: buildLines.join('') };
}
