import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatParser } from '../lib/chatParser';

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
  other: '\uD83D\uDD27',
};

const TOOL_LABELS: Record<string, string> = {
  read: 'Reading',
  edit: 'Editing',
  write: 'Writing',
  bash: 'Running command',
  grep: 'Searching',
  glob: 'Finding files',
  thinking: 'Thinking',
  other: 'Tool',
};

export default function ChatView({ parser, fontSize = 13 }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = parser.subscribe(() => {
      setMessages([...parser.getMessages()]);
    });
    setMessages([...parser.getMessages()]);
    return unsub;
  }, [parser]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const toggleCollapse = (id: number) => {
    setMessages(prev => prev.map(m =>
      m.id === id ? { ...m, collapsed: !m.collapsed } : m
    ));
  };

  return (
    <div className="chat-view" ref={containerRef} style={{ fontSize }}>
      {messages.length === 0 && (
        <div className="chat-empty">
          <div className="chat-empty-icon">{'\uD83D\uDCAC'}</div>
          <div>Chat mode active. Terminal output will appear as messages.</div>
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
          {msg.type === 'tool' && (
            <div className="chat-tool" onClick={() => toggleCollapse(msg.id)}>
              <div className="chat-tool-header">
                <span className="chat-tool-icon">{TOOL_ICONS[msg.tool || 'other']}</span>
                <span className="chat-tool-label">
                  {TOOL_LABELS[msg.tool || 'other']}
                </span>
                {msg.toolDetail && (
                  <span className="chat-tool-detail">{msg.toolDetail}</span>
                )}
                <span className="chat-tool-toggle">{msg.collapsed ? '\u25B8' : '\u25BE'}</span>
              </div>
              {!msg.collapsed && (
                <pre className="chat-tool-output">{msg.content}</pre>
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
