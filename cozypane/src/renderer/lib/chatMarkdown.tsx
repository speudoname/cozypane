// Minimal markdown renderer shared by chat bubbles.
// Supports: fenced code blocks (with language), h1-h3 headings, bullet and
// numbered lists, **bold**, *italic*, inline `code`, [text](url) links,
// paragraphs. Deliberately tiny — no external dependency.

import React from 'react';

export function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      elements.push(
        <pre key={key++} className="chat-code-block">
          {lang && <div className="chat-code-lang">{lang}</div>}
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const Tag = `h${level + 1}` as keyof JSX.IntrinsicElements;
      elements.push(
        <Tag key={key++} className="chat-heading">
          {renderInline(headingMatch[2])}
        </Tag>,
      );
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      elements.push(
        <ul key={key++} className="chat-list">
          {items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      elements.push(
        <ol key={key++} className="chat-list">
          {items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
        </ol>,
      );
      continue;
    }

    if (!line.trim()) { i++; continue; }

    elements.push(
      <p key={key++} className="chat-paragraph">{renderInline(line)}</p>,
    );
    i++;
  }

  return elements;
}

export function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Inline code — take priority so ** inside code isn't re-parsed.
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`/);
    if (codeMatch) {
      if (codeMatch[1]) parts.push(...renderInline(codeMatch[1]).map((n, i) => <React.Fragment key={key++}>{n}</React.Fragment>));
      parts.push(<code key={key++} className="chat-inline-code">{codeMatch[2]}</code>);
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }
    // Link
    const linkMatch = remaining.match(/^(.*?)\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      if (linkMatch[1]) parts.push(<span key={key++}>{linkMatch[1]}</span>);
      parts.push(
        <a key={key++} href={linkMatch[3]} target="_blank" rel="noopener noreferrer">
          {linkMatch[2]}
        </a>,
      );
      remaining = remaining.slice(linkMatch[0].length);
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
    // Italic (single * — skip bold markers)
    const italicMatch = remaining.match(/^(.*?)(?<![*])\*(?!\*)([^*]+?)\*(?!\*)/);
    if (italicMatch) {
      if (italicMatch[1]) parts.push(<span key={key++}>{italicMatch[1]}</span>);
      parts.push(<em key={key++}>{italicMatch[2]}</em>);
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }
    parts.push(<span key={key++}>{remaining}</span>);
    break;
  }

  return parts;
}
