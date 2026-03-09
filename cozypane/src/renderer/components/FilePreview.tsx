import React, { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import { getLanguage } from '../lib/languageMap';

// Set up Monaco workers with static URL imports (Vite requires static strings)
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

// CozyPane dark theme for Monaco
monaco.editor.defineTheme('cozy-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6b6c7e', fontStyle: 'italic' },
    { token: 'keyword', foreground: '7c6ef0' },
    { token: 'string', foreground: '5ce0a8' },
    { token: 'number', foreground: 'f0c95c' },
    { token: 'type', foreground: '5cb8f0' },
  ],
  colors: {
    'editor.background': '#1a1b2e',
    'editor.foreground': '#e4e4f0',
    'editor.lineHighlightBackground': '#232438',
    'editor.selectionBackground': '#3d3e5c',
    'editorLineNumber.foreground': '#6b6c7e',
    'editorLineNumber.activeForeground': '#9394a5',
    'editor.inactiveSelectionBackground': '#2a2b42',
    'editorWidget.background': '#232438',
    'editorWidget.border': '#333456',
    'input.background': '#2a2b42',
    'input.border': '#333456',
    'scrollbarSlider.background': '#333456',
    'scrollbarSlider.hoverBackground': '#3d3e5c',
    'minimap.background': '#1a1b2e',
  },
});

interface Props {
  filePath: string | null;
  onDirtyChange?: (filePath: string, isDirty: boolean) => void;
}

export default function FilePreview({ filePath, onDirtyChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const currentPathRef = useRef<string | null>(null);
  const originalContentRef = useRef<string>('');
  const originalVersionRef = useRef<number>(0);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  // Create editor instance once
  useEffect(() => {
    if (!containerRef.current) return;

    const editor = monaco.editor.create(containerRef.current, {
      value: '',
      language: 'plaintext',
      theme: 'cozy-dark',
      automaticLayout: true,
      minimap: { enabled: true },
      fontSize: 13,
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      tabSize: 2,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      padding: { top: 8 },
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true },
    });

    editorRef.current = editor;

    // Cmd/Ctrl+S to save
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const path = currentPathRef.current;
      if (!path) return;
      const content = editor.getValue();
      setSaving(true);
      window.cozyPane.fs.writefile(path, content).then(result => {
        setSaving(false);
        if (result.error) {
          setError(result.error);
        } else {
          originalContentRef.current = content;
          const model = editor.getModel();
          if (model) originalVersionRef.current = model.getAlternativeVersionId();
          onDirtyChangeRef.current?.(path, false);
        }
      }).catch(() => { setSaving(false); setError('Save failed'); });
    });

    // Track dirty state via version ID (avoids full content comparison per keystroke)
    editor.onDidChangeModelContent(() => {
      const path = currentPathRef.current;
      if (!path) return;
      const model = editor.getModel();
      if (!model) return;
      const isDirty = model.getAlternativeVersionId() !== originalVersionRef.current;
      onDirtyChangeRef.current?.(path, isDirty);
    });

    return () => {
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // Load file content when filePath changes
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    currentPathRef.current = filePath;

    if (!filePath) {
      editor.setValue('');
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    window.cozyPane.fs.readfile(filePath).then(result => {
      if (currentPathRef.current !== filePath) return;

      if (result.error) {
        setError(result.error);
        editor.setValue('');
      } else {
        const content = result.content || '';
        originalContentRef.current = content;
        const lang = getLanguage(filePath);
        const model = editor.getModel();
        if (model) {
          monaco.editor.setModelLanguage(model, lang);
        }
        editor.setValue(content);
        const loadedModel = editor.getModel();
        if (loadedModel) originalVersionRef.current = loadedModel.getAlternativeVersionId();
        editor.revealLine(1);
        onDirtyChangeRef.current?.(filePath, false);
      }
      setLoading(false);
    }).catch(() => { setLoading(false); setError('Could not load file'); });
  }, [filePath]);

  return (
    <div className="file-preview" style={{ position: 'relative' }}>
      {saving && (
        <div style={{
          position: 'absolute', top: 8, right: 16, zIndex: 10,
          color: 'var(--success)', fontSize: 12,
        }}>
          Saving...
        </div>
      )}
      {loading && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 5,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-primary)', color: 'var(--text-muted)',
        }}>
          Loading...
        </div>
      )}
      {error && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 5,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-primary)', color: 'var(--text-muted)',
        }}>
          {error}
        </div>
      )}
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
