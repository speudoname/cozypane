export type ChatMessageType = 'user' | 'assistant' | 'tool' | 'error' | 'system';
export type ToolType = 'read' | 'edit' | 'write' | 'bash' | 'grep' | 'glob' | 'thinking' | 'other';

export interface ChatMessage {
  id: number;
  type: ChatMessageType;
  content: string;
  timestamp: number;
  tool?: ToolType;
  toolDetail?: string; // file path or command
  isStreaming?: boolean; // still being written to
  collapsed?: boolean;
}

export class ChatParser {
  private messages: ChatMessage[] = [];
  private currentMessage: ChatMessage | null = null;
  private nextId = 1;
  private listeners: Set<() => void> = new Set();
  private state: 'idle' | 'user_input' | 'assistant' | 'tool' = 'idle';
  private buffer: string[] = [];

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

  // Called when the user submits a command
  addUserMessage(text: string) {
    this.finishCurrent();
    this.messages.push({
      id: this.nextId++,
      type: 'user',
      content: text,
      timestamp: Date.now(),
    });
    this.state = 'assistant'; // expect assistant response next
    this.notify();
  }

  // Called with each batch of stripped terminal output lines
  processLines(lines: string[]) {
    for (const line of lines) {
      this.processLine(line);
    }
    this.notify();
  }

  private processLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Detect tool use patterns
    const toolMatch = this.detectTool(trimmed);
    if (toolMatch) {
      this.finishCurrent();
      this.currentMessage = {
        id: this.nextId++,
        type: 'tool',
        content: trimmed,
        timestamp: Date.now(),
        tool: toolMatch.type,
        toolDetail: toolMatch.detail,
        isStreaming: true,
        collapsed: true,
      };
      this.messages.push(this.currentMessage);
      this.state = 'tool';
      return;
    }

    // Detect Claude prompt (idle) -- end of response
    if (/\u276F\s*$/.test(trimmed)) {
      this.finishCurrent();
      this.state = 'idle';
      return;
    }

    // Detect shell prompt -- system message
    if (/[\w~\/.][$%#]\s*$/.test(trimmed) && this.state === 'idle') {
      // Don't add shell prompts as messages
      return;
    }

    // If we're in tool state, append to tool output
    if (this.state === 'tool' && this.currentMessage?.type === 'tool') {
      this.currentMessage.content += '\n' + trimmed;
      return;
    }

    // Assistant output -- accumulate into current assistant message
    if (this.state === 'assistant' || this.state === 'idle') {
      // Skip common noise lines
      if (this.isNoise(trimmed)) return;

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

  private finishCurrent() {
    if (this.currentMessage) {
      this.currentMessage.isStreaming = false;
    }
    this.currentMessage = null;
  }

  private detectTool(line: string): { type: ToolType; detail: string } | null {
    // Match Claude Code tool patterns
    let m;
    if ((m = /^Read\((.+)\)/.exec(line))) return { type: 'read', detail: m[1] };
    if ((m = /^Edit\((.+)\)/.exec(line))) return { type: 'edit', detail: m[1] };
    if ((m = /^Write\((.+)\)/.exec(line))) return { type: 'write', detail: m[1] };
    if ((m = /^Bash\((.+)\)/.exec(line)) || (m = /^Bash\s+(.+)/.exec(line))) return { type: 'bash', detail: m[1] };
    if ((m = /^Grep\((.+)\)/.exec(line))) return { type: 'grep', detail: m[1] };
    if ((m = /^Glob\((.+)\)/.exec(line))) return { type: 'glob', detail: m[1] };
    // Thinking indicator (braille spinner characters)
    if (/^[\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F]/.test(line)) return { type: 'thinking', detail: line };
    return null;
  }

  private isNoise(line: string): boolean {
    // Filter out progress spinners, empty prompts, repeated separators
    if (/^[\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F]\s*$/.test(line)) return true;
    if (/^\u2500{3,}$/.test(line)) return true;
    if (/^\.{3,}$/.test(line)) return true;
    return false;
  }

  clear() {
    this.messages = [];
    this.currentMessage = null;
    this.state = 'idle';
    this.buffer = [];
    this.nextId = 1;
    this.notify();
  }
}
