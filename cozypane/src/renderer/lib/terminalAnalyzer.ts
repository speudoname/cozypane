export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b[\[\(][0-9;?]*[a-zA-Z]/g, '')
             .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
             .replace(/\x1b[^[\(][^\x1b]*/g, '')
             .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export const TUI_ENTER = /\x1b\[\?1049h/;
export const TUI_EXIT = /\x1b\[\?1049l/;

// Interactive patterns -> raw mode (check against all recent lines)
const RAW_PATTERNS = [
  /\[Y\/n\]/i,
  /\[y\/N\]/i,
  /\(y\/n\)/i,
  /\(yes\/no\)/i,
  /enter to confirm/i,
  /esc to cancel/i,
  /press any key/i,
  /press enter/i,
  /password\s*:/i,
  /passphrase/i,
  /continue\s*\?/i,
  /overwrite\s*\?/i,
  /proceed\s*\?/i,
  /do you want to/i,
  /\d+\.\s*Yes/,
  /\d+\.\s*No/,
  /trust this folder/i,
];

// Text input patterns -> input bar
const INPUT_PATTERNS = [
  /[$%#]\s*$/,              // shell prompt
  /❯\s*$/,                 // Claude Code prompt / starship
  /➜\s*/,                  // oh-my-zsh
  />>>\s*$/,               // python repl
  />\s*$/,                 // generic > prompt
];

/**
 * Detect if the terminal is showing a numbered choice prompt (e.g. plan mode).
 * Looks for patterns like "1. Yes", "2. No", numbered options in recent output.
 */
const CHOICE_PATTERNS = [
  /^\s*\d+[\.\)]\s+\S/,         // "1. Accept" or "1) Accept"
];

export function detectChoicePrompt(rollingBuffer: string, preStripped = false): boolean {
  const cleaned = preStripped ? rollingBuffer : stripAnsi(rollingBuffer);
  const lines = cleaned.split('\n');
  const recentLines = lines.slice(-20);

  // Count lines that look like numbered options
  let choiceCount = 0;
  for (let i = recentLines.length - 1; i >= Math.max(0, recentLines.length - 15); i--) {
    const line = recentLines[i].trim();
    for (const p of CHOICE_PATTERNS) {
      if (p.test(line)) { choiceCount++; break; }
    }
  }

  // Need at least 2 numbered options to consider it a choice prompt
  return choiceCount >= 2;
}

/**
 * Analyze recent terminal output and determine the desired focus mode.
 * Returns 'terminal' for interactive prompts, 'input' for shell prompts, or null if undetermined.
 */
export type AiAction = 'idle' | 'reading' | 'writing' | 'executing' | 'thinking';

const WRITE_PATTERNS = [
  /\bEdit\(/,
  /\bWrite\(/,
  /\bNotebookEdit\(/,
];

const READ_PATTERNS = [
  /\bRead\(/,
  /\bGlob\(/,
  /\bGrep\(/,
  /\bLS\(/,
];

const EXEC_PATTERNS = [
  /\bBash\(/,
  /\bBash /,
];

export function analyzeAction(rollingBuffer: string, claudeRunning: boolean, preStripped = false): AiAction {
  if (!claudeRunning) return 'idle';

  const cleaned = preStripped ? rollingBuffer : stripAnsi(rollingBuffer);
  const lines = cleaned.split('\n');
  const recentLines = lines.slice(-30);

  // Check if Claude prompt is showing (idle/waiting for input)
  for (let i = recentLines.length - 1; i >= Math.max(0, recentLines.length - 3); i--) {
    if (/❯\s*$/.test(recentLines[i].trim())) return 'idle';
  }

  // Scan backwards for most recent tool marker
  for (let i = recentLines.length - 1; i >= 0; i--) {
    const line = recentLines[i];
    for (const p of EXEC_PATTERNS) { if (p.test(line)) return 'executing'; }
    for (const p of WRITE_PATTERNS) { if (p.test(line)) return 'writing'; }
    for (const p of READ_PATTERNS) { if (p.test(line)) return 'reading'; }
  }

  return 'thinking';
}

export function analyzeFocus(rollingBuffer: string, preStripped?: string): 'input' | 'terminal' | null {
  const cleaned = preStripped || stripAnsi(rollingBuffer);
  const lines = cleaned.split('\n').filter(l => l.trim());
  const recentLines = lines.slice(-15);
  const recentText = recentLines.join('\n');

  // Check interactive patterns (against all recent text)
  for (const pattern of RAW_PATTERNS) {
    if (pattern.test(recentText)) {
      return 'terminal';
    }
  }

  // Check input patterns against EACH recent line (not just last)
  // because Claude's prompt ❯ might be on a middle line with status bar below
  for (let i = recentLines.length - 1; i >= Math.max(0, recentLines.length - 5); i--) {
    const line = recentLines[i].trim();
    for (const pattern of INPUT_PATTERNS) {
      if (pattern.test(line)) {
        return 'input';
      }
    }
  }

  return null;
}

/**
 * Detect a deployed CozyPane URL in terminal output.
 * Returns the URL if found, null otherwise.
 */
export function detectDeployUrl(rollingBuffer: string, preStripped = false): string | null {
  const cleaned = preStripped ? rollingBuffer : stripAnsi(rollingBuffer);
  // Match https://appname-username.cozypane.com (at least two segments before .cozypane.com)
  const match = cleaned.match(/https:\/\/[a-z0-9][a-z0-9-]*[a-z0-9]\.cozypane\.com\b/i);
  return match ? match[0] : null;
}

/**
 * Detect localhost/dev server URLs in terminal output.
 * Catches Vite, Next.js, webpack-dev-server, Django, Flask, Rails, etc.
 * Returns the most recently detected URL, or null.
 */
export function detectLocalUrl(rollingBuffer: string, preStripped = false): string | null {
  const cleaned = preStripped ? rollingBuffer : stripAnsi(rollingBuffer);
  // Match http://localhost:PORT, http://127.0.0.1:PORT, http://0.0.0.0:PORT
  // Also match "Local:" lines from Vite/Next (e.g. "Local:   http://localhost:5173/")
  const patterns = [
    /https?:\/\/localhost:\d{2,5}\b[^\s)}\]]*/gi,
    /https?:\/\/127\.0\.0\.1:\d{2,5}\b[^\s)}\]]*/gi,
    /https?:\/\/0\.0\.0\.0:\d{2,5}\b[^\s)}\]]*/gi,
    /https?:\/\/\[::\]:\d{2,5}\b[^\s)}\]]*/gi,
  ];

  let lastMatch: string | null = null;
  for (const pattern of patterns) {
    const matches = cleaned.match(pattern);
    if (matches) {
      lastMatch = matches[matches.length - 1];
    }
  }

  // Normalize 0.0.0.0 and [::] to localhost for webview access
  if (lastMatch) {
    lastMatch = lastMatch.replace(/\/\/0\.0\.0\.0:/, '//localhost:');
    lastMatch = lastMatch.replace(/\/\/\[::\]:/, '//localhost:');
    // Remove trailing slash if it's the only path
    lastMatch = lastMatch.replace(/\/+$/, '');
  }

  return lastMatch;
}
