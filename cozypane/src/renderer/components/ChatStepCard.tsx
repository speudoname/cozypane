import React, { useState } from 'react';
import {
  FileText, PencilLine, FilePlus2, Terminal as TerminalIcon, Search, FolderSearch,
  Globe, SearchCode, Bot, ListChecks, Info, Loader2, ChevronRight, ChevronDown,
} from 'lucide-react';
import type { ToolType, ToolMeta, BashMeta, EditMeta, ReadMeta, GrepMeta } from '../lib/chatEvents';

interface Props {
  tool: ToolType;
  detail: string;
  output?: string;
  meta?: ToolMeta;
  error?: boolean;
  streaming?: boolean;
}

const TOOL_ICON: Record<ToolType, React.ComponentType<any>> = {
  read: FileText,
  edit: PencilLine,
  write: FilePlus2,
  bash: TerminalIcon,
  grep: Search,
  glob: FolderSearch,
  webfetch: Globe,
  websearch: SearchCode,
  agent: Bot,
  todo: ListChecks,
  notebook: FileText,
  mcp: Info,
  other: Info,
};

const TOOL_VERB: Record<ToolType, string> = {
  read: 'Read',
  edit: 'Edited',
  write: 'Created',
  bash: 'Ran',
  grep: 'Searched',
  glob: 'Matched',
  webfetch: 'Fetched',
  websearch: 'Searched web',
  agent: 'Agent',
  todo: 'Todos',
  notebook: 'Notebook',
  mcp: 'MCP',
  other: 'Action',
};

function shortenPath(p: string): string {
  const clean = p.replace(/['"]/g, '').trim();
  if (!clean) return '';
  const parts = clean.split('/');
  if (parts.length <= 2) return parts.join('/');
  return '…/' + parts.slice(-2).join('/');
}

function isBashMeta(m: ToolMeta | undefined): m is BashMeta {
  return !!m && ('exitCode' in (m as object) || 'stdout' in (m as object) || 'stderr' in (m as object));
}
function isEditMeta(m: ToolMeta | undefined): m is EditMeta {
  return !!m && 'additions' in (m as object) && 'removals' in (m as object);
}
function isReadMeta(m: ToolMeta | undefined): m is ReadMeta {
  return !!m && 'file' in (m as object) && !('additions' in (m as object)) && !('matches' in (m as object));
}
function isGrepMeta(m: ToolMeta | undefined): m is GrepMeta {
  return !!m && 'matches' in (m as object);
}

export default function ChatStepCard({ tool, detail, output, meta, error, streaming }: Props) {
  const [expanded, setExpanded] = useState(false);
  const Icon = TOOL_ICON[tool] || Info;
  const verb = TOOL_VERB[tool] || 'Action';

  let summary = detail;
  if (isEditMeta(meta) && (meta.additions || meta.removals)) {
    summary = `${shortenPath(meta.file || detail)} (+${meta.additions} -${meta.removals})`;
  } else if (isReadMeta(meta) && meta.lines) {
    summary = `${shortenPath(meta.file || detail)} (${meta.lines} lines)`;
  } else if (isGrepMeta(meta)) {
    summary = `${meta.pattern || detail} (${meta.matches.length} matches)`;
  } else if (isBashMeta(meta)) {
    summary = detail;
  } else {
    summary = shortenPath(detail);
  }

  const hasExpandable = !!output || !!meta;
  const errClass = error ? ' chat-step-bash-error' : '';

  return (
    <div className={`chat-step-card${errClass}`}>
      <div
        className={`chat-step-card-header${hasExpandable ? ' expandable' : ''}`}
        onClick={hasExpandable ? () => setExpanded(v => !v) : undefined}
      >
        <Icon size={14} />
        <span className="chat-step-verb">{verb}</span>
        <span className="chat-step-detail">{summary}</span>
        {streaming && <Loader2 size={12} className="spin" />}
        {hasExpandable && (
          expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
        )}
      </div>
      {expanded && (
        <div className="chat-step-card-body">
          {isEditMeta(meta) && meta.diff && (
            <pre className="chat-step-diff">
              {meta.diff.split('\n').map((line, i) => {
                const cls =
                  line.startsWith('+') ? 'chat-diff-add' :
                  line.startsWith('-') ? 'chat-diff-del' :
                  line.startsWith('@@') ? 'chat-diff-hunk' : '';
                return <div key={i} className={cls}>{line}</div>;
              })}
            </pre>
          )}
          {isBashMeta(meta) && (meta.stdout || output) && (
            <pre className="chat-step-bash-output">{meta.stdout || output}</pre>
          )}
          {isReadMeta(meta) && meta.preview && (
            <pre className="chat-step-read-preview">{meta.preview}</pre>
          )}
          {isGrepMeta(meta) && meta.matches.length > 0 && (
            <ul className="chat-step-grep-list">
              {meta.matches.slice(0, 50).map((m, i) => (
                <li key={i}>
                  <span className="chat-grep-file">{m.file}</span>
                  <span className="chat-grep-line">:{m.line}</span>
                  <span className="chat-grep-preview">{m.preview}</span>
                </li>
              ))}
            </ul>
          )}
          {!meta && output && (
            <pre className="chat-step-raw-output">{output}</pre>
          )}
        </div>
      )}
    </div>
  );
}
