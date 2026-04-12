import React, { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import { getLanguage } from '../lib/languageMap';
// Register the four cozy themes (cozy-dark / ocean / forest / cozy-light).
// The import triggers a module side-effect; DiffViewer.tsx imports the same
// module so diff view no longer depends on FilePreview having been loaded first.
import '../lib/monacoThemes';

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

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg']);
const PDF_EXTS = new Set(['pdf']);
const BINARY_EXTS = new Set([
  'zip', 'tar', 'gz', 'rar', '7z', 'dmg', 'iso', 'exe', 'dll', 'so', 'dylib',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'sqlite', 'db',
  'class', 'o', 'pyc', 'wasm',
  'icns',
]);

function getExt(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() || '';
}

type FileType = 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'binary';

function detectFileType(filePath: string): FileType {
  const ext = getExt(filePath);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (PDF_EXTS.has(ext)) return 'pdf';
  if (BINARY_EXTS.has(ext)) return 'binary';
  return 'text';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Media Preview Component ───

interface MediaPreviewProps {
  filePath: string;
  fileType: FileType;
}

function MediaPreview({ filePath, fileType }: MediaPreviewProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [fileInfo, setFileInfo] = useState<{ size: number; mime: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setDataUrl(null);
    setFileInfo(null);
    setZoom(1);

    // For video/audio/PDF, use cozypane-media:// protocol to stream the file
    // directly instead of base64-encoding it over IPC (which consumes ~1.33x
    // the file size in renderer heap). Images use base64 since they're small.
    const useProtocol = fileType === 'video' || fileType === 'audio' || fileType === 'pdf';
    if (useProtocol) {
      setDataUrl(`cozypane-media://${encodeURIComponent(filePath)}`);
      setLoading(false);
      return;
    }

    window.cozyPane.fs.readBinary(filePath).then(result => {
      if (result.error) {
        setError(result.error);
      } else if (result.base64 && result.mime) {
        setDataUrl(`data:${result.mime};base64,${result.base64}`);
        setFileInfo({ size: result.size || 0, mime: result.mime });
      }
      setLoading(false);
    }).catch(() => { setLoading(false); setError('Could not load file'); });
  }, [filePath, fileType]);

  if (loading) {
    return <div className="media-preview-center">Loading...</div>;
  }
  if (error) {
    return <div className="media-preview-center">{error}</div>;
  }

  const fileName = filePath.split('/').pop() || filePath;

  if (fileType === 'image' && dataUrl) {
    return (
      <div className="media-preview">
        <div className="media-toolbar">
          <span className="media-filename">{fileName}</span>
          {fileInfo && <span className="media-info">{fileInfo.mime} — {formatSize(fileInfo.size)}</span>}
          <div className="media-zoom-controls">
            <button onClick={() => setZoom(z => Math.max(0.1, z - 0.25))}>-</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => Math.min(5, z + 0.25))}>+</button>
            <button onClick={() => setZoom(1)}>1:1</button>
          </div>
        </div>
        <div className="media-image-container"
          onWheel={e => {
            if (e.metaKey || e.ctrlKey) {
              e.preventDefault();
              setZoom(z => Math.max(0.1, Math.min(5, z + (e.deltaY < 0 ? 0.1 : -0.1))));
            }
          }}
        >
          <img
            src={dataUrl}
            alt={fileName}
            style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
            draggable={false}
          />
        </div>
      </div>
    );
  }

  if (fileType === 'video' && dataUrl) {
    return (
      <div className="media-preview">
        <div className="media-toolbar">
          <span className="media-filename">{fileName}</span>
          {fileInfo && <span className="media-info">{formatSize(fileInfo.size)}</span>}
        </div>
        <div className="media-video-container">
          <video controls src={dataUrl} style={{ maxWidth: '100%', maxHeight: '100%' }} />
        </div>
      </div>
    );
  }

  if (fileType === 'audio' && dataUrl) {
    return (
      <div className="media-preview">
        <div className="media-toolbar">
          <span className="media-filename">{fileName}</span>
          {fileInfo && <span className="media-info">{formatSize(fileInfo.size)}</span>}
        </div>
        <div className="media-preview-center">
          <div className="media-audio-icon">♫</div>
          <audio controls src={dataUrl} style={{ width: '80%', maxWidth: 400 }} />
        </div>
      </div>
    );
  }

  if (fileType === 'pdf' && dataUrl) {
    return (
      <div className="media-preview">
        <div className="media-toolbar">
          <span className="media-filename">{fileName}</span>
          {fileInfo && <span className="media-info">{formatSize(fileInfo.size)}</span>}
        </div>
        <iframe src={dataUrl} style={{ flex: 1, width: '100%', border: 'none', background: '#fff' }} title={fileName} />
      </div>
    );
  }

  // Binary fallback
  return (
    <div className="media-preview">
      <div className="media-preview-center">
        <div className="media-binary-icon">&#128196;</div>
        <div className="media-filename">{fileName}</div>
        {fileInfo && <div className="media-info">{fileInfo.mime} — {formatSize(fileInfo.size)}</div>}
        <div className="media-info" style={{ marginTop: 8 }}>Binary file — cannot be previewed as text</div>
      </div>
    </div>
  );
}

// ─── Main FilePreview Component ───

interface Props {
  filePath: string | null;
  fontSize?: number;
  onDirtyChange?: (filePath: string, isDirty: boolean) => void;
}

export default function FilePreview({ filePath, fontSize = 13, onDirtyChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const currentPathRef = useRef<string | null>(null);
  const originalContentRef = useRef<string>('');
  const originalVersionRef = useRef<number>(0);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  const fileType = filePath ? detectFileType(filePath) : 'text';
  const isMedia = fileType !== 'text';

  const saveFileRef = useRef<(() => void) | null>(null);
  const saveFile = () => {
    const editor = editorRef.current;
    const path = currentPathRef.current;
    if (!editor || !path) return;
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
        setIsDirty(false);
        onDirtyChangeRef.current?.(path, false);
      }
    }).catch(() => { setSaving(false); setError('Save failed'); });
  };
  saveFileRef.current = saveFile;

  // Create editor instance once
  useEffect(() => {
    if (!containerRef.current) return;

    const editor = monaco.editor.create(containerRef.current, {
      value: '',
      language: 'plaintext',
      theme: 'cozy-dark',
      automaticLayout: true,
      minimap: { enabled: true },
      fontSize,
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

    // Apply current theme on mount
    monaco.editor.setTheme(localStorage.getItem('cozyPane:theme') || 'cozy-dark');

    // Listen for theme changes
    const handleThemeChange = (e: Event) => {
      const themeId = (e as CustomEvent).detail || 'cozy-dark';
      monaco.editor.setTheme(themeId);
    };
    window.addEventListener('cozyPane:themeChange', handleThemeChange);

    // Cmd/Ctrl+S to save
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveFileRef.current?.());

    // Track dirty state via version ID (avoids full content comparison per keystroke)
    editor.onDidChangeModelContent(() => {
      const path = currentPathRef.current;
      if (!path) return;
      const model = editor.getModel();
      if (!model) return;
      const dirty = model.getAlternativeVersionId() !== originalVersionRef.current;
      setIsDirty(dirty);
      onDirtyChangeRef.current?.(path, dirty);
    });

    return () => {
      window.removeEventListener('cozyPane:themeChange', handleThemeChange);
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // Update font size when prop changes
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.updateOptions({ fontSize });
    }
  }, [fontSize]);

  // Load file content when filePath changes (text files only)
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    currentPathRef.current = filePath;

    if (!filePath || detectFileType(filePath) !== 'text') {
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
        setIsDirty(false);
        onDirtyChangeRef.current?.(filePath, false);
      }
      setLoading(false);
    }).catch(() => { setLoading(false); setError('Could not load file'); });
  }, [filePath]);

  const fileName = filePath ? filePath.split('/').pop() : null;

  return (
    <div className="file-preview" style={{ position: 'relative' }}>
      {!isMedia && filePath && (
        <div className="file-preview-toolbar">
          <span className="file-preview-filename">{fileName}{isDirty ? ' ●' : ''}</span>
          <button
            className={`file-preview-save-btn${isDirty ? ' dirty' : ''}`}
            onClick={saveFile}
            disabled={saving || !isDirty}
            title="Save (Cmd+S)"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {/* Media files — show media preview */}
      {isMedia && filePath && (
        <MediaPreview filePath={filePath} fileType={fileType} />
      )}

      {/* Text files — show Monaco editor */}
      <div ref={containerRef} style={{
        width: '100%',
        flex: 1,
        minHeight: 0,
        display: isMedia ? 'none' : 'block',
      }} />

      {!isMedia && loading && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 5,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-primary)', color: 'var(--text-muted)',
        }}>
          Loading...
        </div>
      )}
      {!isMedia && error && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 5,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-primary)', color: 'var(--text-muted)',
        }}>
          {error}
        </div>
      )}
    </div>
  );
}
