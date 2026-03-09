import React, { useRef, useEffect } from 'react';

interface Props {
  events: FileChangeEvent[];
  onFileClick?: (path: string, name: string) => void;
  onDiffClick?: (path: string) => void;
  summary: string | null;
  onSummarize?: () => void;
  summarizing?: boolean;
}

function getIcon(type: string): string {
  switch (type) {
    case 'create': return '+';
    case 'modify': return '~';
    case 'delete': return '-';
    default: return '?';
  }
}

function getColor(type: string): string {
  switch (type) {
    case 'create': return 'var(--success)';
    case 'modify': return 'var(--warning)';
    case 'delete': return 'var(--danger)';
    default: return 'var(--text-muted)';
  }
}

function timeAgo(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export default function ActivityFeed({ events, onFileClick, onDiffClick, summary, onSummarize, summarizing }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div className="activity-feed">
        <div className="activity-feed-header">Activity</div>
        <div className="activity-empty">
          No file changes detected yet. Changes will appear here when files are created, modified, or deleted.
        </div>
      </div>
    );
  }

  return (
    <div className="activity-feed">
      <div className="activity-feed-header">
        Activity
        <span className="activity-count">{events.length}</span>
        <div style={{ flex: 1 }} />
        {onSummarize && (
          <button
            className="btn activity-summarize-btn"
            onClick={onSummarize}
            disabled={summarizing}
            title="Generate AI summary of changes"
          >
            {summarizing ? 'Summarizing...' : 'Summarize'}
          </button>
        )}
      </div>
      {summary && (
        <div className="activity-summary">
          {summary}
        </div>
      )}
      <div className="activity-list" ref={scrollRef}>
        {events.map((event, i) => {
          const fileName = event.name.split('/').pop() || event.name;
          const dirPart = event.name.includes('/') ? event.name.slice(0, event.name.lastIndexOf('/') + 1) : '';
          return (
            <div
              key={`${event.path}-${event.timestamp}-${i}`}
              className="activity-item"
              onClick={() => {
                if (event.type === 'modify' && onDiffClick) {
                  onDiffClick(event.path);
                } else if (event.type !== 'delete' && onFileClick) {
                  onFileClick(event.path, fileName);
                }
              }}
              style={{ cursor: event.type !== 'delete' ? 'pointer' : 'default' }}
            >
              <span className="activity-icon" style={{ color: getColor(event.type) }}>
                {getIcon(event.type)}
              </span>
              <span className="activity-info">
                <span className="activity-file">
                  {dirPart && <span className="activity-dir">{dirPart}</span>}
                  {fileName}
                </span>
                <span className="activity-meta">
                  <span className="activity-type" style={{ color: getColor(event.type) }}>
                    {event.type === 'create' ? 'created' : event.type === 'modify' ? 'modified' : 'deleted'}
                  </span>
                  {event.type === 'modify' && onDiffClick && (
                    <span className="activity-diff-label">click for diff</span>
                  )}
                  <span className="activity-time">{timeAgo(event.timestamp)}</span>
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
