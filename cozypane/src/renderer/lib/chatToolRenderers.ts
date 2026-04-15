// Per-tool output parsers for Chat Mode v5.
// Each parser takes the raw (ANSI-stripped) tool output block and returns
// a structured meta object the UI can render richly.

import type {
  BashMeta,
  EditMeta,
  GrepMatch,
  GrepMeta,
  ReadMeta,
  ToolType,
} from './chatEvents';

// --- Bash ---------------------------------------------------------------

const EXIT_CODE_RE = /\[\s*(?:exit|status)\s*[:=]?\s*(-?\d+)\s*\]/i;
const NON_ZERO_EXIT_RE = /\b(?:exited with code|command failed with exit code)\s+(-?\d+)/i;

export function parseBashResult(output: string): BashMeta {
  const meta: BashMeta = { stdout: output };
  let m = EXIT_CODE_RE.exec(output);
  if (!m) m = NON_ZERO_EXIT_RE.exec(output);
  if (m) {
    const code = parseInt(m[1], 10);
    if (!Number.isNaN(code)) meta.exitCode = code;
  }
  return meta;
}

// --- Edit ---------------------------------------------------------------

// Matches "Edit(path)" or "Update(path)" — we just keep the path here.
const EDIT_HEADER_RE = /^(?:Edit|Update|MultiEdit)\(([^)]+)\)/;

export function parseEditResult(output: string, detail?: string): EditMeta {
  const lines = output.split('\n');
  let file = detail?.replace(/['"]/g, '').trim() || '';
  let additions = 0;
  let removals = 0;
  const diffLines: string[] = [];

  for (const line of lines) {
    if (!file) {
      const h = EDIT_HEADER_RE.exec(line.trim());
      if (h) { file = h[1]; continue; }
    }
    // Unified-diff style
    if (/^\+[^+]/.test(line)) { additions++; diffLines.push(line); continue; }
    if (/^-[^-]/.test(line)) { removals++; diffLines.push(line); continue; }
    if (/^@@/.test(line) || /^diff /.test(line)) { diffLines.push(line); continue; }
  }

  // Fallback: scan for "(+N -M)" summary which Claude Code often prints.
  const sum = /\(\+(\d+)\s*-(\d+)\)/.exec(output);
  if (sum) {
    if (!additions) additions = parseInt(sum[1], 10) || 0;
    if (!removals) removals = parseInt(sum[2], 10) || 0;
  }

  return {
    file,
    additions,
    removals,
    diff: diffLines.length ? diffLines.join('\n') : undefined,
  };
}

// --- Read ---------------------------------------------------------------

const READ_LINES_RE = /Read\s+(\d+)\s+lines/i;

export function parseReadResult(output: string, detail?: string): ReadMeta {
  const file = detail?.replace(/['"]/g, '').trim() || '';
  const m = READ_LINES_RE.exec(output);
  const lines = m ? parseInt(m[1], 10) : undefined;
  const trimmed = output.trim();
  const preview = trimmed.length > 400 ? trimmed.slice(0, 400) + '…' : trimmed;
  const out: ReadMeta = { file };
  if (lines !== undefined && !Number.isNaN(lines)) out.lines = lines;
  if (preview) out.preview = preview;
  return out;
}

// --- Grep ---------------------------------------------------------------

// Matches "path/to/file.ts:42:preview text..."
const GREP_MATCH_RE = /^([^\s:][^:]*):(\d+):(.*)$/;

export function parseGrepResult(output: string, detail?: string): GrepMeta {
  const matches: GrepMatch[] = [];
  for (const line of output.split('\n')) {
    const m = GREP_MATCH_RE.exec(line);
    if (!m) continue;
    const ln = parseInt(m[2], 10);
    if (Number.isNaN(ln)) continue;
    matches.push({ file: m[1], line: ln, preview: m[3].trim() });
  }
  return { pattern: detail?.replace(/['"]/g, '').trim() || '', matches };
}

// --- Tool detection ----------------------------------------------------

// Lines starting with ⏺ mark a tool invocation. Examples:
//   "⏺ Read(src/App.tsx)"
//   "⏺ Bash(npm test)"
//   "⏺ Grep(pattern: \"foo\")"
const TOOL_LINE_RE = /^\s*[\u23FA\u25CF]\s*([A-Za-z][A-Za-z0-9_]*)\s*\(([^]*)\)\s*$/;

const TOOL_NAME_MAP: Record<string, ToolType> = {
  Read: 'read',
  Edit: 'edit',
  Update: 'edit',
  MultiEdit: 'edit',
  Write: 'write',
  Bash: 'bash',
  Grep: 'grep',
  Glob: 'glob',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
  Task: 'agent',
  Agent: 'agent',
  TodoWrite: 'todo',
  NotebookEdit: 'notebook',
  NotebookRead: 'notebook',
};

export function detectTool(line: string): { type: ToolType; detail: string; name: string } | null {
  const m = TOOL_LINE_RE.exec(line);
  if (!m) return null;
  const name = m[1];
  const detail = (m[2] || '').trim();
  const type = TOOL_NAME_MAP[name] || (name.toLowerCase().includes('mcp') ? 'mcp' : 'other');
  return { type, detail, name };
}
