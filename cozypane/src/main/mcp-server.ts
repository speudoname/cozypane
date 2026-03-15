#!/usr/bin/env node

// Standalone MCP server for CozyPane Deploy — no Electron imports.
// Communicates with Claude Code via stdio (MCP protocol).
// Auth token is read from COZYPANE_DEPLOY_TOKEN env var (injected by CozyPane PTY).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { apiFetch as sharedApiFetch, createTarball as sharedCreateTarball, APP_NAME_REGEX } from './deploy-shared.js';

const API_BASE = process.env.COZYPANE_API_URL || 'https://api.cozypane.com';
const DEPLOY_TOKEN = process.env.COZYPANE_DEPLOY_TOKEN || '';

function getUserDataDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'cozypane');
  } else if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), 'cozypane');
  } else {
    return path.join(os.homedir(), '.config', 'cozypane');
  }
}

function requireToken(): string {
  if (!DEPLOY_TOKEN) {
    throw new Error(
      'Not authenticated. Please log in via CozyPane\'s Deploy panel first, then open a new terminal tab.'
    );
  }
  return DEPLOY_TOKEN;
}

function apiFetch(endpoint: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<any> {
  return sharedApiFetch(API_BASE, endpoint, requireToken, options);
}

function createTarball(cwd: string): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), 'cozypane-deploy');
  return sharedCreateTarball(cwd, tmpDir);
}

// --- MCP Server ---

const server = new McpServer({
  name: 'cozypane',
  version: '1.0.0',
});

server.tool(
  'cozypane_deploy',
  `Deploy a single service to CozyPane Cloud. This is triggered when the user says "cozydeploy".

YOU are the intelligence layer. The platform runs whatever Dockerfile you give it. Your job is to:
1. Analyze the project structure
2. Decide the deployment strategy (single app vs multi-service)
3. Create the right Dockerfile(s)
4. Call this tool once per service

## SINGLE APP (most common)
For projects with one service (standard web app, API, static site):
- Create a Dockerfile in the project root
- Call this tool once with the project directory

## MULTI-SERVICE / MONOREPO
For projects with multiple services (e.g. frontend/ + backend/, or a monorepo with apps/):
- Deploy each service SEPARATELY by calling this tool multiple times
- Use the "group" parameter to link related services (e.g. group="myproject")
- Deploy backend/API services FIRST, then frontend (so you know the API URL)
- Pass the API URL to the frontend via the "env" parameter
- Each service gets its own subdomain: <appName>-<username>.cozypane.com

Example flow for a fullstack app:
1. Create Dockerfile in backend/ directory
2. Deploy backend: cozypane_deploy(directory="backend/", appName="myapp-api", group="myapp")
   → returns url: "https://myapp-api-user.cozypane.com"
3. Create Dockerfile in frontend/ directory (build with VITE_API_URL or similar)
4. Deploy frontend: cozypane_deploy(directory="frontend/", appName="myapp-web", group="myapp", env={"VITE_API_URL": "https://myapp-api-user.cozypane.com"})

## DEPLOYMENT CHECKLIST
- Dockerfile REQUIRED: Always create one before deploying. The platform has no magic — it builds your Dockerfile.
- Port: Container must expose ONE HTTP port. Default 3000. Do NOT use port 80.
- Start script: Ensure the app has a production start command (not dev).
- CORS: Backend must allow the frontend's production origin, OR use relative API paths.
- Hardcoded URLs: Replace localhost URLs with production URLs or env vars.

## DATABASE
If the project uses a database (prisma, knex, sequelize, typeorm, drizzle, pg, sqlalchemy, django):
- Set needsDatabase="postgres" — the platform provisions PostgreSQL and injects DATABASE_URL.
- Do NOT bundle PostgreSQL in the Dockerfile.
- Run migrations at container startup (e.g. "npx prisma migrate deploy && node server.js").

## ENV VARS
Use the "env" parameter to pass environment variables to the container. Common uses:
- API_URL / VITE_API_URL: Point frontend to backend service
- Any app config that differs between dev and production
- Secrets needed at runtime (API keys, etc.)
Note: DATABASE_URL is automatically injected when needsDatabase is set.`,
  {
    directory: z.string().describe('Absolute path to the directory to deploy (can be project root or a subdirectory like backend/)'),
    appName: z.string().describe('App name — becomes the subdomain prefix. Use lowercase alphanumeric and hyphens (2-64 chars). For multi-service: use descriptive names like "myapp-api", "myapp-web"'),
    tier: z.enum(['small', 'medium', 'large']).optional().describe('Deployment tier: small (256MB/0.5CPU), medium (512MB/1CPU), large (1GB/2CPU). Default: small'),
    port: z.number().int().min(1).max(65535).optional().describe('Port the container listens on (default: 3000). Do NOT use port 80.'),
    needsDatabase: z.enum(['postgres']).optional().describe('Set to "postgres" if this service needs a database. Platform provisions PostgreSQL and injects DATABASE_URL.'),
    env: z.record(z.string(), z.string()).optional().describe('Environment variables to pass to the container. Example: {"API_URL": "https://myapp-api-user.cozypane.com", "NODE_ENV": "production"}'),
    group: z.string().optional().describe('Group name for multi-service deployments. All services in a group can be managed together (list, delete). Example: "myproject"'),
  },
  async ({ directory, appName, tier, port, needsDatabase, env, group }) => {
    if (!APP_NAME_REGEX.test(appName)) {
      return {
        content: [{
          type: 'text' as const,
          text: `Invalid app name "${appName}". Must be 2-64 characters, lowercase alphanumeric and hyphens only, must start and end with a letter or number. Example: "my-cool-app"`,
        }],
        isError: true,
      };
    }

    if (!fs.existsSync(directory)) {
      return {
        content: [{ type: 'text' as const, text: `Directory not found: ${directory}` }],
        isError: true,
      };
    }

    // Check for Dockerfile — warn but don't block
    if (!fs.existsSync(path.join(directory, 'Dockerfile'))) {
      return {
        content: [{
          type: 'text' as const,
          text: `No Dockerfile found in ${directory}. You MUST create a production Dockerfile before deploying. The platform builds and runs your Dockerfile as-is — there is no auto-detection fallback.\n\nCreate a Dockerfile, then call cozypane_deploy again.`,
        }],
        isError: true,
      };
    }

    try {
      const tarPath = await createTarball(directory);
      const tarBuffer = fs.readFileSync(tarPath);
      try { fs.unlinkSync(tarPath); } catch {}

      const blob = new Blob([tarBuffer], { type: 'application/gzip' });

      // Text fields MUST come before the file — Fastify's multipart parser
      // only exposes fields that appear before the file stream in data.fields.
      const formData = new FormData();
      formData.append('appName', appName);
      if (tier) formData.append('tier', tier);
      if (port) formData.append('port', String(port));
      if (needsDatabase) formData.append('needsDatabase', needsDatabase);
      if (env && Object.keys(env).length > 0) formData.append('env', JSON.stringify(env));
      if (group) formData.append('group', group);
      formData.append('file', blob, 'deploy.tar.gz');

      const result = await apiFetch('/deploy', {
        method: 'POST',
        body: formData,
        timeoutMs: 300000, // 5 minutes — Docker builds can be slow
      });

      // Store the production URL so the Preview panel can find it
      const deployedUrl = (result as any)?.url;
      if (deployedUrl) {
        try {
          const userDataDir = process.env.COZYPANE_USER_DATA || getUserDataDir();
          const previewUrlsPath = path.join(userDataDir, 'preview-urls.json');
          let stored: Record<string, any> = {};
          try { stored = JSON.parse(fs.readFileSync(previewUrlsPath, 'utf-8')); } catch {}
          stored[directory] = { ...stored[directory], productionUrl: deployedUrl };
          fs.writeFileSync(previewUrlsPath, JSON.stringify(stored, null, 2));
        } catch {}
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Deploy failed: ${err.message || err}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'cozypane_list_deployments',
  'List all deployments for the authenticated user. Shows all services grouped by their deploy group.',
  {},
  async () => {
    try {
      const result = await apiFetch('/deploy/list');
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Failed to list deployments: ${err.message || err}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'cozypane_get_deployment',
  'Get details of a specific deployment.',
  {
    id: z.string().describe('Deployment ID'),
  },
  async ({ id }) => {
    try {
      const result = await apiFetch(`/deploy/${encodeURIComponent(id)}`);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get deployment: ${err.message || err}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'cozypane_get_logs',
  'Get runtime or build logs for a specific deployment. Use type="build" to see Docker build output (useful for debugging failed deploys).',
  {
    id: z.string().describe('Deployment ID'),
    type: z.enum(['runtime', 'build']).optional().describe('Log type: "runtime" (default) for container logs, "build" for Docker build output'),
  },
  async ({ id, type }) => {
    try {
      const query = type === 'build' ? '?type=build' : '';
      const result = await apiFetch(`/deploy/${encodeURIComponent(id)}/logs${query}`);
      return {
        content: [{
          type: 'text' as const,
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get logs: ${err.message || err}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'cozypane_delete_deployment',
  'Delete a single deployment, or delete all deployments in a group. When deleting a group, all services, containers, and databases in that group are cleaned up.',
  {
    id: z.string().optional().describe('Deployment ID to delete (for single deployment)'),
    group: z.string().optional().describe('Group name to delete all services in the group at once'),
  },
  async ({ id, group }) => {
    if (!id && !group) {
      return {
        content: [{ type: 'text' as const, text: 'Provide either id or group to delete.' }],
        isError: true,
      };
    }

    try {
      if (group) {
        const result = await apiFetch(`/deploy/group/${encodeURIComponent(group)}`, { method: 'DELETE' });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      const result = await apiFetch(`/deploy/${encodeURIComponent(id!)}`, { method: 'DELETE' });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Failed to delete deployment: ${err.message || err}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'cozypane_redeploy',
  'Restart an existing deployment container.',
  {
    id: z.string().describe('Deployment ID'),
  },
  async ({ id }) => {
    try {
      const result = await apiFetch(`/deploy/${encodeURIComponent(id)}/redeploy`, { method: 'POST' });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Failed to redeploy: ${err.message || err}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'cozypane_get_preview_info',
  `Get devtools data from the CozyPane preview panel. Use this when debugging frontend/preview issues — it provides console logs, network errors, and optionally a screenshot path and HTML snapshot from the live preview.

The preview panel captures all console output and network failures from the running app. Call this tool to inspect what's happening in the browser without asking the user to copy-paste.`,
  {
    includeScreenshot: z.boolean().optional().describe('Include the file path to a screenshot PNG of the preview (default: false)'),
    includeHtml: z.boolean().optional().describe('Include the HTML snapshot of the page (default: false)'),
  },
  async ({ includeScreenshot, includeHtml }) => {
    try {
      const userDataDir = process.env.COZYPANE_USER_DATA || getUserDataDir();
      const devtoolsPath = path.join(userDataDir, 'preview-devtools.json');

      if (!fs.existsSync(devtoolsPath)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              url: null,
              consoleLogs: [],
              networkErrors: [],
              message: 'No preview data available. The preview panel may not be open or no page has been loaded yet.',
            }, null, 2),
          }],
        };
      }

      const raw = JSON.parse(fs.readFileSync(devtoolsPath, 'utf-8'));
      const age = Date.now() - (raw.timestamp || 0);

      const result: Record<string, any> = {
        url: raw.url || null,
        consoleLogs: raw.consoleLogs || [],
        networkErrors: raw.networkErrors || [],
        age: `${Math.round(age / 1000)}s ago`,
      };

      if (includeScreenshot) {
        const screenshotPath = path.join(userDataDir, 'preview-screenshot.png');
        result.screenshotPath = fs.existsSync(screenshotPath) ? screenshotPath : null;
      }

      if (includeHtml) {
        result.htmlSnapshot = raw.htmlSnapshot || null;
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Failed to read preview data: ${err.message || err}` }],
        isError: true,
      };
    }
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
