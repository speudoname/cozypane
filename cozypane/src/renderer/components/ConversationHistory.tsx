import React, { useRef, useEffect } from 'react';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface Props {
  turns: ConversationTurn[];
}

function timeStr(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ConversationHistory({ turns }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns.length]);

  if (turns.length === 0) {
    return (
      <div className="conversation-panel">
        <div className="conversation-header">Conversation</div>
        <div className="conversation-empty">
          No conversation yet. Start Claude Code and send messages to see them here.
        </div>
      </div>
    );
  }

  return (
    <div className="conversation-panel">
      <div className="conversation-header">
        Conversation
        <span className="activity-count">{turns.length}</span>
      </div>
      <div className="conversation-list" ref={scrollRef}>
        {turns.map((turn, i) => (
          <div key={i} className={`conversation-turn ${turn.role}`}>
            <div className="conversation-role">
              {turn.role === 'user' ? 'You' : 'Claude'}
              <span className="conversation-time">{timeStr(turn.timestamp)}</span>
            </div>
            <div className="conversation-content">
              {turn.content.length > 2000
                ? turn.content.slice(0, 2000) + '\n... (truncated)'
                : turn.content}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
