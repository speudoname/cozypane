import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { getToken, getGithubToken, API_BASE } from './deploy';

// MCP server extraction + config-file generation, split out from main.ts
// (audit H20). The MCP server runs as a subprocess of Claude Code, not of
// the Electron main process. Claude reads `cozypane.mcp.json` via
// `--mcp-config <path>`, then spawns the MCP server listed inside with the
// `env` block from the same file. We write that file with mode 0600 so
// the deploy/GH tokens never end up in the PTY environment.

let extractedMcpServerPath: string | null = null;
let cozypaneMcpConfigPath: string | null = null;

/**
 * Wipe token-containing config file on app quit. Tokens are re-written
 * on next launch from safeStorage. This limits the window during which
 * the plaintext GitHub `repo` token sits on disk — from "always" to
 * "only while the app is running."
 */
export function wipeMcpConfig(): void {
  if (!cozypaneMcpConfigPath) return;
  try {
    if (fs.existsSync(cozypaneMcpConfigPath)) {
      // Overwrite with empty config before deleting to prevent recovery
      fs.writeFileSync(cozypaneMcpConfigPath, '{}', { mode: 0o600 });
      fs.unlinkSync(cozypaneMcpConfigPath);
    }
  } catch { /* best-effort */ }
  cozypaneMcpConfigPath = null;
}

const isDev = !app.isPackaged;

function extractDirPath(): string {
  return path.join(app.getPath('userData'), 'mcp');
}

export function ensureMcpServerExtracted(): string {
  if (extractedMcpServerPath) return extractedMcpServerPath;

  if (isDev) {
    extractedMcpServerPath = path.join(__dirname, 'mcp-server.js');
    return extractedMcpServerPath;
  }

  // Node.js can't require files from inside an asar archive directly.
  // Extract the MCP server to a real path on disk so Claude Code can run it.
  const asarSource = path.join(process.resourcesPath!, 'app.asar', 'dist', 'main', 'mcp-server.js');
  const dir = extractDirPath();
  const extractPath = path.join(dir, 'mcp-server.js');

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Always overwrite to keep in sync with app version
  fs.copyFileSync(asarSource, extractPath);
  extractedMcpServerPath = extractPath;
  return extractedMcpServerPath;
}

/**
 * Generate (or regenerate) the `cozypane.mcp.json` file that Claude Code
 * consumes via `--mcp-config`. Always rewritten so the `env` block reflects
 * the current logged-in tokens (or is empty on logout).
 *
 * Returns the absolute path to the config file.
 */
export function ensureCozypaneMcpConfig(): string {
  const mcpServerPath = ensureMcpServerExtracted();
  const configDir = extractDirPath();
  const configPath = path.join(configDir, 'cozypane.mcp.json');

  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

  // Build per-MCP-server env block — include tokens only when we have
  // them. Missing tokens is fine: the MCP server reports an
  // unauthenticated error until the user logs in.
  const mcpEnv: Record<string, string> = {
    COZYPANE_API_URL: API_BASE,
    COZYPANE_USER_DATA: app.getPath('userData'),
  };
  const token = getToken();
  if (token) mcpEnv.COZYPANE_DEPLOY_TOKEN = token;
  const ghToken = getGithubToken();
  if (ghToken) mcpEnv.COZYPANE_GH_TOKEN = ghToken;

  const config = {
    mcpServers: {
      cozypane: {
        type: 'stdio',
        command: 'node',
        args: [mcpServerPath],
        env: mcpEnv,
      },
    },
  };

  try {
    // Mode 0600: user-only read/write, protects the inlined tokens.
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    // Best-effort chmod in case the file already existed with wider perms.
    try { fs.chmodSync(configPath, 0o600); } catch { /* ignore */ }
  } catch (err) {
    console.error('[CozyPane] Failed to write cozypane MCP config:', err);
  }

  cozypaneMcpConfigPath = configPath;
  return configPath;
}
