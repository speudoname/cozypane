// Chat Mode v5 facade.
//
// This module used to own the blob-then-Haiku parser. It's now a thin
// wrapper around StreamTokenizer kept for backward compatibility with
// Terminal.tsx (which calls `feedRawText` and `addUserMessage`).
//
// All rendering logic lives in the components that subscribe to the
// tokenizer's event stream (see ChatView.tsx).

import { StreamTokenizer } from './chatStream';
import type { ChatEvent } from './chatEvents';

export type { ChatEvent } from './chatEvents';
export type ToolType =
  | 'read' | 'edit' | 'write' | 'bash' | 'grep' | 'glob'
  | 'webfetch' | 'websearch' | 'agent' | 'todo' | 'notebook' | 'mcp' | 'other';

// Kept exported for any stale callers; messages are now event-driven.
export interface ChatMessage {
  id: number;
  type: 'user' | 'assistant' | 'steps' | 'thinking' | 'system';
  content: string;
  timestamp: number;
  isStreaming?: boolean;
}

export class ChatParser {
  private tokenizer = new StreamTokenizer();

  feedRawText(text: string): void {
    this.tokenizer.feedRaw(text);
  }

  addUserMessage(text: string): void {
    this.tokenizer.onUserInput(text);
  }

  subscribe(fn: (e: ChatEvent) => void): () => void {
    return this.tokenizer.subscribe(fn);
  }

  /** Legacy no-op — messages are now events. */
  getMessages(): ChatMessage[] { return []; }

  clear(): void { this.tokenizer.clear(); }

  /** Forces buffered input to be processed now (useful for tests). */
  flush(): void { this.tokenizer.flush(); }

  /** Exposed so components can read the latest status on mount. */
  getLastStatus() { return this.tokenizer.getLastStatus(); }
}
