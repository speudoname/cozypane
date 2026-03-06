import React, { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', css: 'css', scss: 'scss', less: 'less',
    html: 'html', md: 'markdown', py: 'python', rs: 'rust', go: 'go',
    java: 'java', c: 'c', cpp: 'cpp', rb: 'ruby', php: 'php',
    swift: 'swift', yaml: 'yaml', yml: 'yaml', sh: 'shell',
    sql: 'sql', xml: 'xml', svg: 'xml',
  };
  return map[ext] || 'plaintext';
}

interface Props {
  filePath: string;
  before: string;
  after: string;
}

export default function DiffViewer({ filePath, before, after }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
      theme: 'cozy-dark',
      automaticLayout: true,
      readOnly: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderSideBySide: true,
      padding: { top: 8 },
    });

    editorRef.current = diffEditor;

    return () => {
      diffEditor.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const language = getLanguage(filePath);
    const originalModel = monaco.editor.createModel(before, language);
    const modifiedModel = monaco.editor.createModel(after, language);

    editor.setModel({ original: originalModel, modified: modifiedModel });

    return () => {
      originalModel.dispose();
      modifiedModel.dispose();
    };
  }, [filePath, before, after]);

  const fileName = filePath.split('/').pop() || filePath;

  return (
    <div className="diff-viewer">
      <div className="diff-header">
        <span className="diff-label">Original</span>
        <span className="diff-filename">{fileName}</span>
        <span className="diff-label">Modified</span>
      </div>
      <div ref={containerRef} style={{ width: '100%', flex: 1 }} />
    </div>
  );
}
