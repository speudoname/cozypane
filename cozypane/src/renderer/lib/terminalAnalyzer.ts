export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b[\[\(][0-9;?]*[a-zA-Z]/g, '')
             .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
             .replace(/\x1b[^[\(].?/g, '')
             .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export const TUI_ENTER = /\x1b\[\?1049h/;
export const TUI_EXIT = /\x1b\[\?1049l/;

// Interactive patterns → terminal mode (checked against last 3 lines only)
const INTERACTIVE_PATTERNS = [
  /\[Y\/n\]/i,
  /\[y\/N\]/i,
  /\(y\/n\)/i,
  /\(yes\/no\)/i,
  /continue\s*\?/i,
  /overwrite\s*\?/i,
  /proceed\s*\?/i,
  /do you want to .{0,50}\?\s*$/i,
  /enter to confirm/i,
  /esc to cancel/i,
  /press any key/i,
  /press enter/i,
  /^\s*password\s*:\s*$/i,
  /passphrase\s*.*:\s*$/i,
  /trust this folder/i,
  /type yes to confirm/i,
  /\(use arrow keys\)/i,
  /\(press .* to select\)/i,
  /^\s*select\s*:/i,
  /^\s*choose\s*:/i,
  /^\s*pick\s*:/i,
  /enter a number/i,
  /enter your choice/i,
  /\d+[\.\)]\s*(Yes|No|Accept|Reject|Skip)\b/,
];

// Shell prompt patterns → input mode (checked against last 5 lines)
const SHELL_PROMPT_PATTERNS = [
  /[\w~\/.][$%#]\s*$/,      // bash/zsh/root (require word/path char before symbol)
  /❯\s*$/,                 // Claude Code / starship
  /➜\s+\S/,                // oh-my-zsh (tightened: require char after arrow)
  />>>\s*$/,               // python REPL
  // REMOVED: />\s*$/ — too greedy, matches markdown blockquotes, HTML, git log
];

// Choice detection patterns → input mode with passthrough (last 10 lines, need >= 2)
const CHOICE_DETECT_PATTERNS = [
  /^\s*\d+[.)]\s+\S/,           // "1. Accept" or "1) Accept"
  /^\s*[a-e][.)]\s+\S/i,        // "a) Option" lettered choices
];

export interface FocusDecision {
  target: 'input' | 'terminal' | null;
  isChoicePrompt: boolean;
}

/**
 * Unified focus decision function. Takes pre-stripped lines and returns
 * the desired focus target and whether a choice prompt is detected.
 *
 * Priority order:
 * 1. Interactive patterns (last 3 lines) → terminal
 * 2. Choice prompt (last 10 lines, >= 2 numbered/lettered items) → input with passthrough
 * 3. Shell prompt (last 5 lines) → input
 * 4. Nothing matched → null
 */
export function decideFocus(lines: string[]): FocusDecision {
  // 1. Interactive patterns — last 3 lines
  const last3 = lines.slice(-3);
  for (const line of last3) {
    const trimmed = line.trim();
    for (const pattern of INTERACTIVE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { target: 'terminal', isChoicePrompt: false };
      }
    }
  }

  // 2. Choice prompt — last 10 lines, need >= 2 matches + question indicator in last 3 lines
  const last10 = lines.slice(-10);
  let choiceCount = 0;
  for (const line of last10) {
    const trimmed = line.trim();
    for (const p of CHOICE_DETECT_PATTERNS) {
      if (p.test(trimmed)) { choiceCount++; break; }
    }
  }
  if (choiceCount >= 2) {
    // Strong signal: 3+ numbered items is almost certainly a choice prompt (not a random list)
    if (choiceCount >= 3) {
      return { target: 'input', isChoicePrompt: true };
    }
    // For exactly 2 items, require a question/prompt indicator in the same window
    // to avoid false positives from short numbered lists in normal output
    const hasPromptIndicator = last10.some(line => {
      const t = line.trim();
      return /\?\s*$/.test(t) || /:\s*$/.test(t) || INTERACTIVE_PATTERNS.some(p => p.test(t));
    });
    if (hasPromptIndicator) {
      return { target: 'input', isChoicePrompt: true };
    }
  }

  // 3. Shell prompt — last 5 lines
  const last5 = lines.slice(-5);
  for (const line of last5) {
    const trimmed = line.trim();
    for (const pattern of SHELL_PROMPT_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { target: 'input', isChoicePrompt: false };
      }
    }
  }

  // 4. Nothing matched
  return { target: null, isChoicePrompt: false };
}

/**
 * Analyze recent terminal output and determine the desired focus mode.
 * Returns 'terminal' for interactive prompts, 'input' for shell prompts, or null if undetermined.
 */
// AiAction type is declared in types.d.ts (global ambient)

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

/**
 * Check if recent lines indicate Claude has exited and shell prompt is back.
 * Looks for shell prompt in last 2 lines AND verifies no Claude prompt (❯) in last 5 lines.
 */
export function detectClaudeExit(lines: string[]): boolean {
  const last2 = lines.slice(-2);
  const last20 = lines.slice(-20);

  // Must have a shell prompt in last 2 lines (tightened regex)
  const hasShellPrompt = last2.some(line => /[\w~\/.][$%#]\s*$/.test(line.trim()));
  if (!hasShellPrompt) return false;

  // Must NOT have Claude prompt in last 20 lines
  const hasClaudePrompt = last20.some(line => /❯\s*$/.test(line.trim()));
  return !hasClaudePrompt;
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
 * Returns ALL unique detected URLs (normalized), ordered by first appearance.
 */
// Combined pattern for local URL detection — single regex, compiled once.
const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):\d{2,5}\b[^\s)}\]]*/gi;

// --- Terminal error classification for dev server observability ---

// TerminalError interface is declared in types.d.ts (global ambient)

// TypeScript compiler error: src/App.tsx(42,5): error TS2304: ...
const TS_ERROR_RE = /^(.*?\.[tj]sx?)\((\d+),\d+\):\s*error\s+TS\d+:\s*(.+)/;
// Next.js / webpack style: ./src/App.tsx:42:5  Type error: ...
const TS_ERROR_ALT_RE = /^\.\/(.*?\.[tj]sx?):(\d+):\d+\s+.*(?:Type error|error):\s*(.+)/;
// Vite / esbuild errors
const VITE_ERROR_RE = /^\[vite\].*(?:error|failed)/i;
const ESBUILD_ERROR_RE = /^✘\s+\[ERROR\]\s*(.+)/;
// Build failures
const BUILD_ERROR_RE = /(?:Module not found|Cannot find module|SyntaxError|ENOENT|Failed to compile|Build error)/i;
// HMR errors
const HMR_ERROR_RE = /\[hmr\].*(?:error|fail)|\[vite\]\s*hmr.*fail/i;
// Runtime errors (unhandled)
const RUNTIME_ERROR_RE = /^(?:Error|TypeError|ReferenceError|RangeError|SyntaxError|URIError):\s*(.+)/;
const UNHANDLED_RE = /unhandled(?:Rejection| promise rejection)/i;
// Warnings
const WARNING_RE = /^(?:warn(?:ing)?)\b|\bWARN\b|\[warn\]/i;

/**
 * Classify terminal output lines into structured errors.
 * Returns deduplicated errors, most recent first.
 */
export function classifyTerminalErrors(lines: string[]): TerminalError[] {
  const now = Date.now();
  const errors: TerminalError[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let error: TerminalError | null = null;

    // TypeScript errors (standard format)
    let m = TS_ERROR_RE.exec(line);
    if (m) {
      error = { type: 'typescript', message: m[3], file: m[1], line: parseInt(m[2], 10), timestamp: now };
    }

    // TypeScript errors (Next.js/webpack format)
    if (!error) {
      m = TS_ERROR_ALT_RE.exec(line);
      if (m) {
        error = { type: 'typescript', message: m[3], file: m[1], line: parseInt(m[2], 10), timestamp: now };
      }
    }

    // esbuild errors
    if (!error) {
      m = ESBUILD_ERROR_RE.exec(line);
      if (m) {
        error = { type: 'build', message: m[1], timestamp: now };
      }
    }

    // HMR errors
    if (!error && HMR_ERROR_RE.test(line)) {
      error = { type: 'hmr', message: line, timestamp: now };
    }

    // Vite errors
    if (!error && VITE_ERROR_RE.test(line)) {
      error = { type: 'build', message: line, timestamp: now };
    }

    // Build errors
    if (!error && BUILD_ERROR_RE.test(line)) {
      error = { type: 'build', message: line, timestamp: now };
    }

    // Runtime errors
    if (!error) {
      m = RUNTIME_ERROR_RE.exec(line);
      if (m) {
        error = { type: 'runtime', message: m[1], timestamp: now };
      }
    }
    if (!error && UNHANDLED_RE.test(line)) {
      error = { type: 'runtime', message: line, timestamp: now };
    }

    // Warnings (lower priority)
    if (!error && WARNING_RE.test(line)) {
      error = { type: 'warning', message: line, timestamp: now };
    }

    if (error) {
      // Deduplicate by message
      const key = `${error.type}:${error.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        errors.push(error);
      }
    }
  }

  return errors;
}

export function detectLocalUrls(rollingBuffer: string, preStripped = false): string[] {
  const cleaned = preStripped ? rollingBuffer : stripAnsi(rollingBuffer);

  LOCAL_URL_RE.lastIndex = 0; // reset stateful g-flag regex
  const seen = new Set<string>();
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = LOCAL_URL_RE.exec(cleaned)) !== null) {
    let url = m[0]
      .replace(/\/\/0\.0\.0\.0:/, '//localhost:')
      .replace(/\/\/127\.0\.0\.1:/, '//localhost:')
      .replace(/\/\/\[::\]:/, '//localhost:')
      .replace(/[.,;:!?]+$/, '')  // strip trailing punctuation
      .replace(/\/+$/, '');
    if (!seen.has(url)) {
      seen.add(url);
      results.push(url);
    }
  }
  return results;
}

