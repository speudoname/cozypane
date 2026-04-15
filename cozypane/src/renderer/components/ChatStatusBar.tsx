import React from 'react';
import { FolderTree, GitBranch, Bot, Shield, Zap, Gauge, CircleAlert } from 'lucide-react';
import type { Status } from '../lib/chatEvents';

interface Props {
  status: Status;
  onShiftTab?: () => void;
}

function usageClass(pct?: number): string {
  if (pct === undefined) return '';
  if (pct >= 85) return 'bad';
  if (pct >= 50) return 'warn';
  return 'ok';
}

export default function ChatStatusBar({ status, onShiftTab }: Props) {
  const hasAny =
    status.folder || status.branch || status.model ||
    status.permissionMode || status.effort ||
    status.usagePercent !== undefined || status.mcpFailures;

  if (!hasAny) return null;

  return (
    <div className="chat-status-bar">
      {status.folder && (
        <div className="chat-status-item" title="Project folder">
          <FolderTree size={14} />
          <span>{status.folder}</span>
        </div>
      )}
      {status.branch && (
        <div className="chat-status-item" title="Git branch">
          <GitBranch size={14} />
          <span>{status.branch}</span>
        </div>
      )}
      {status.model && (
        <div className="chat-status-item" title={status.contextSize ? `${status.model} (${status.contextSize} context)` : status.model}>
          <Bot size={14} />
          <span>{status.model}{status.contextSize ? ` · ${status.contextSize}` : ''}</span>
        </div>
      )}
      {status.permissionMode && (
        <button
          type="button"
          className="chat-status-item chat-status-mode"
          onClick={onShiftTab}
          title="Click to cycle permission mode (shift+tab)"
        >
          <Shield size={14} />
          <span>{status.permissionMode}</span>
        </button>
      )}
      {status.effort && (
        <div className="chat-status-item" title="Reasoning effort">
          <Zap size={14} />
          <span>{status.effort}</span>
        </div>
      )}
      {status.usagePercent !== undefined && (
        <div
          className={`chat-status-item chat-usage ${usageClass(status.usagePercent)}`}
          title={status.usageReset ? `Resets ${status.usageReset}` : 'Usage'}
        >
          <Gauge size={14} />
          <span>{status.usagePercent}%</span>
        </div>
      )}
      {status.mcpFailures ? (
        <div className="chat-status-item chat-status-warn" title="MCP server failures">
          <CircleAlert size={14} />
          <span>{status.mcpFailures} MCP fail</span>
        </div>
      ) : null}
    </div>
  );
}
