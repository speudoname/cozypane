// Shared Monaco theme registration for CozyPane.
//
// This module exists so that both FilePreview.tsx and DiffViewer.tsx can
// depend on the same theme definitions without one silently relying on the
// other having been imported first. Previously the theme definitions lived
// inside FilePreview.tsx as a module side-effect, and DiffViewer.tsx only
// worked because App.tsx imported FilePreview first — fragile, and it would
// have broken silently under code-splitting or lazy loading.
//
// Calling `registerCozyThemes()` is idempotent (Monaco allows re-defining
// themes with the same name) but to be safe we guard with a module-level
// flag so the work runs exactly once per process.

import * as monaco from 'monaco-editor';

let registered = false;

function registerCozyThemes(): void {
  if (registered) return;
  registered = true;

  // CozyPane dark theme
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

  // Ocean theme
  monaco.editor.defineTheme('ocean', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '5a7590', fontStyle: 'italic' },
      { token: 'keyword', foreground: '4fc3f7' },
      { token: 'string', foreground: '66bb6a' },
      { token: 'number', foreground: 'ffca28' },
      { token: 'type', foreground: '42a5f5' },
    ],
    colors: {
      'editor.background': '#0d1b2a',
      'editor.foreground': '#e0e8f0',
      'editor.lineHighlightBackground': '#1b2838',
      'editor.selectionBackground': '#3a5068',
      'editorLineNumber.foreground': '#5a7590',
      'editorLineNumber.activeForeground': '#8da0b8',
      'editor.inactiveSelectionBackground': '#243447',
      'editorWidget.background': '#1b2838',
      'editorWidget.border': '#2e4158',
      'input.background': '#243447',
      'input.border': '#2e4158',
      'scrollbarSlider.background': '#2e4158',
      'scrollbarSlider.hoverBackground': '#3a5068',
      'minimap.background': '#0d1b2a',
    },
  });

  // Forest theme
  monaco.editor.defineTheme('forest', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6a7e62', fontStyle: 'italic' },
      { token: 'keyword', foreground: '81c784' },
      { token: 'string', foreground: 'dce775' },
      { token: 'number', foreground: 'ffcc80' },
      { token: 'type', foreground: '64b5f6' },
    ],
    colors: {
      'editor.background': '#1a2318',
      'editor.foreground': '#e0edd8',
      'editor.lineHighlightBackground': '#232e20',
      'editor.selectionBackground': '#485a42',
      'editorLineNumber.foreground': '#6a7e62',
      'editorLineNumber.activeForeground': '#9aab90',
      'editor.inactiveSelectionBackground': '#2d3a29',
      'editorWidget.background': '#232e20',
      'editorWidget.border': '#3a4a35',
      'input.background': '#2d3a29',
      'input.border': '#3a4a35',
      'scrollbarSlider.background': '#3a4a35',
      'scrollbarSlider.hoverBackground': '#485a42',
      'minimap.background': '#1a2318',
    },
  });

  // Cozy Light theme
  monaco.editor.defineTheme('cozy-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '9a9490', fontStyle: 'italic' },
      { token: 'keyword', foreground: '6b5ce0' },
      { token: 'string', foreground: '2e8b57' },
      { token: 'number', foreground: 'd4a017' },
      { token: 'type', foreground: '2980b9' },
    ],
    colors: {
      'editor.background': '#f5f3f0',
      'editor.foreground': '#2c2a28',
      'editor.lineHighlightBackground': '#eae7e2',
      'editor.selectionBackground': '#cac6c0',
      'editorLineNumber.foreground': '#9a9490',
      'editorLineNumber.activeForeground': '#6b6560',
      'editor.inactiveSelectionBackground': '#e0ddd8',
      'editorWidget.background': '#eae7e2',
      'editorWidget.border': '#d5d2cc',
      'input.background': '#e0ddd8',
      'input.border': '#d5d2cc',
      'scrollbarSlider.background': '#d5d2cc',
      'scrollbarSlider.hoverBackground': '#cac6c0',
      'minimap.background': '#f5f3f0',
    },
  });
}

// Register on import so that any consumer of this module gets the themes
// ready immediately — matching the previous FilePreview.tsx side-effect
// pattern without the one-consumer-must-load-first fragility.
registerCozyThemes();
