// StreamTokenizer — Chat Mode v5 state machine.
//
// Converts raw (ANSI-stripped) terminal text into a stream of typed
// ChatEvents. Callers subscribe via `subscribe(fn)` and feed text via
// `feedRaw(text)`. User-typed messages are announced via `onUserInput(text)`
// which bumps the turn counter.
//
// The tokenizer runs in two modes:
//   - idle — no active tool, lines are prose or chrome
//   - in-tool — a `⏺ Tool(args)` line was seen; subsequent lines up to the
//               next tool marker / prompt are collected as tool output
//
// Status lines, interactive prompts, plan proposals, and thinking spinners
// are detected on every processed line regardless of state.

import { decideFocus } from './terminalAnalyzer';
import type { ChatEvent, Status, ToolType, InteractivePrompt } from './chatEvents';
import {
  parseStatusLine,
  parsePermissionLine,
  parseUsageLine,
  parseMcpLine,
} from './chatStatus';
import {
  detectTool,
  parseBashResult,
  parseEditResult,
  parseGrepResult,
  parseReadResult,
} from './chatToolRenderers';

type State = 'idle' | 'in-tool' | 'thinking';

interface CurrentTool {
  id: string;
  tool: ToolType;
  name: string;
  detail: string;
  output: string[];
  turnId: number;
}

// Braille spinner + Claude Code "thinking" verbs.
const SPINNER_RE = /[\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F]/;
const THINKING_WORDS_RE =
  /^(Burrowing|Transfiguring|Thinking|Considering|Pondering|Musing|Contemplating|Reflecting|Analyzing|Working|Cogitating|Deliberating)[.…]*$/i;

// Tool result close marker.
const TOOL_RESULT_CLOSE_RE = /^\s*[\u23BF\u2570\u2514\u23BF]/; // ⎿ and friends

// Prompt at the bottom of Claude Code.
const CLAUDE_PROMPT_RE = /\u276F\s*$/;

// Chrome that should never become prose.
function isChrome(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (/^[\u2500\u2501]{2,}/.test(t)) return true;
  if (/^[\u2500-\u257F]/.test(t)) return true;      // box drawing
  if (/^[\u2580-\u259F]/.test(t)) return true;      // block elements
  if (SPINNER_RE.test(t) && t.length < 40) return true;
  if (/^\[[\d;?]*[a-zA-Z]/.test(t)) return true;
  if (CLAUDE_PROMPT_RE.test(t)) return true;
  if (/^>\s*$/.test(t)) return true;
  return false;
}

export class StreamTokenizer {
  private buffer = '';
  private state: State = 'idle';
  private currentTool: CurrentTool | null = null;
  private currentProseTurn: number | null = null;
  private inProse = false;
  private listeners: Set<(e: ChatEvent) => void> = new Set();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private turnCounter = 0;
  private toolCounter = 0;
  private lastStatus: Status = {};
  private planBuffer: string[] | null = null;

  subscribe(fn: (e: ChatEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(e: ChatEvent) {
    for (const fn of this.listeners) fn(e);
  }

  feedRaw(text: string): void {
    this.buffer += text;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.processBuffer(), 200);
  }

  onUserInput(text: string): void {
    this.turnCounter += 1;
    this.currentProseTurn = this.turnCounter;
    this.inProse = false;
    this.emit({ kind: 'user-input', text, turnId: this.turnCounter });
  }

  /** Forces any buffered text to be processed now. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.processBuffer();
  }

  clear(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.buffer = '';
    this.state = 'idle';
    this.currentTool = null;
    this.currentProseTurn = null;
    this.inProse = false;
    this.planBuffer = null;
    this.turnCounter = 0;
    this.toolCounter = 0;
    this.lastStatus = {};
  }

  getLastStatus(): Status {
    return { ...this.lastStatus };
  }

  private nextToolId(): string {
    this.toolCounter += 1;
    return `tool-${this.toolCounter}`;
  }

  // --- buffer processing ----------------------------------------------

  private processBuffer(): void {
    this.flushTimer = null;
    if (!this.buffer) return;

    // Keep incomplete trailing line in the buffer for next round.
    const newlineIdx = this.buffer.lastIndexOf('\n');
    if (newlineIdx === -1) return; // wait for a complete line
    const processable = this.buffer.slice(0, newlineIdx + 1);
    this.buffer = this.buffer.slice(newlineIdx + 1);

    const lines = processable.split('\n');
    // last split entry after trailing \n is always "", drop it
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    // Update status from the whole chunk first so UI gets latest info fast.
    this.updateStatusFromLines(lines);

    for (const rawLine of lines) {
      this.processLine(rawLine);
    }
  }

  private updateStatusFromLines(lines: string[]): void {
    const delta: Partial<Status> = {};
    for (const line of lines) {
      const s = parseStatusLine(line);
      if (s) Object.assign(delta, s);
      const p = parsePermissionLine(line);
      if (p) Object.assign(delta, p);
      const u = parseUsageLine(line);
      if (u) Object.assign(delta, u);
      const mcp = parseMcpLine(line);
      if (mcp) Object.assign(delta, mcp);
    }
    if (Object.keys(delta).length > 0) {
      this.lastStatus = { ...this.lastStatus, ...delta };
      this.emit({ kind: 'status', status: { ...this.lastStatus } });
    }
  }

  private processLine(line: string): void {
    // 1. Thinking indicator
    const trimmed = line.trim();
    if (SPINNER_RE.test(trimmed) || THINKING_WORDS_RE.test(trimmed)) {
      if (this.state !== 'thinking') {
        this.state = 'thinking';
        const labelMatch = THINKING_WORDS_RE.exec(trimmed);
        this.emit({ kind: 'thinking-start', label: labelMatch ? labelMatch[1] : undefined });
      }
      return;
    }
    if (this.state === 'thinking' && trimmed && !isChrome(trimmed)) {
      this.emit({ kind: 'thinking-end' });
      this.state = 'idle';
    }

    // 2. Tool start marker (⏺ ToolName(...))
    const tool = detectTool(line);
    if (tool) {
      // close any current tool first
      this.closeCurrentTool();
      // end any open prose bubble
      if (this.inProse && this.currentProseTurn !== null) {
        this.emit({ kind: 'prose-end', turnId: this.currentProseTurn });
        this.inProse = false;
      }
      const id = this.nextToolId();
      const turnId = this.currentProseTurn ?? this.turnCounter ?? 0;

      // Special-case ExitPlanMode — start buffering the plan instead of a tool.
      if (tool.name === 'ExitPlanMode') {
        this.planBuffer = [];
        this.state = 'in-tool';
        this.currentTool = {
          id,
          tool: 'other',
          name: tool.name,
          detail: tool.detail,
          output: [],
          turnId,
        };
        return;
      }

      this.currentTool = {
        id,
        tool: tool.type,
        name: tool.name,
        detail: tool.detail,
        output: [],
        turnId,
      };
      this.state = 'in-tool';
      this.emit({
        kind: 'tool-start',
        id,
        tool: tool.type,
        detail: tool.detail,
        turnId,
      });
      return;
    }

    // 3. Tool result close marker (⎿ …) — collected as output too
    if (TOOL_RESULT_CLOSE_RE.test(line) && this.currentTool) {
      this.currentTool.output.push(line);
      return;
    }

    // 4. If inside a tool, keep collecting output until blank line or prompt
    if (this.state === 'in-tool' && this.currentTool) {
      if (CLAUDE_PROMPT_RE.test(trimmed)) {
        this.closeCurrentTool();
        this.emitPromptCheck();
        this.emitTurnCompleteIfIdle();
        return;
      }
      if (this.planBuffer !== null) {
        this.planBuffer.push(line);
      } else {
        this.currentTool.output.push(line);
      }
      return;
    }

    // 5. Interactive prompt detection (reuse decideFocus heuristic)
    const prompt = this.detectInteractivePrompt([line]);
    if (prompt) {
      this.emit({ kind: 'interactive-prompt', prompt });
      return;
    }

    // 6. Claude prompt marker — turn complete
    if (CLAUDE_PROMPT_RE.test(trimmed)) {
      if (this.inProse && this.currentProseTurn !== null) {
        this.emit({ kind: 'prose-end', turnId: this.currentProseTurn });
        this.inProse = false;
      }
      this.emitTurnCompleteIfIdle();
      return;
    }

    // 7. Chrome is dropped
    if (isChrome(line)) return;

    // 8. Otherwise it's prose
    const turnId = this.currentProseTurn ?? this.turnCounter ?? 0;
    this.inProse = true;
    this.emit({ kind: 'prose-chunk', text: line + '\n', turnId });
  }

  private closeCurrentTool(): void {
    const t = this.currentTool;
    if (!t) return;
    this.currentTool = null;

    // Plan mode?
    if (this.planBuffer !== null) {
      const plan = this.planBuffer.join('\n').trim();
      this.planBuffer = null;
      this.state = 'idle';
      if (plan) this.emit({ kind: 'plan-proposal', plan });
      return;
    }

    const output = t.output.join('\n').trim();
    let meta;
    let error = false;
    switch (t.tool) {
      case 'bash': {
        const b = parseBashResult(output);
        if (typeof b.exitCode === 'number' && b.exitCode !== 0) error = true;
        meta = b;
        break;
      }
      case 'edit':
      case 'write':
        meta = parseEditResult(output, t.detail);
        break;
      case 'read':
        meta = parseReadResult(output, t.detail);
        break;
      case 'grep':
        meta = parseGrepResult(output, t.detail);
        break;
      default:
        meta = undefined;
    }
    this.emit({ kind: 'tool-result', id: t.id, output, error, meta });
    this.state = 'idle';
  }

  private emitPromptCheck(): void {
    // Placeholder: interactive prompts are detected per-line in processLine.
    // This hook exists so future contextual checks (e.g. multi-line prompts)
    // can attach here.
  }

  private emitTurnCompleteIfIdle(): void {
    if (this.currentProseTurn === null) return;
    const turnId = this.currentProseTurn;
    // Don't clear currentProseTurn — subsequent status-only updates should
    // still associate with the latest turn until the user sends a new input.
    this.emit({ kind: 'turn-complete', turnId });
  }

  private detectInteractivePrompt(lines: string[]): InteractivePrompt | null {
    const decision = decideFocus(lines);
    if (!decision.target) return null;

    const tail = lines.slice(-3).map(l => l.trim()).join('\n');

    // Y/N
    if (/\[Y\/n\]|\[y\/N\]|\(y\/n\)|\(yes\/no\)/i.test(tail)) {
      return { kind: 'yes-no', question: lines[lines.length - 1]?.trim() };
    }

    // Trust folder
    if (/trust this folder/i.test(tail)) {
      return { kind: 'trust-folder', question: lines[lines.length - 1]?.trim() };
    }

    // Password
    if (/password\s*:\s*$/i.test(tail) || /passphrase.*:\s*$/i.test(tail)) {
      return { kind: 'password' };
    }

    // Press enter / continue
    if (/press enter|press any key|enter to confirm/i.test(tail)) {
      return { kind: 'continue', question: lines[lines.length - 1]?.trim() };
    }

    // Numbered / lettered choices — decision.isChoicePrompt
    if (decision.isChoicePrompt) {
      const choices: Array<{ key: string; label: string }> = [];
      const numRe = /^\s*(\d+)[.)]\s+(.+)$/;
      const letRe = /^\s*([a-e])[.)]\s+(.+)$/i;
      let isLettered = false;
      for (const line of lines) {
        const n = numRe.exec(line);
        if (n) { choices.push({ key: n[1], label: n[2].trim() }); continue; }
        const l = letRe.exec(line);
        if (l) { choices.push({ key: l[1].toLowerCase(), label: l[2].trim() }); isLettered = true; }
      }
      if (choices.length >= 2) {
        return { kind: isLettered ? 'lettered' : 'numbered', choices };
      }
    }

    return null;
  }
}
