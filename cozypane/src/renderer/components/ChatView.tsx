import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatParser, ToolStep } from '../lib/chatParser';

interface Props {
  parser: ChatParser;
  fontSize?: number;
}

const TOOL_ICONS: Record<string, string> = {
  read: '\uD83D\uDCD6',
  edit: '\u270F\uFE0F',
  write: '\uD83D\uDCDD',
  bash: '\u26A1',
  grep: '\uD83D\uDD0D',
  glob: '\uD83D\uDCC2',
  thinking: '\uD83D\uDCAD',
  agent: '\uD83E\uDD16',
  other: '\uD83D\uDD27',
};

const TOOL_VERBS: Record<string, string> = {
  read: 'Read',
  edit: 'Edited',
  write: 'Created',
  bash: 'Ran',
  grep: 'Searched',
  glob: 'Found files in',
  thinking: 'Thinking',
  agent: 'Spawned agent',
  other: 'Action',
};

function shortenPath(p: string): string {
  const clean = p.replace(/['"]/g, '').trim();
  const parts = clean.split('/');
  if (parts.length <= 2) return parts.join('/');
  return '.../' + parts.slice(-2).join('/');
}

function StepItem({ step, expanded, onToggle }: { step: ToolStep; expanded: boolean; onToggle: () => void }) {
  const icon = TOOL_ICONS[step.tool] || TOOL_ICONS.other;
  const verb = TOOL_VERBS[step.tool] || 'Action';
  const detail = step.detail ? shortenPath(step.detail) : '';
  const hasOutput = step.output.trim().length > 0;

  return (
    <div className="chat-step-item">
      <div
        className={`chat-step-header ${hasOutput ? 'expandable' : ''}`}
        onClick={hasOutput ? onToggle : undefined}
      >
        <span className="chat-step-icon">{icon}</span>
        <span className="chat-step-verb">{verb}</span>
        {detail && <span className="chat-step-detail">{detail}</span>}
        {hasOutput && <span className="chat-step-toggle">{expanded ? '\u25BE' : '\u25B8'}</span>}
      </div>
      {expanded && hasOutput && (
        <pre className="chat-step-output">{step.output}</pre>
      )}
    </div>
  );
}

export default function ChatView({ parser, fontSize = 13 }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = parser.subscribe(() => {
      setMessages([...parser.getMessages()]);
    });
    setMessages([...parser.getMessages()]);
    return unsub;
  }, [parser]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const toggleGroup = (msgId: number) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  };

  const toggleStep = (msgId: number, stepIdx: number) => {
    const key = `${msgId}-${stepIdx}`;
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="chat-view" ref={containerRef} style={{ fontSize }}>
      {messages.length === 0 && (
        <div className="chat-empty">
          <div className="chat-empty-icon">{'\uD83D\uDCAC'}</div>
          <div>Chat mode active. Your conversation will appear here.</div>
        </div>
      )}
      {messages.map(msg => (
        <div key={msg.id} className={`chat-msg chat-msg-${msg.type}`}>
          {msg.type === 'user' && (
            <div className="chat-bubble chat-bubble-user">
              <div className="chat-bubble-content">{msg.content}</div>
            </div>
          )}

          {msg.type === 'assistant' && (
            <div className="chat-bubble chat-bubble-assistant">
              <div className="chat-bubble-content">
                {msg.content.split('\n').map((line, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <br />}
                    {line}
                  </React.Fragment>
                ))}
              </div>
              {msg.isStreaming && <span className="chat-streaming">{'\u25CF'}</span>}
            </div>
          )}

          {msg.type === 'steps' && msg.steps && (
            <div className="chat-steps">
              <div
                className="chat-steps-summary"
                onClick={() => toggleGroup(msg.id)}
              >
                <span className="chat-steps-icon">{'\u2699\uFE0F'}</span>
                <span className="chat-steps-text">{msg.content}</span>
                {msg.isStreaming && <span className="chat-streaming">{'\u25CF'}</span>}
                <span className="chat-steps-toggle">
                  {expandedGroups.has(msg.id) ? '\u25BE' : '\u25B8'}
                </span>
              </div>
              {expandedGroups.has(msg.id) && (
                <div className="chat-steps-list">
                  {msg.steps.map((step, idx) => (
                    <StepItem
                      key={idx}
                      step={step}
                      expanded={expandedSteps.has(`${msg.id}-${idx}`)}
                      onToggle={() => toggleStep(msg.id, idx)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {msg.type === 'error' && (
            <div className="chat-bubble chat-bubble-error">
              <div className="chat-bubble-content">{msg.content}</div>
            </div>
          )}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
