import React, { useMemo, useRef, useEffect } from 'react';
import type { ConversationTurn } from './ConversationHistory';
import type { AiAction } from '../lib/terminalAnalyzer';

interface SummaryEntry {
  type: 'prompt' | 'tool' | 'info';
  icon: string;
  text: string;
  timestamp: number;
}

interface Props {
  turns: ConversationTurn[];
  aiAction: AiAction;
  activityEvents: { type: string; name: string; path: string; timestamp: number }[];
}

const TOOL_PATTERNS: [RegExp, string, string][] = [
  [/\bEdit\(\s*["']?([^\s"')]+)/i, 'Edited', 'pencil'],
  [/\bWrite\(\s*["']?([^\s"')]+)/i, 'Created', 'plus'],
  [/\bRead\(\s*["']?([^\s"')]+)/i, 'Read', 'eye'],
  [/\bGlob\(/i, 'Searched files', 'search'],
  [/\bGrep\(/i, 'Searched code', 'search'],
  [/\bBash\(\s*["']?(.{0,60})/i, 'Ran command', 'terminal'],
  [/\bNotebookEdit\(/i, 'Edited notebook', 'pencil'],
];

function extractActions(content: string): { label: string; icon: string }[] {
  const actions: { label: string; icon: string }[] = [];
  for (const [pattern, verb, icon] of TOOL_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      const detail = match[1] ? `: ${match[1].split('/').pop()?.replace(/["']/g, '') || match[1]}` : '';
      actions.push({ label: `${verb}${detail}`, icon });
    }
  }
  return actions;
}

function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const ICONS: Record<string, string> = {
  pencil: '✎',
  plus: '+',
  eye: '◉',
  search: '⌕',
  terminal: '>_',
  user: '▸',
  thinking: '…',
  idle: '●',
  reading: '◉',
  writing: '✎',
  executing: '>_',
};

export default function SessionSummary({ turns, aiAction, activityEvents }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => {
    const result: SummaryEntry[] = [];

    for (const turn of turns) {
      if (turn.role === 'user') {
        const text = turn.content.trim();
        if (text) {
          result.push({
            type: 'prompt',
            icon: ICONS.user,
            text: text.length > 120 ? text.slice(0, 120) + '...' : text,
            timestamp: turn.timestamp,
          });
        }
      } else {
        // Parse assistant turn for tool uses
        const actions = extractActions(turn.content);
        for (const action of actions) {
          result.push({
            type: 'tool',
            icon: ICONS[action.icon] || '•',
            text: action.label,
            timestamp: turn.timestamp,
          });
        }
      }
    }

    return result;
  }, [turns]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length, aiAction]);

  const fileStats = useMemo(() => {
    const created = activityEvents.filter(e => e.type === 'create').length;
    const modified = activityEvents.filter(e => e.type === 'modify').length;
    const deleted = activityEvents.filter(e => e.type === 'delete').length;
    return { created, modified, deleted, total: created + modified + deleted };
  }, [activityEvents]);

  const statusLabel = aiAction === 'idle' ? 'Idle' :
    aiAction === 'reading' ? 'Reading files...' :
    aiAction === 'writing' ? 'Editing files...' :
    aiAction === 'executing' ? 'Running command...' :
    aiAction === 'thinking' ? 'Thinking...' : 'Idle';

  return (
    <div className="summary-panel">
      <div className="summary-header">
        Session Summary
        <span className={`summary-status ${aiAction}`}>{statusLabel}</span>
      </div>

      {fileStats.total > 0 && (
        <div className="summary-stats">
          {fileStats.created > 0 && <span className="stat created">+{fileStats.created} created</span>}
          {fileStats.modified > 0 && <span className="stat modified">~{fileStats.modified} modified</span>}
          {fileStats.deleted > 0 && <span className="stat deleted">-{fileStats.deleted} deleted</span>}
        </div>
      )}

      <div className="summary-timeline" ref={scrollRef}>
        {entries.length === 0 ? (
          <div className="summary-empty">
            No activity yet. Start a Claude Code session to see a summary of actions here.
          </div>
        ) : (
          entries.map((entry, i) => (
            <div key={i} className={`summary-entry ${entry.type}`}>
              <span className="summary-icon">{entry.icon}</span>
              <span className="summary-text">{entry.text}</span>
              <span className="summary-time">{timeStr(entry.timestamp)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
