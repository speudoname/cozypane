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

export function detectChoicePrompt(rollingBuffer: string): boolean {
  const cleaned = stripAnsi(rollingBuffer);
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

export function analyzeAction(rollingBuffer: string, claudeRunning: boolean): AiAction {
  if (!claudeRunning) return 'idle';

  const cleaned = stripAnsi(rollingBuffer);
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

export function analyzeFocus(rollingBuffer: string): 'input' | 'terminal' | null {
  const cleaned = stripAnsi(rollingBuffer);
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

export interface CostInfo {
  cost: string | null;    // e.g. "$0.42"
  tokens: string | null;  // e.g. "12.5K tokens"
}

// Best-effort parsing of Claude Code's cost/token output from terminal buffer
export function parseCostInfo(rollingBuffer: string): CostInfo {
  const cleaned = stripAnsi(rollingBuffer);
  const lines = cleaned.split('\n').slice(-50);
  const text = lines.join('\n');

  let cost: string | null = null;
  let tokens: string | null = null;

  // Look for dollar amounts like "$0.42" or "$1.23" — take the last one found (most recent)
  const costMatches = text.match(/\$\d+\.\d{2}/g);
  if (costMatches) cost = costMatches[costMatches.length - 1];

  // Look for token counts like "12K tokens" or "1,234 tokens" or "input: 5.2K"
  const tokenMatch = text.match(/(\d[\d,.]*K?\s*tokens)/i);
  if (tokenMatch) tokens = tokenMatch[1];

  return { cost, tokens };
}
