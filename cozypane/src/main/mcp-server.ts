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
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const API_BASE = process.env.COZYPANE_API_URL || 'https://api.cozypane.com';
const DEPLOY_TOKEN = process.env.COZYPANE_DEPLOY_TOKEN || '';

const APP_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

function requireToken(): string {
  if (!DEPLOY_TOKEN) {
    throw new Error(
      'Not authenticated. Please log in via CozyPane\'s Deploy panel first, then open a new terminal tab.'
    );
  }
  return DEPLOY_TOKEN;
}

async function apiFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  const token = requireToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };
  headers['Authorization'] = `Bearer ${token}`;

  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`API error ${response.status}: ${text || response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

function detectProjectTypeInDir(dir: string): string | null {
  if (fs.existsSync(path.join(dir, 'Dockerfile'))) return 'docker';
  if (fs.existsSync(path.join(dir, 'package.json'))) return 'node';
  if (fs.existsSync(path.join(dir, 'requirements.txt'))) return 'python';
  if (fs.existsSync(path.join(dir, 'go.mod'))) return 'go';
  if (fs.existsSync(path.join(dir, 'index.html'))) return 'static';
  return null;
}

function detectProjectType(cwd: string): { type: string; name: string } {
  const name = path.basename(cwd);
  const rootType = detectProjectTypeInDir(cwd);
  if (rootType) return { type: rootType, name };

  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const subType = detectProjectTypeInDir(path.join(cwd, entry.name));
        if (subType) return { type: subType, name };
      }
    }
  } catch {}

  return { type: 'unknown', name };
}

async function createTarball(cwd: string): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), 'cozypane-deploy');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tarPath = path.join(tmpDir, `deploy-${Date.now()}.tar.gz`);

  const excludeArgs = [
    '--exclude=.git',
    '--exclude=node_modules',
    '--exclude=.env',
    '--exclude=__pycache__',
    '--exclude=.venv',
    '--exclude=.DS_Store',
  ];

  const gitignorePath = path.join(cwd, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    excludeArgs.push(`--exclude-from=${gitignorePath}`);
  }

  await execFileAsync('tar', ['czf', tarPath, ...excludeArgs, '-C', cwd, '.']);
  return tarPath;
}

// --- MCP Server ---

const server = new McpServer({
  name: 'cozypane',
  version: '1.0.0',
});

server.tool(
  'cozypane_deploy',
  'Deploy an application to CozyPane Cloud. Creates a tarball of the directory and uploads it.',
  {
    directory: z.string().describe('Absolute path to the project directory to deploy'),
    appName: z.string().describe('App name (lowercase alphanumeric and hyphens, 2-64 chars, e.g. "my-cool-app")'),
    tier: z.enum(['hobby', 'pro']).optional().describe('Deployment tier (default: hobby)'),
  },
  async ({ directory, appName, tier }) => {
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

    const tarPath = await createTarball(directory);
    const tarBuffer = fs.readFileSync(tarPath);
    try { fs.unlinkSync(tarPath); } catch {}

    const blob = new Blob([tarBuffer], { type: 'application/gzip' });
    const formData = new FormData();
    formData.append('file', blob, 'deploy.tar.gz');
    formData.append('appName', appName);
    if (tier) formData.append('tier', tier);

    const project = detectProjectType(directory);
    formData.append('projectType', project.type);

    const result = await apiFetch('/deploy', {
      method: 'POST',
      body: formData,
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

server.tool(
  'cozypane_list_deployments',
  'List all deployments for the authenticated user.',
  {},
  async () => {
    const result = await apiFetch('/deploy/list');
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

server.tool(
  'cozypane_get_deployment',
  'Get details of a specific deployment.',
  {
    id: z.string().describe('Deployment ID'),
  },
  async ({ id }) => {
    const result = await apiFetch(`/deploy/${id}`);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

server.tool(
  'cozypane_get_logs',
  'Get logs for a specific deployment.',
  {
    id: z.string().describe('Deployment ID'),
  },
  async ({ id }) => {
    const result = await apiFetch(`/deploy/${id}/logs`);
    return {
      content: [{
        type: 'text' as const,
        text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      }],
    };
  }
);

server.tool(
  'cozypane_delete_deployment',
  'Delete a deployment.',
  {
    id: z.string().describe('Deployment ID'),
  },
  async ({ id }) => {
    const result = await apiFetch(`/deploy/${id}`, { method: 'DELETE' });
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

server.tool(
  'cozypane_redeploy',
  'Redeploy an existing deployment.',
  {
    id: z.string().describe('Deployment ID'),
  },
  async ({ id }) => {
    const result = await apiFetch(`/deploy/${id}/redeploy`, { method: 'POST' });
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
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
