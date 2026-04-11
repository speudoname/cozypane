import React, { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import { getLanguage } from '../lib/languageMap';
// Register cozy themes (cozy-dark / ocean / forest / cozy-light). Previously
// DiffViewer relied on FilePreview being imported first to define these
// themes; the shared module makes the dependency explicit.
import '../lib/monacoThemes';

interface Props {
  filePath: string;
  before: string;
  after: string;
  fontSize?: number;
}

export default function DiffViewer({ filePath, before, after, fontSize = 13 }: Props) {
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

    // Apply current theme on mount
    monaco.editor.setTheme(localStorage.getItem('cozyPane:theme') || 'cozy-dark');

    // Listen for theme changes
    const handleThemeChange = (e: Event) => {
      const themeId = (e as CustomEvent).detail || 'cozy-dark';
      monaco.editor.setTheme(themeId);
    };
    window.addEventListener('cozyPane:themeChange', handleThemeChange);

    return () => {
      window.removeEventListener('cozyPane:themeChange', handleThemeChange);
      diffEditor.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.updateOptions({ fontSize });
    }
  }, [fontSize]);

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
