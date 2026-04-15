import React, { useState } from 'react';
import { Check, X, ArrowRight, ShieldCheck } from 'lucide-react';
import type { InteractivePrompt } from '../lib/chatEvents';

interface Props {
  prompt: InteractivePrompt;
  onRespond: (text: string) => void;
}

export default function ChatInteractivePrompt({ prompt, onRespond }: Props) {
  const [textVal, setTextVal] = useState('');

  const send = (s: string) => onRespond(s);
  const sendEnter = () => onRespond('\r');

  return (
    <div className="chat-interactive">
      {prompt.question && (
        <div className="chat-interactive-question">{prompt.question}</div>
      )}

      {prompt.kind === 'yes-no' && (
        <div className="chat-interactive-buttons">
          <button type="button" className="chat-btn chat-btn-primary" onClick={() => send('y\r')}>
            <Check size={14} /> Yes
          </button>
          <button type="button" className="chat-btn" onClick={() => send('n\r')}>
            <X size={14} /> No
          </button>
        </div>
      )}

      {prompt.kind === 'numbered' && prompt.choices && (
        <div className="chat-interactive-buttons">
          {prompt.choices.map(c => (
            <button
              type="button"
              key={c.key}
              className="chat-btn"
              onClick={() => send(c.key + '\r')}
            >
              <span className="chat-btn-key">{c.key}</span>
              <span>{c.label}</span>
            </button>
          ))}
        </div>
      )}

      {prompt.kind === 'lettered' && prompt.choices && (
        <div className="chat-interactive-buttons">
          {prompt.choices.map(c => (
            <button
              type="button"
              key={c.key}
              className="chat-btn"
              onClick={() => send(c.key + '\r')}
            >
              <span className="chat-btn-key">{c.key}</span>
              <span>{c.label}</span>
            </button>
          ))}
        </div>
      )}

      {prompt.kind === 'text' && (
        <form
          className="chat-interactive-form"
          onSubmit={e => { e.preventDefault(); send(textVal + '\r'); setTextVal(''); }}
        >
          <input
            type="text"
            value={textVal}
            onChange={e => setTextVal(e.target.value)}
            autoFocus
          />
          <button type="submit" className="chat-btn chat-btn-primary">
            <ArrowRight size={14} /> Send
          </button>
        </form>
      )}

      {prompt.kind === 'password' && (
        <form
          className="chat-interactive-form"
          onSubmit={e => { e.preventDefault(); send(textVal + '\r'); setTextVal(''); }}
        >
          <input
            type="password"
            value={textVal}
            onChange={e => setTextVal(e.target.value)}
            autoFocus
          />
          <button type="submit" className="chat-btn chat-btn-primary">
            <ArrowRight size={14} /> Send
          </button>
        </form>
      )}

      {prompt.kind === 'continue' && (
        <div className="chat-interactive-buttons">
          <button type="button" className="chat-btn chat-btn-primary" onClick={sendEnter}>
            <ArrowRight size={14} /> Continue
          </button>
        </div>
      )}

      {prompt.kind === 'trust-folder' && (
        <div className="chat-interactive-buttons">
          <button type="button" className="chat-btn chat-btn-primary" onClick={() => send('1\r')}>
            <ShieldCheck size={14} /> Trust
          </button>
          <button type="button" className="chat-btn" onClick={() => send('\x1b')}>
            <X size={14} /> Cancel
          </button>
        </div>
      )}

      {prompt.kind === 'custom' && (
        <div className="chat-interactive-buttons">
          <button type="button" className="chat-btn chat-btn-primary" onClick={sendEnter}>
            <ArrowRight size={14} /> Continue
          </button>
        </div>
      )}
    </div>
  );
}
