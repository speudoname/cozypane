export type ChatMessageType = 'user' | 'assistant' | 'steps' | 'error' | 'system';
export type ToolType = 'read' | 'edit' | 'write' | 'bash' | 'grep' | 'glob' | 'thinking' | 'agent' | 'other';

export interface ToolStep {
  tool: ToolType;
  detail: string;
  output: string;
}

export interface ChatMessage {
  id: number;
  type: ChatMessageType;
  content: string;
  timestamp: number;
  steps?: ToolStep[];
  isStreaming?: boolean;
}

const TOOL_LABELS: Record<ToolType, string> = {
  read: 'Read',
  edit: 'Edited',
  write: 'Created',
  bash: 'Ran',
  grep: 'Searched',
  glob: 'Found files',
  thinking: 'Thinking',
  agent: 'Agent',
  other: 'Action',
};

// Patterns for Claude Code TUI chrome — these are NOT content
const CHROME_PATTERNS = [
  /^[\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F]/,  // braille spinners
  /^[✢✳✶✻✽⏺◐◑◒◓]/,                    // claude thinking spinners
  /^\u2500{2,}/,                          // horizontal rules ───
  /^[╭╰╮╯│├┤┬┴┼]/,                       // box drawing
  /^\u276F\s*$/,                          // bare Claude prompt ❯
  /^[\u23F5\u23F9\u23EF]/,               // play/stop/pause symbols
  /^\s*bypass permissions/i,              // permission mode indicator
  /^\s*shift\+tab to cycle/i,
  /^\s*\(main\)\s*\|/,                   // git branch | model status line
  /Opus\s*4|Sonnet\s*4|Haiku\s*4/,       // model name in status
  /^\s*\d+M context/,                    // context indicator
  /^\s*default\s*$/,                     // "default" mode label
  /^\s*medium\s*$/,                      // effort level
  /^\/effort/,                           // slash commands in status
  /^\s*MCP server/,                      // MCP status
  /You've used \d+%/,                    // usage limit
  /resets?\s+\w+\s+\d+/,                // reset date
  /^\[[\d;?]*[a-zA-Z]/,                 // raw ANSI escapes that leaked
  /^\[>\d+[a-zA-Z]/,                    // more ANSI
  /^Tokens:/,
  /^Cost:/,
  /^Duration:/,
  /^Session:/,
  /^Model:/,
  /^Context:/,
  /^Input tokens/,
  /^Output tokens/,
  /^\s*\([\d.]+ tokens/,
  /^\s*Updated\s+\d+\s+file/,           // tool result summaries
  /^\s*Created\s+.+successfully/,
  /^\d+ results?\s*$/,                   // search result counts
  /^\s*⏵⏵/,                             // double play indicators
  /^▐▛|^▝▜|^▘▘/,                        // Claude logo block chars
  /^ClaudeCode\s*v/,                     // version string
  /^\s*·\s*$/,                           // lone dot separator
];

// Tool detection patterns (applied to complete lines)
const TOOL_DETECTORS: Array<{ re: RegExp; type: ToolType; group: number }> = [
  { re: /^Read\((.+)\)/, type: 'read', group: 1 },
  { re: /^Edit\((.+)\)/, type: 'edit', group: 1 },
  { re: /^Write\((.+)\)/, type: 'write', group: 1 },
  { re: /^Bash\((.+)\)/, type: 'bash', group: 1 },
  { re: /^Bash\s+(.+)/, type: 'bash', group: 1 },
  { re: /^Grep\((.+)\)/, type: 'grep', group: 1 },
  { re: /^Glob\((.+)\)/, type: 'glob', group: 1 },
  { re: /^Agent\(/, type: 'agent', group: 0 },
  { re: /^TaskCreate/, type: 'other', group: 0 },
  { re: /^TaskUpdate/, type: 'other', group: 0 },
];

// Thinking/working indicators
const THINKING_PATTERNS = [
  /Burrowing/i,
  /Thinking/i,
  /Transfiguring/i,
  /Considering/i,
  /Reflecting/i,
  /Analyzing/i,
  /Processing/i,
  /Generating/i,
  /Composing/i,
  /Searching/i,
  /Planning/i,
  /Reviewing/i,
  /Investigating/i,
];

function shortenPath(p: string): string {
  const clean = p.replace(/['"]/g, '').trim();
  const parts = clean.split('/');
  if (parts.length <= 2) return parts.join('/');
  return '.../' + parts.slice(-2).join('/');
}

export function summarizeSteps(steps: ToolStep[]): string {
  if (steps.length === 0) return '';
  if (steps.length === 1) {
    const s = steps[0];
    const label = TOOL_LABELS[s.tool] || 'Action';
    return s.detail ? `${label} ${shortenPath(s.detail)}` : label;
  }
  const groups: Record<string, { count: number; details: string[] }> = {};
  for (const s of steps) {
    const label = TOOL_LABELS[s.tool] || 'Action';
    if (!groups[label]) groups[label] = { count: 0, details: [] };
    groups[label].count++;
    if (s.detail) groups[label].details.push(shortenPath(s.detail));
  }
  const parts = Object.entries(groups).map(([label, g]) => {
    if (g.count === 1 && g.details[0]) return `${label} ${g.details[0]}`;
    return `${label} ${g.count} file${g.count > 1 ? 's' : ''}`;
  });
  return `${steps.length} steps: ${parts.join(', ')}`;
}

export class ChatParser {
  private messages: ChatMessage[] = [];
  private currentAssistant: ChatMessage | null = null;
  private currentSteps: ToolStep[] = [];
  private currentTool: { type: ToolType; detail: string } | null = null;
  private currentToolOutput: string[] = [];
  private pendingStepsId: number | null = null;
  private nextId = 1;
  private listeners: Set<() => void> = new Set();
  private state: 'idle' | 'assistant' | 'tool' | 'thinking' = 'idle';

  // Stream buffering: accumulate raw stripped text, process on flush
  private streamBuffer = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_DELAY = 600; // ms to wait before processing

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  addUserMessage(text: string) {
    this.flush(); // process any pending buffer
    this.flushSteps();
    this.finishAssistant();
    this.messages.push({
      id: this.nextId++,
      type: 'user',
      content: text,
      timestamp: Date.now(),
    });
    this.state = 'assistant';
    this.notify();
  }

  // Called with raw stripped text chunks (may be partial lines)
  feedRawText(text: string) {
    this.streamBuffer += text;
    // Reset flush timer on each new chunk
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), this.FLUSH_DELAY);
  }

  // Process buffered text
  private flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.streamBuffer) return;

    const text = this.streamBuffer;
    this.streamBuffer = '';

    // Split into lines, filter empty
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (const line of lines) {
      this.processLine(line);
    }
    this.notify();
  }

  private processLine(line: string) {
    // Filter TUI chrome
    if (this.isChrome(line)) return;

    // Detect thinking indicators
    if (this.isThinking(line)) {
      if (this.state !== 'thinking') {
        this.saveCurrentTool();
        this.state = 'thinking';
        // Show a subtle thinking indicator
        if (!this.currentAssistant || this.currentAssistant.type !== 'assistant' || !this.currentAssistant.isStreaming) {
          this.finishAssistant();
        }
      }
      return;
    }

    // Detect tool use
    const toolMatch = this.detectTool(line);
    if (toolMatch) {
      this.saveCurrentTool();
      this.finishAssistant();
      this.currentTool = toolMatch;
      this.currentToolOutput = [];
      this.state = 'tool';
      return;
    }

    // Detect Claude prompt — end of turn
    if (/\u276F\s*$/.test(line)) {
      this.saveCurrentTool();
      this.flushSteps();
      this.finishAssistant();
      this.state = 'idle';
      return;
    }

    // In tool state — accumulate output
    if (this.state === 'tool') {
      this.currentToolOutput.push(line);
      return;
    }

    // Skip if still idle and looks like shell prompt
    if (this.state === 'idle' && /[\w~\/.][$%#]\s*$/.test(line)) return;

    // Content line — this is Claude's actual response
    // Flush pending tools first
    if (this.currentSteps.length > 0 || this.currentTool) {
      this.saveCurrentTool();
      this.flushSteps();
    }

    // Accumulate into assistant message
    if (this.state === 'thinking') this.state = 'assistant';
    if (this.state !== 'assistant') this.state = 'assistant';

    if (!this.currentAssistant || !this.currentAssistant.isStreaming) {
      this.currentAssistant = {
        id: this.nextId++,
        type: 'assistant',
        content: line,
        timestamp: Date.now(),
        isStreaming: true,
      };
      this.messages.push(this.currentAssistant);
    } else {
      this.currentAssistant.content += '\n' + line;
    }
  }

  private isChrome(line: string): boolean {
    for (const p of CHROME_PATTERNS) {
      if (p.test(line)) return true;
    }
    // Short fragments (< 3 chars) that aren't meaningful
    if (line.length < 3 && !/^[A-Za-z]/.test(line)) return true;
    return false;
  }

  private isThinking(line: string): boolean {
    for (const p of THINKING_PATTERNS) {
      if (p.test(line)) return true;
    }
    return false;
  }

  private detectTool(line: string): { type: ToolType; detail: string } | null {
    for (const { re, type, group } of TOOL_DETECTORS) {
      const m = re.exec(line);
      if (m) return { type, detail: group > 0 && m[group] ? m[group] : '' };
    }
    return null;
  }

  private saveCurrentTool() {
    if (this.currentTool) {
      this.currentSteps.push({
        tool: this.currentTool.type,
        detail: this.currentTool.detail,
        output: this.currentToolOutput.join('\n'),
      });
      this.currentTool = null;
      this.currentToolOutput = [];
      this.updateStepsMessage();
    }
  }

  private updateStepsMessage() {
    if (this.pendingStepsId !== null) {
      const msg = this.messages.find(m => m.id === this.pendingStepsId);
      if (msg) {
        msg.steps = [...this.currentSteps];
        msg.content = summarizeSteps(this.currentSteps);
        msg.isStreaming = true;
      }
    } else {
      const msg: ChatMessage = {
        id: this.nextId++,
        type: 'steps',
        content: summarizeSteps(this.currentSteps),
        timestamp: Date.now(),
        steps: [...this.currentSteps],
        isStreaming: true,
      };
      this.messages.push(msg);
      this.pendingStepsId = msg.id;
    }
  }

  private flushSteps() {
    if (this.pendingStepsId !== null) {
      const msg = this.messages.find(m => m.id === this.pendingStepsId);
      if (msg) {
        msg.isStreaming = false;
        msg.content = summarizeSteps(this.currentSteps);
        msg.steps = [...this.currentSteps];
      }
    }
    this.currentSteps = [];
    this.pendingStepsId = null;
  }

  private finishAssistant() {
    if (this.currentAssistant) {
      this.currentAssistant.isStreaming = false;
      // Clean up the content — remove leading/trailing blank lines
      this.currentAssistant.content = this.currentAssistant.content
        .split('\n')
        .filter((l, i, arr) => {
          // Remove blank lines at start and end
          if (i === 0 && !l.trim()) return false;
          if (i === arr.length - 1 && !l.trim()) return false;
          return true;
        })
        .join('\n');
      // If content is empty after cleanup, remove the message
      if (!this.currentAssistant.content.trim()) {
        this.messages = this.messages.filter(m => m.id !== this.currentAssistant!.id);
      }
    }
    this.currentAssistant = null;
  }

  clear() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.messages = [];
    this.currentAssistant = null;
    this.currentSteps = [];
    this.currentTool = null;
    this.currentToolOutput = [];
    this.pendingStepsId = null;
    this.state = 'idle';
    this.streamBuffer = '';
    this.flushTimer = null;
    this.nextId = 1;
    this.notify();
  }
}
