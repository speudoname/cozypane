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
    // M1: Require a question/prompt indicator in last 3 lines to avoid false positives
    // from numbered lists in normal output
    const hasPromptIndicator = last3.some(line => {
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
