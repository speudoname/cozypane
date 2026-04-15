// Chat Mode v5 — typed event definitions for the stream tokenizer.
// The tokenizer converts raw terminal output into a stream of these events
// which the UI renders directly. No blob-then-LLM round-trip.

export type ToolType =
  | 'read'
  | 'edit'
  | 'write'
  | 'bash'
  | 'grep'
  | 'glob'
  | 'webfetch'
  | 'websearch'
  | 'agent'
  | 'todo'
  | 'notebook'
  | 'mcp'
  | 'other';

export interface Status {
  folder?: string;
  branch?: string;
  model?: string;
  contextSize?: string;            // e.g. "1M"
  mode?: 'default' | 'plan' | 'verbose' | 'concise';
  permissionMode?: 'ask' | 'bypass' | 'accept-edits' | 'plan';
  effort?: 'low' | 'medium' | 'high';
  usagePercent?: number;
  usageReset?: string;
  mcpFailures?: number;
}

export type InteractiveKind =
  | 'yes-no'
  | 'numbered'
  | 'lettered'
  | 'text'
  | 'password'
  | 'continue'
  | 'trust-folder'
  | 'custom';

export interface InteractivePrompt {
  kind: InteractiveKind;
  question?: string;
  choices?: Array<{ key: string; label: string }>;
}

export interface BashMeta {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export interface EditMeta {
  file: string;
  additions: number;
  removals: number;
  diff?: string;
}

export interface ReadMeta {
  file: string;
  lines?: number;
  preview?: string;
}

export interface GrepMatch {
  file: string;
  line: number;
  preview: string;
}

export interface GrepMeta {
  pattern: string;
  matches: GrepMatch[];
}

export type ToolMeta =
  | BashMeta
  | EditMeta
  | ReadMeta
  | GrepMeta
  | Record<string, unknown>;

export type ChatEvent =
  | { kind: 'user-input'; text: string; turnId: number }
  | { kind: 'prose-chunk'; text: string; turnId: number }
  | { kind: 'prose-end'; turnId: number }
  | { kind: 'tool-start'; id: string; tool: ToolType; detail: string; turnId: number }
  | { kind: 'tool-result'; id: string; output: string; error?: boolean; meta?: ToolMeta }
  | { kind: 'thinking-start'; label?: string }
  | { kind: 'thinking-end' }
  | { kind: 'status'; status: Status }
  | { kind: 'interactive-prompt'; prompt: InteractivePrompt }
  | { kind: 'plan-proposal'; plan: string }
  | { kind: 'error'; message: string; severity: 'warn' | 'error' }
  | { kind: 'turn-complete'; turnId: number }
  | { kind: 'system-message'; text: string };
