// Status line parsers for the Chat Mode v5 tokenizer.
// Claude Code renders a multi-line status block at the bottom of the terminal.
// These pure functions turn each row into a typed partial Status update.

import type { Status } from './chatEvents';

// Matches rows like:
//   "quizme (main) | Opus 4.6 (1M context) | default"
//   "myproj | Sonnet 4 | plan"
// Folder and mode always present; branch + model + contextSize optional.
const STATUS_LINE_RE =
  /^\s*([A-Za-z0-9_.\-]+)(?:\s*\(([^)]+)\))?\s*\|\s*([^|]+?)\s*\|\s*(default|plan|verbose|concise)\b/;

const MODEL_WITH_CTX_RE = /^(.+?)\s*\(([^)]+)\s*context\)\s*$/;

// Matches permission + effort row:
//   "⏵⏵ bypass permissions on (shift+tab to cycle)  ◐ medium · /effort"
//   "ask permissions · /permission-mode"
const PERMISSION_RE =
  /(bypass permissions|accept\s*edits|ask|plan)\b.*?(?:(low|medium|high)\s*·\s*\/effort|$)/i;

// Matches usage row:
//   "You've used 91% of your weekly limit · resets Apr 17 at 10pm"
const USAGE_RE =
  /You['\u2019]ve used\s+(\d{1,3})%\s+of your (?:weekly|5-hour|session)?\s*limit(?:\s*·\s*resets\s+(.+?))?\s*$/i;

// Matches MCP failure row:
//   "1 MCP server failed · /mcp"
const MCP_FAIL_RE = /(\d+)\s+MCP server(?:s)? failed/i;

export function parseStatusLine(text: string): Partial<Status> | null {
  const m = STATUS_LINE_RE.exec(text.trim());
  if (!m) return null;
  const out: Partial<Status> = {
    folder: m[1],
    mode: m[4].toLowerCase() as Status['mode'],
  };
  if (m[2]) out.branch = m[2];
  if (m[3]) {
    const rawModel = m[3].trim();
    const ctx = MODEL_WITH_CTX_RE.exec(rawModel);
    if (ctx) {
      out.model = ctx[1].trim();
      out.contextSize = ctx[2].trim();
    } else {
      out.model = rawModel;
    }
  }
  return out;
}

export function parsePermissionLine(
  text: string,
): { permissionMode: Status['permissionMode']; effort?: Status['effort'] } | null {
  const m = PERMISSION_RE.exec(text);
  if (!m) return null;
  const raw = m[1].toLowerCase().replace(/\s+/g, ' ');
  let permissionMode: Status['permissionMode'] = 'ask';
  if (raw.startsWith('bypass')) permissionMode = 'bypass';
  else if (raw.startsWith('accept')) permissionMode = 'accept-edits';
  else if (raw === 'plan') permissionMode = 'plan';
  else permissionMode = 'ask';

  const out: { permissionMode: Status['permissionMode']; effort?: Status['effort'] } = {
    permissionMode,
  };
  if (m[2]) out.effort = m[2].toLowerCase() as Status['effort'];
  return out;
}

export function parseUsageLine(
  text: string,
): { usagePercent: number; usageReset?: string } | null {
  const m = USAGE_RE.exec(text);
  if (!m) return null;
  const pct = parseInt(m[1], 10);
  if (Number.isNaN(pct)) return null;
  const out: { usagePercent: number; usageReset?: string } = { usagePercent: pct };
  if (m[2]) out.usageReset = m[2].trim();
  return out;
}

export function parseMcpLine(text: string): { mcpFailures: number } | null {
  const m = MCP_FAIL_RE.exec(text);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (Number.isNaN(n)) return null;
  return { mcpFailures: n };
}

/**
 * Combine all four parsers across a multi-line blob and return one merged
 * Status partial. Later lines override earlier ones for the same field.
 */
export function parseAllStatus(blob: string): Partial<Status> {
  const result: Partial<Status> = {};
  const lines = blob.split('\n');
  for (const line of lines) {
    const s = parseStatusLine(line);
    if (s) Object.assign(result, s);
    const p = parsePermissionLine(line);
    if (p) Object.assign(result, p);
    const u = parseUsageLine(line);
    if (u) Object.assign(result, u);
    const mcp = parseMcpLine(line);
    if (mcp) Object.assign(result, mcp);
  }
  return result;
}
