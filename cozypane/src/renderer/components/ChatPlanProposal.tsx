import React from 'react';
import { Check, MessageSquare, X } from 'lucide-react';
import { renderMarkdown } from '../lib/chatMarkdown';

interface Props {
  plan: string;
  onApprove: () => void;
  onRevise: () => void;
  onCancel: () => void;
}

export default function ChatPlanProposal({ plan, onApprove, onRevise, onCancel }: Props) {
  return (
    <div className="chat-plan-card">
      <div className="chat-plan-header">Proposed plan</div>
      <div className="chat-plan-body chat-markdown">{renderMarkdown(plan)}</div>
      <div className="chat-plan-buttons">
        <button type="button" className="chat-btn chat-btn-primary" onClick={onApprove}>
          <Check size={14} /> Approve
        </button>
        <button type="button" className="chat-btn" onClick={onRevise}>
          <MessageSquare size={14} /> Revise
        </button>
        <button type="button" className="chat-btn" onClick={onCancel}>
          <X size={14} /> Cancel
        </button>
      </div>
    </div>
  );
}
