import React, { useEffect, useMemo, useRef, useState } from 'react';
import { User, Bot, Loader2, CircleAlert, Info, MessageSquare } from 'lucide-react';
import type { ChatParser } from '../lib/chatParser';
import type { ChatEvent, Status, ToolType, ToolMeta, InteractivePrompt } from '../lib/chatEvents';
import { renderMarkdown } from '../lib/chatMarkdown';
import ChatStatusBar from './ChatStatusBar';
import ChatStepCard from './ChatStepCard';
import ChatInteractivePrompt from './ChatInteractivePrompt';
import ChatPlanProposal from './ChatPlanProposal';

interface Props {
  parser: ChatParser;
  fontSize?: number;
  onShiftTab?: () => void;
  onPromptResponse?: (text: string) => void;
}

// Timeline items the ChatView renders.
type Item =
  | { kind: 'user'; id: string; text: string; turnId: number }
  | { kind: 'prose'; id: string; turnId: number; text: string }
  | { kind: 'step'; id: string; toolId: string; tool: ToolType; detail: string; output?: string; meta?: ToolMeta; error?: boolean; streaming?: boolean; turnId: number }
  | { kind: 'plan'; id: string; plan: string }
  | { kind: 'error'; id: string; message: string; severity: 'warn' | 'error' }
  | { kind: 'system'; id: string; text: string };

export default function ChatView({ parser, fontSize = 13, onShiftTab, onPromptResponse }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState<Status>(() => parser.getLastStatus());
  const [activePrompt, setActivePrompt] = useState<InteractivePrompt | null>(null);
  const [thinking, setThinking] = useState<string | null>(null);

  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  const bottomRef = useRef<HTMLDivElement>(null);
  const idCounter = useRef(0);
  const mkId = () => `i-${++idCounter.current}`;

  useEffect(() => {
    const handle = (e: ChatEvent) => {
      switch (e.kind) {
        case 'user-input':
          setItems(prev => [...prev, { kind: 'user', id: mkId(), text: e.text, turnId: e.turnId }]);
          setActivePrompt(null);
          break;
        case 'prose-chunk':
          setItems(prev => {
            const last = prev[prev.length - 1];
            if (last && last.kind === 'prose' && last.turnId === e.turnId) {
              const next = prev.slice(0, -1);
              next.push({ ...last, text: last.text + e.text });
              return next;
            }
            return [...prev, { kind: 'prose', id: mkId(), turnId: e.turnId, text: e.text }];
          });
          setThinking(null);
          break;
        case 'prose-end':
          // No-op — the bubble stays as-is; marker is implicit.
          break;
        case 'tool-start':
          setItems(prev => [
            ...prev,
            { kind: 'step', id: mkId(), toolId: e.id, tool: e.tool, detail: e.detail, streaming: true, turnId: e.turnId },
          ]);
          setThinking(null);
          break;
        case 'tool-result':
          setItems(prev => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              const it = next[i];
              if (it.kind === 'step' && it.toolId === e.id) {
                next[i] = { ...it, output: e.output, meta: e.meta, error: e.error, streaming: false };
                break;
              }
            }
            return next;
          });
          break;
        case 'thinking-start':
          setThinking(e.label || 'Thinking…');
          break;
        case 'thinking-end':
          setThinking(null);
          break;
        case 'status':
          setStatus(e.status);
          break;
        case 'interactive-prompt':
          setActivePrompt(e.prompt);
          break;
        case 'plan-proposal':
          setItems(prev => [...prev, { kind: 'plan', id: mkId(), plan: e.plan }]);
          break;
        case 'error':
          setItems(prev => [...prev, { kind: 'error', id: mkId(), message: e.message, severity: e.severity }]);
          break;
        case 'system-message':
          setItems(prev => [...prev, { kind: 'system', id: mkId(), text: e.text }]);
          break;
        case 'turn-complete':
          setThinking(null);
          break;
      }
    };
    const unsub = parser.subscribe(handle);
    return unsub;
  }, [parser]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items, thinking, activePrompt]);

  const hasContent = items.length > 0 || thinking || activePrompt;

  return (
    <div className="chat-view-v5" style={{ fontSize }}>
      <ChatStatusBar status={status} onShiftTab={onShiftTab} />

      <div className="chat-view">
        {!hasContent && (
          <div className="chat-empty">
            <MessageSquare size={28} />
            <div>Chat mode active. Your conversation will appear here.</div>
            <div style={{ fontSize: '0.8em', marginTop: 4, opacity: 0.6 }}>
              Events stream in real time — tools, prose, prompts.
            </div>
          </div>
        )}

        {items.map(item => (
          <ChatItem key={item.id} item={item} />
        ))}

        {thinking && (
          <div className="chat-thinking chat-thinking-live">
            <Loader2 size={14} className="spin" />
            <span className="chat-thinking-text">{thinking}</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {activePrompt && onPromptResponse && (
        <ChatInteractivePrompt
          prompt={activePrompt}
          onRespond={text => { onPromptResponse(text); setActivePrompt(null); }}
        />
      )}
    </div>
  );
}

function ChatItem({ item }: { item: Item }) {
  if (item.kind === 'user') {
    return (
      <div className="chat-msg chat-msg-user">
        <div className="chat-bubble chat-bubble-user">
          <div className="chat-bubble-avatar"><User size={14} /></div>
          <div className="chat-bubble-content">{item.text}</div>
        </div>
      </div>
    );
  }
  if (item.kind === 'prose') {
    return (
      <div className="chat-msg chat-msg-assistant">
        <div className="chat-bubble chat-bubble-assistant">
          <div className="chat-bubble-avatar"><Bot size={14} /></div>
          <div className="chat-bubble-content chat-markdown">
            {renderMarkdown(item.text)}
          </div>
        </div>
      </div>
    );
  }
  if (item.kind === 'step') {
    return (
      <div className="chat-msg chat-msg-step">
        <ChatStepCard
          tool={item.tool}
          detail={item.detail}
          output={item.output}
          meta={item.meta}
          error={item.error}
          streaming={item.streaming}
        />
      </div>
    );
  }
  if (item.kind === 'plan') {
    return (
      <div className="chat-msg chat-msg-plan">
        <ChatPlanProposal
          plan={item.plan}
          onApprove={() => {}}
          onRevise={() => {}}
          onCancel={() => {}}
        />
      </div>
    );
  }
  if (item.kind === 'error') {
    return (
      <div className={`chat-msg chat-msg-error chat-error-${item.severity}`}>
        <CircleAlert size={14} />
        <span>{item.message}</span>
      </div>
    );
  }
  if (item.kind === 'system') {
    return (
      <div className="chat-msg chat-msg-system">
        <Info size={12} />
        <span>{item.text}</span>
      </div>
    );
  }
  return null;
}
