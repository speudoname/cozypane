export type ChatMessageType = 'user' | 'assistant' | 'steps' | 'error' | 'system';
export type ToolType = 'read' | 'edit' | 'write' | 'bash' | 'grep' | 'glob' | 'thinking' | 'agent' | 'other';

export interface ToolStep {
  tool: ToolType;
  detail: string; // file path or command
  output: string; // raw output (for expand)
}

export interface ChatMessage {
  id: number;
  type: ChatMessageType;
  content: string;
  timestamp: number;
  steps?: ToolStep[]; // only for type === 'steps'
  isStreaming?: boolean;
}

// Patterns that indicate noise — filtered entirely
const NOISE_PATTERNS = [
  /^[\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F]/,  // braille spinners
  /^\u2500{3,}$/,                    // horizontal rules
  /^\.{3,}$/,                        // dots
  /^\s*\d+\s*[|│]\s*$/,             // empty table rows
  /^╭|^╰|^│\s*$/,                   // box drawing borders
  /^\s*$/,                           // blank
  /^>\s*$/,                          // empty blockquote
  /^\u276F\s*$/,                     // Claude prompt
  /[\w~\/.][$%#]\s*$/,              // shell prompt
  /^⎿\s*$/,                         // Claude continuation marker alone
  /^\s*⎿\s*$/,
  /^Updated\s+\d+\s+file/,          // tool result summaries (Edit result)
  /^Created\s+.+successfully/,       // Write result
  /^\d+ result/,                     // search result counts
  /^Tokens:/,                        // token counts
  /^Cost:/,                          // cost display
  /^Duration:/,                      // duration display
  /^Session:/,                       // session info
  /^Model:/,                         // model info
  /^Context:/,                       // context info
  /^Input tokens/,                   // token metrics
  /^Output tokens/,
  /^\s*\([\d.]+ tokens/,            // inline token counts
];

// Tool detection patterns
const TOOL_PATTERNS: Array<{ re: RegExp; type: ToolType; group: number }> = [
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
  { re: /^TodoWrite/, type: 'other', group: 0 },
];

const TOOL_LABELS: Record<ToolType, string> = {
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  bash: 'Ran',
  grep: 'Searched',
  glob: 'Found files',
  thinking: 'Thinking',
  agent: 'Agent',
  other: 'Action',
};

function summarizeSteps(steps: ToolStep[]): string {
  if (steps.length === 0) return '';
  if (steps.length === 1) {
    const s = steps[0];
    const label = TOOL_LABELS[s.tool] || 'Action';
    return s.detail ? `${label} ${shortenPath(s.detail)}` : label;
  }
  // Group by tool type and count
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

function shortenPath(p: string): string {
  // Show just filename or last 2 segments
  const parts = p.replace(/['"]/g, '').split('/');
  if (parts.length <= 2) return parts.join('/');
  return '.../' + parts.slice(-2).join('/');
}

export { summarizeSteps };

export class ChatParser {
  private messages: ChatMessage[] = [];
  private currentMessage: ChatMessage | null = null;
  private currentSteps: ToolStep[] = [];
  private currentToolOutput: string[] = [];
  private currentTool: { type: ToolType; detail: string } | null = null;
  private nextId = 1;
  private listeners: Set<() => void> = new Set();
  private state: 'idle' | 'assistant' | 'tool' = 'idle';
  private pendingStepsId: number | null = null;

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
    this.flushSteps();
    this.finishCurrent();
    this.messages.push({
      id: this.nextId++,
      type: 'user',
      content: text,
      timestamp: Date.now(),
    });
    this.state = 'assistant';
    this.notify();
  }

  processLines(lines: string[]) {
    for (const line of lines) {
      this.processLine(line);
    }
    this.notify();
  }

  private processLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Filter noise
    if (this.isNoise(trimmed)) return;

    // Detect tool use
    const toolMatch = this.detectTool(trimmed);
    if (toolMatch) {
      // Save previous tool step if any
      this.saveCurrentTool();
      // Finish any assistant message
      this.finishCurrent();
      this.currentTool = toolMatch;
      this.currentToolOutput = [];
      this.state = 'tool';
      return;
    }

    // Detect Claude prompt (idle) -- end of turn
    if (/\u276F\s*$/.test(trimmed)) {
      this.saveCurrentTool();
      this.flushSteps();
      this.finishCurrent();
      this.state = 'idle';
      return;
    }

    // In tool state -- accumulate tool output (silently, for expand)
    if (this.state === 'tool') {
      this.currentToolOutput.push(trimmed);
      return;
    }

    // Assistant prose -- only show meaningful text
    if (this.state === 'assistant' || this.state === 'idle') {
      // Flush any pending tool steps before assistant text
      if (this.currentSteps.length > 0) {
        this.saveCurrentTool();
        this.flushSteps();
      }

      if (!this.currentMessage || this.currentMessage.type !== 'assistant') {
        this.finishCurrent();
        this.currentMessage = {
          id: this.nextId++,
          type: 'assistant',
          content: trimmed,
          timestamp: Date.now(),
          isStreaming: true,
        };
        this.messages.push(this.currentMessage);
        this.state = 'assistant';
      } else {
        this.currentMessage.content += '\n' + trimmed;
      }
    }
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
      // Update or create the steps message
      this.updateStepsMessage();
    }
  }

  private updateStepsMessage() {
    if (this.pendingStepsId !== null) {
      // Update existing steps message
      const msg = this.messages.find(m => m.id === this.pendingStepsId);
      if (msg) {
        msg.steps = [...this.currentSteps];
        msg.content = summarizeSteps(this.currentSteps);
        msg.isStreaming = true;
      }
    } else {
      // Create new steps message
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

  private finishCurrent() {
    if (this.currentMessage) {
      this.currentMessage.isStreaming = false;
    }
    this.currentMessage = null;
  }

  private detectTool(line: string): { type: ToolType; detail: string } | null {
    for (const { re, type, group } of TOOL_PATTERNS) {
      const m = re.exec(line);
      if (m) return { type, detail: group > 0 && m[group] ? m[group] : '' };
    }
    return null;
  }

  private isNoise(line: string): boolean {
    for (const p of NOISE_PATTERNS) {
      if (p.test(line)) return true;
    }
    return false;
  }

  clear() {
    this.messages = [];
    this.currentMessage = null;
    this.currentSteps = [];
    this.currentToolOutput = [];
    this.currentTool = null;
    this.state = 'idle';
    this.pendingStepsId = null;
    this.nextId = 1;
    this.notify();
  }
}
