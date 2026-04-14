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
  agent: 'Spawned agent',
  other: 'Action',
};

function shortenPath(p: string): string {
  const clean = p.replace(/['"]/g, '').trim();
  const parts = clean.split('/');
  if (parts.length <= 2) return parts.join('/');
  return '.../' + parts.slice(-2).join('/');
}

// Simple markdown renderer — handles code blocks, inline code, bold, italic, lists
function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre key={key++} className="chat-code-block">
          {lang && <div className="chat-code-lang">{lang}</div>}
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const Tag = `h${level + 1}` as keyof JSX.IntrinsicElements;
      elements.push(<Tag key={key++} className="chat-heading">{renderInline(headingMatch[2])}</Tag>);
      i++;
      continue;
    }

    // Bullet list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      elements.push(
        <ul key={key++} className="chat-list">
          {items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
        </ul>
      );
      continue;
    }

    // Numbered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      elements.push(
        <ol key={key++} className="chat-list">
          {items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
        </ol>
      );
      continue;
    }

    // Empty line = paragraph break
    if (!line.trim()) {
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(<p key={key++} className="chat-paragraph">{renderInline(line)}</p>);
    i++;
  }

  return elements;
}

// Render inline markdown: bold, italic, inline code
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Inline code
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`/);
    if (codeMatch) {
      if (codeMatch[1]) parts.push(<span key={key++}>{codeMatch[1]}</span>);
      parts.push(<code key={key++} className="chat-inline-code">{codeMatch[2]}</code>);
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }
    // Bold
    const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*/);
    if (boldMatch) {
      if (boldMatch[1]) parts.push(<span key={key++}>{boldMatch[1]}</span>);
      parts.push(<strong key={key++}>{boldMatch[2]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }
    // No more patterns — push rest as text
    parts.push(<span key={key++}>{remaining}</span>);
    break;
  }

  return parts;
}

export default function ChatView({ parser, fontSize = 13 }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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

  return (
    <div className="chat-view" ref={containerRef} style={{ fontSize }}>
      {messages.length === 0 && (
        <div className="chat-empty">
          <div className="chat-empty-icon">{'\uD83D\uDCAC'}</div>
          <div>Chat mode active. Your conversation will appear here.</div>
          <div style={{ fontSize: '0.8em', marginTop: 4, opacity: 0.6 }}>
            Responses are formatted by AI for a clean reading experience.
          </div>
        </div>
      )}
      {messages.map(msg => (
        <div key={msg.id} className={`chat-msg chat-msg-${msg.type}`}>
          {msg.type === 'user' && (
            <div className="chat-bubble chat-bubble-user">
              <div className="chat-bubble-content">{msg.content}</div>
            </div>
          )}

          {msg.type === 'thinking' && (
            <div className="chat-thinking">
              <span className="chat-thinking-dot" />
              <span className="chat-thinking-dot" />
              <span className="chat-thinking-dot" />
              <span className="chat-thinking-text">{msg.content}</span>
            </div>
          )}

          {msg.type === 'assistant' && (
            <div className="chat-bubble chat-bubble-assistant">
              <div className="chat-bubble-content chat-markdown">
                {renderMarkdown(msg.content)}
              </div>
            </div>
          )}

          {msg.type === 'steps' && msg.steps && (
            <div className="chat-steps">
              <div className="chat-steps-summary" onClick={() => toggleGroup(msg.id)}>
                <span className="chat-steps-icon">{'\u2699\uFE0F'}</span>
                <span className="chat-steps-text">{msg.content}</span>
                <span className="chat-steps-toggle">
                  {expandedGroups.has(msg.id) ? '\u25BE' : '\u25B8'}
                </span>
              </div>
              {expandedGroups.has(msg.id) && (
                <div className="chat-steps-list">
                  {msg.steps.map((step, idx) => (
                    <div key={idx} className="chat-step-item">
                      <div className="chat-step-header">
                        <span className="chat-step-icon">{TOOL_ICONS[step.tool] || TOOL_ICONS.other}</span>
                        <span className="chat-step-verb">{TOOL_VERBS[step.tool] || 'Action'}</span>
                        {step.detail && <span className="chat-step-detail">{shortenPath(step.detail)}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
