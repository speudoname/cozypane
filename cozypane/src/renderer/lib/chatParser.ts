export type ChatMessageType = 'user' | 'assistant' | 'steps' | 'thinking' | 'system';
export type ToolType = 'read' | 'edit' | 'write' | 'bash' | 'grep' | 'glob' | 'agent' | 'other';

export interface ToolStep {
  tool: ToolType;
  detail: string;
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
  glob: 'Found files in',
  agent: 'Agent',
  other: 'Action',
};

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
    return s.detail ? `${TOOL_LABELS[s.tool]} ${shortenPath(s.detail)}` : TOOL_LABELS[s.tool];
  }
  const groups: Record<string, number> = {};
  for (const s of steps) {
    const label = TOOL_LABELS[s.tool] || 'Action';
    groups[label] = (groups[label] || 0) + 1;
  }
  const parts = Object.entries(groups).map(([label, n]) => `${label} ${n}`);
  return `${steps.length} steps: ${parts.join(', ')}`;
}

// Tool detection from raw lines
const TOOL_DETECTORS: Array<{ re: RegExp; type: ToolType; group: number }> = [
  { re: /Read\((.+?)\)/, type: 'read', group: 1 },
  { re: /Edit\((.+?)\)/, type: 'edit', group: 1 },
  { re: /Write\((.+?)\)/, type: 'write', group: 1 },
  { re: /Bash\((.+?)\)/, type: 'bash', group: 1 },
  { re: /Bash\s+(.+)/, type: 'bash', group: 1 },
  { re: /Grep\((.+?)\)/, type: 'grep', group: 1 },
  { re: /Glob\((.+?)\)/, type: 'glob', group: 1 },
  { re: /Agent\(/, type: 'agent', group: 0 },
];

function extractToolSteps(rawText: string): ToolStep[] {
  const steps: ToolStep[] = [];
  const lines = rawText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    for (const { re, type, group } of TOOL_DETECTORS) {
      const m = re.exec(trimmed);
      if (m) {
        steps.push({ tool: type, detail: group > 0 && m[group] ? m[group] : '' });
        break;
      }
    }
  }
  return steps;
}

/**
 * ChatParser v4: LLM-powered formatting.
 *
 * Strategy:
 * - Accumulate ALL raw terminal output between user input and next prompt
 * - Extract tool steps from the raw text (pattern matching — fast, no LLM)
 * - Send the raw blob to Haiku to extract and format Claude's actual response
 * - Show "thinking..." while LLM processes, then replace with clean markdown
 * - Falls back to raw text extraction if no API key
 */
export class ChatParser {
  private messages: ChatMessage[] = [];
  private nextId = 1;
  private listeners: Set<() => void> = new Set();

  // Stream accumulation
  private rawBuffer = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private state: 'idle' | 'accumulating' = 'idle';
  private currentThinkingId: number | null = null;

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
    // Start accumulating the response
    this.rawBuffer = '';
    this.state = 'accumulating';

    this.messages.push({
      id: this.nextId++,
      type: 'user',
      content: text,
      timestamp: Date.now(),
    });

    // Safety: force-process after 30s even if data keeps streaming
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.maxWaitTimer = setTimeout(() => this.checkComplete(), 30000);

    // Add thinking indicator
    this.currentThinkingId = this.nextId++;
    this.messages.push({
      id: this.currentThinkingId,
      type: 'thinking',
      content: 'Working...',
      timestamp: Date.now(),
      isStreaming: true,
    });

    this.notify();
  }

  // Called with raw stripped text from the terminal
  feedRawText(text: string) {
    if (this.state !== 'accumulating') {
      // Check if Claude started responding (detect user prompt echo)
      if (/\u276F/.test(text) && this.state === 'idle') {
        // This might be the prompt showing — start accumulating on next real output
        return;
      }
      return;
    }

    this.rawBuffer += text;

    // Check if response is complete (Claude prompt ❯ at end of buffer)
    // Use a timer to detect "settled" state — no new data for 1.5s + prompt visible
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.checkComplete(), 1500);
  }

  private async checkComplete() {
    // Silence detected (1.5s) or max-wait (30s) — process whatever we have.
    if (this.maxWaitTimer) { clearTimeout(this.maxWaitTimer); this.maxWaitTimer = null; }
    if (!this.rawBuffer || this.rawBuffer.trim().length < 5) return;

    const rawText = this.rawBuffer;
    this.rawBuffer = '';
    this.state = 'idle';

    // Extract tool steps (fast, pattern-based)
    const steps = extractToolSteps(rawText);

    // Remove thinking indicator
    if (this.currentThinkingId) {
      this.messages = this.messages.filter(m => m.id !== this.currentThinkingId);
      this.currentThinkingId = null;
    }

    // Add steps summary if any tools were used
    if (steps.length > 0) {
      this.messages.push({
        id: this.nextId++,
        type: 'steps',
        content: summarizeSteps(steps),
        timestamp: Date.now(),
        steps,
      });
    }

    // Try LLM formatting via Haiku
    let formattedText: string | null = null;
    try {
      const result = await window.cozyPane.chat.formatResponse(rawText);
      if (result.error) {
        console.warn('[ChatParser] LLM format error:', result.error);
      } else if (result.text && result.text !== '(no response yet)') {
        formattedText = result.text;
      }
    } catch (err) {
      console.warn('[ChatParser] LLM call failed:', err);
    }

    if (!formattedText) {
      // Fallback: basic extraction — grab lines that look like content
      formattedText = this.basicExtract(rawText);
    }

    if (formattedText && formattedText.trim()) {
      this.messages.push({
        id: this.nextId++,
        type: 'assistant',
        content: formattedText,
        timestamp: Date.now(),
      });
    }

    this.notify();
  }

  // Basic fallback extractor when LLM is unavailable
  private basicExtract(raw: string): string {
    const lines = raw.split('\n');
    const content: string[] = [];
    let inContent = false;

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty
      if (!trimmed) { if (inContent) content.push(''); continue; }
      // Skip obvious chrome
      if (this.isChrome(trimmed)) continue;
      // Detect response start (after tool calls end, before next prompt)
      if (/^[A-Z]/.test(trimmed) && trimmed.length > 20 && !this.isTool(trimmed)) {
        inContent = true;
      }
      if (inContent) {
        content.push(trimmed);
      }
    }

    // Trim trailing empty lines
    while (content.length > 0 && !content[content.length - 1].trim()) content.pop();
    return content.join('\n');
  }

  private isChrome(line: string): boolean {
    if (line.length < 3 && !/^[A-Za-z]/.test(line)) return true;
    if (/^[\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F]/.test(line)) return true;
    if (/^[✢✳✶✻✽⏺◐◑◒◓⏵]/.test(line)) return true;
    if (/^\u2500{2,}/.test(line)) return true;
    if (/^[╭╰╮╯│├┤]/.test(line)) return true;
    if (/\u276F\s*$/.test(line)) return true;
    if (/bypass permissions/i.test(line)) return true;
    if (/Opus\s*4|Sonnet\s*4|Haiku\s*4/.test(line)) return true;
    if (/^\s*\(main\)\s*\|/.test(line)) return true;
    if (/Tokens:|Cost:|Duration:|Session:|Model:|Context:/.test(line)) return true;
    if (/You've used \d+%/.test(line)) return true;
    if (/^\[[\d;?]*[a-zA-Z]/.test(line)) return true;
    if (/^ClaudeCode/.test(line)) return true;
    if (/^▐▛|^▝▜|^▘▘/.test(line)) return true;
    if (/^Burrowing|^Transfiguring|^Thinking/i.test(line)) return true;
    return false;
  }

  private isTool(line: string): boolean {
    return TOOL_DETECTORS.some(({ re }) => re.test(line));
  }

  clear() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.messages = [];
    this.rawBuffer = '';
    this.state = 'idle';
    this.currentThinkingId = null;
    this.flushTimer = null;
    this.maxWaitTimer = null;
    this.nextId = 1;
    this.notify();
  }
}
