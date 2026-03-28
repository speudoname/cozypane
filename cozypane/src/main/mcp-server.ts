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
  'Deploy a project to CozyPane Cloud. Auto-detects framework, port, and database. No Dockerfile needed. IMPORTANT: Before deploying, always call cozypane_list_deployments first to check if an app with this directory\'s folder name already exists. If it does, reuse the exact same appName to update it rather than creating a duplicate. Only use a new appName if no match is found.',
  {
    directory: z.string().describe('Absolute path to the project directory'),
    appName: z.string().describe('App name — becomes subdomain: <appName>-<user>.cozypane.com. Must match existing deployment appName if one exists for this project.'),
    env: z.record(z.string(), z.string()).optional().describe('Environment variables for the container'),
    group: z.string().optional().describe('Group name for multi-service deploys'),
    tier: z.enum(['small', 'medium', 'large']).optional().describe('Override auto-detected tier'),
  },
  async ({ directory, appName, env, group, tier }) => {
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

    // Deduplication: check if a deployment already exists for this folder name.
    // If an existing deployment matches the folder name but was given a different appName,
    // use the existing appName to avoid creating duplicates.
    try {
      const folderName = path.basename(directory).toLowerCase();
      const existing = await apiFetch('/deploy/list', { timeoutMs: 10000 });
      if (Array.isArray(existing)) {
        const match = existing.find((d: any) => d.appName === folderName || d.appName === appName);
        if (match && match.appName !== appName) {
          return {
            content: [{
              type: 'text' as const,
              text: `A deployment named "${match.appName}" already exists for this project (${match.url}). Re-deploying to "${match.appName}" instead of creating a new "${appName}". Call cozypane_deploy again with appName="${match.appName}" to update it.`,
            }],
            isError: false,
          };
        }
      }
    } catch {
      // Non-fatal: proceed with the given appName if list fails
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
      if (env && Object.keys(env).length > 0) formData.append('env', JSON.stringify(env));
      if (group) formData.append('group', group);
      formData.append('file', blob, 'deploy.tar.gz');

      let result = await apiFetch('/deploy', {
        method: 'POST',
        body: formData,
        timeoutMs: 60000, // 60s for upload + queuing
      });

      // Server returns immediately with status:'building' — poll until done
      if (result?.status === 'building' && result?.id) {
        const deployId = result.id;
        const pollStart = Date.now();
        const POLL_TIMEOUT = 10 * 60 * 1000; // 10 minutes
        while (Date.now() - pollStart < POLL_TIMEOUT) {
          await new Promise(r => setTimeout(r, 5000));
          const poll = await apiFetch(`/deploy/${encodeURIComponent(deployId)}`, { timeoutMs: 15000 });
          if (poll?.status !== 'building') {
            result = poll;
            break;
          }
          // Show phase progress
          const phase = poll.phase || 'building';
          const framework = poll.framework ? ` (${poll.framework})` : '';
          const db = poll.detectedDatabase ? ' + PostgreSQL' : '';
          // Log progress (visible in MCP debug)
          process.stderr.write(`Deploying... [${phase}]${framework}${db}\n`);
        }
      }

      // Auto-recover from health-check timeout on first deploy (common with Next.js cold starts).
      // The build succeeded but the health checker timed out before the server warmed up.
      // A container restart gives it a clean boot with no build overhead, which passes easily.
      const r = result as any;
      if (r?.status === 'unhealthy' && r?.id) {
        const msg: string = r.errorDetail?.message || '';
        const isColdStartTimeout = /health check timed out|not responding|timed out after/i.test(msg);
        if (isColdStartTimeout) {
          process.stderr.write('Health check timed out (likely cold-start). Restarting container...\n');
          try {
            await apiFetch(`/deploy/${encodeURIComponent(r.id)}/redeploy`, { method: 'POST', timeoutMs: 15000 });
            const retryStart = Date.now();
            const RETRY_TIMEOUT = 3 * 60 * 1000;
            while (Date.now() - retryStart < RETRY_TIMEOUT) {
              await new Promise(res => setTimeout(res, 5000));
              const poll = await apiFetch(`/deploy/${encodeURIComponent(r.id)}`, { timeoutMs: 15000 });
              if (poll?.status === 'running' || poll?.status === 'failed') {
                result = poll;
                break;
              }
            }
          } catch {
            // If restart fails, fall through to report original unhealthy status
          }
        }
      }

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

      // Build a human-readable result (re-cast result since it may have been updated by retry)
      const finalResult = result as any;
      let statusLine = '';
      if (finalResult?.status === 'running') {
        statusLine = `Deployed successfully! ${finalResult.url}`;
      } else if (finalResult?.status === 'unhealthy') {
        const suggestion = finalResult.errorDetail?.suggestion || 'Check logs with cozypane_get_logs for details.';
        statusLine = `Deployment unhealthy: ${finalResult.errorDetail?.message || 'health check failed'}. ${suggestion}`;
      } else if (finalResult?.status === 'failed') {
        const suggestion = finalResult.errorDetail?.suggestion || 'Check build logs with cozypane_get_logs (type="build").';
        statusLine = `Deploy failed: ${finalResult.errorDetail?.message || 'unknown error'}. ${suggestion}`;
      }

      return {
        content: [{
          type: 'text' as const,
          text: statusLine ? `${statusLine}\n\n${JSON.stringify(result, null, 2)}` : JSON.stringify(result, null, 2),
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
