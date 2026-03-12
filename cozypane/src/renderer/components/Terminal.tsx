import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { stripAnsi, TUI_ENTER, TUI_EXIT, analyzeFocus, analyzeAction, parseCostInfo, type AiAction, type CostInfo } from '../lib/terminalAnalyzer';
import type { ConversationTurn } from './ConversationHistory';
import CommandInput from './CommandInput';
import '@xterm/xterm/css/xterm.css';

interface Props {
  terminalId: string | null;  // null until PTY created
  cwd: string;
  isVisible: boolean;
  fontSize?: number;
  onCwdChange?: (newCwd: string) => void;
  onActionChange?: (action: AiAction) => void;
  onCostChange?: (cost: CostInfo) => void;
  onConversationUpdate?: (turns: ConversationTurn[]) => void;
  onTerminalReady?: (id: string) => void;
}

export default function Terminal({ terminalId, cwd, isVisible, fontSize = 13, onCwdChange, onActionChange, onCostChange, onConversationUpdate, onTerminalReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const [termDragOver, setTermDragOver] = useState(false);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyCreated = useRef(false);
  const terminalIdRef = useRef<string | null>(terminalId);
  terminalIdRef.current = terminalId;
  const tuiModeRef = useRef(false);
  const focusRef = useRef<'input' | 'terminal'>('input');
  const manualUntilRef = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rollingBufferRef = useRef('');
  const activeProcessRef = useRef('');
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;
  const onActionChangeRef = useRef(onActionChange);
  onActionChangeRef.current = onActionChange;
  const onCostChangeRef = useRef(onCostChange);
  onCostChangeRef.current = onCostChange;
  const onConversationUpdateRef = useRef(onConversationUpdate);
  onConversationUpdateRef.current = onConversationUpdate;
  const onTerminalReadyRef = useRef(onTerminalReady);
  onTerminalReadyRef.current = onTerminalReady;
  const conversationRef = useRef<ConversationTurn[]>([]);
  const assistantBufferRef = useRef('');
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;

  const [tuiMode, setTuiMode] = useState(false);
  const [focus, setFocus] = useState<'input' | 'terminal'>('input');
  const [commandHistory, setCommandHistory] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('cozyPane:commandHistory');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [claudeRunning, setClaudeRunning] = useState(false);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [dynamicSlashCommands, setDynamicSlashCommands] = useState<{ cmd: string; desc: string }[]>([]);

  const switchFocus = useCallback((to: 'input' | 'terminal', manual = false) => {
    focusRef.current = to;
    setFocus(to);
    if (manual) {
      manualUntilRef.current = Date.now() + 5000;
    }
    if (to === 'terminal' && termRef.current) {
      termRef.current.focus();
    }
  }, []);

  const autoSwitch = useCallback(() => {
    if (tuiModeRef.current) return;
    if (Date.now() < manualUntilRef.current) return;

    const result = analyzeFocus(rollingBufferRef.current);
    if (result && result !== focusRef.current) {
      switchFocus(result);
    }
  }, [switchFocus]);

  const autoSwitchRef = useRef(autoSwitch);
  autoSwitchRef.current = autoSwitch;

  const lastReportedCwd = useRef('');
  const wrapperRef = useRef<HTMLDivElement>(null);

  const fitAndSync = useCallback(() => {
    const id = terminalIdRef.current;
    if (!fitAddonRef.current || !termRef.current || !id) return;
    try {
      const term = termRef.current;
      const wasAtBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
      fitAddonRef.current.fit();
      window.cozyPane.terminal.resize(id, term.cols, term.rows);
      if (wasAtBottom) {
        // Scroll after fit settles to avoid race with viewport repositioning
        term.scrollToBottom();
        requestAnimationFrame(() => {
          if (termRef.current) termRef.current.scrollToBottom();
        });
      }
    } catch {}
  }, []);

  const checkCwd = useCallback(() => {
    const id = terminalIdRef.current;
    if (!id) return;
    window.cozyPane.terminal.getCwd(id).then(newCwd => {
      if (newCwd && newCwd !== lastReportedCwd.current) {
        lastReportedCwd.current = newCwd;
        onCwdChangeRef.current?.(newCwd);
      }
    });
  }, []);

  const handleCommandSubmit = useCallback((command: string) => {
    const id = terminalIdRef.current;
    if (!id) return;

    if (command === '\x03') {
      window.cozyPane.terminal.write(id, '\x03');
      return;
    }
    setCommandHistory(prev => {
      if (command.trim() && (prev.length === 0 || prev[0] !== command)) {
        const next = [command, ...prev].slice(0, 100);
        try { localStorage.setItem('cozyPane:commandHistory', JSON.stringify(next)); } catch {}
        return next;
      }
      return prev;
    });

    // Track if Claude is being launched
    const trimmed = command.trim().toLowerCase();
    if (trimmed.startsWith('claude') || trimmed.startsWith('npx claude')) {
      activeProcessRef.current = 'claude';
      setClaudeRunning(true);
    }

    // Track conversation while Claude is running
    if (activeProcessRef.current === 'claude' && command !== '\x03') {
      // Finalize any pending assistant output
      if (assistantBufferRef.current.trim()) {
        conversationRef.current.push({
          role: 'assistant',
          content: assistantBufferRef.current.trim(),
          timestamp: Date.now(),
        });
        assistantBufferRef.current = '';
      }
      conversationRef.current.push({ role: 'user', content: command, timestamp: Date.now() });
      assistantBufferRef.current = '';
      onConversationUpdateRef.current?.([...conversationRef.current]);
    }

    window.cozyPane.terminal.write(id, command.replace(/\n/g, '\r') + '\r');
    manualUntilRef.current = 0;

    // Check cwd after command executes
    setTimeout(checkCwd, 500);
  }, [checkCwd]);

  // Initialize xterm
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;

    const getXtermTheme = () => {
      const style = getComputedStyle(document.documentElement);
      const bg = style.getPropertyValue('--terminal-bg').trim() || '#1a1b2e';
      const fg = style.getPropertyValue('--terminal-fg').trim() || '#e4e4f0';
      const cursor = style.getPropertyValue('--terminal-cursor').trim() || '#7c6ef0';
      const accentDim = style.getPropertyValue('--accent-dim').trim();
      return {
        background: bg,
        foreground: fg,
        cursor,
        cursorAccent: bg,
        selectionBackground: (accentDim || '#4a3fb0') + '50',
        black: '#1a1b2e',
        red: '#f06c7e',
        green: '#5ce0a8',
        yellow: '#f0c95c',
        blue: '#5cb8f0',
        magenta: '#c07ef0',
        cyan: '#5ce0d0',
        white: '#e4e4f0',
        brightBlack: '#6b6c7e',
        brightRed: '#f5909e',
        brightGreen: '#7ef0c0',
        brightYellow: '#f5dc8a',
        brightBlue: '#82ccf5',
        brightMagenta: '#d4a0f5',
        brightCyan: '#7ef0e0',
        brightWhite: '#ffffff',
      };
    };

    const term = new XTerm({
      fontFamily: "'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      theme: getXtermTheme(),
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Detect when user scrolls away from the bottom
    term.onScroll(() => {
      const buf = term.buffer.active;
      const atBottom = buf.viewportY >= buf.baseY;
      setScrolledUp(!atBottom);
    });

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // Copy: Cmd+C (mac) or Ctrl+Shift+C (linux/win) when text is selected
      if (e.key === 'c' && (e.metaKey || (e.ctrlKey && e.shiftKey)) && term.hasSelection()) return true;
      // Also allow Ctrl+C for copy when there's a selection (cross-platform)
      if (e.key === 'c' && e.ctrlKey && !e.shiftKey && term.hasSelection()) return true;
      // Paste: Cmd+V (mac) or Ctrl+Shift+V (linux/win) or Ctrl+V
      if (e.key === 'v' && (e.metaKey || e.ctrlKey)) return true;
      if (tuiModeRef.current || focusRef.current === 'terminal') return true;
      return false;
    });

    term.onData(data => {
      const id = terminalIdRef.current;
      if (id) window.cozyPane.terminal.write(id, data);
    });

    const removeDataListener = window.cozyPane.terminal.onData((id: string, data: string) => {
      if (id !== terminalIdRef.current) return;

      const buf = term.buffer.active;
      const wasAtBottom = buf.viewportY >= buf.baseY;
      term.write(data);
      if (wasAtBottom) {
        term.scrollToBottom();
      }

      if (TUI_ENTER.test(data)) { tuiModeRef.current = true; setTuiMode(true); }
      if (TUI_EXIT.test(data)) { tuiModeRef.current = false; setTuiMode(false); }

      // Accumulate assistant output for conversation tracking
      if (activeProcessRef.current === 'claude') {
        assistantBufferRef.current += stripAnsi(data);
        if (assistantBufferRef.current.length > 10000) {
          assistantBufferRef.current = assistantBufferRef.current.slice(-8000);
        }
      }

      // Detect Claude exiting (shell prompt returns)
      const cleaned = stripAnsi(data);
      if (activeProcessRef.current === 'claude' && /[$%#]\s*$/.test(cleaned)) {
        if (assistantBufferRef.current.trim()) {
          conversationRef.current.push({
            role: 'assistant',
            content: assistantBufferRef.current.trim(),
            timestamp: Date.now(),
          });
          assistantBufferRef.current = '';
          onConversationUpdateRef.current?.([...conversationRef.current]);
        }
        activeProcessRef.current = '';
        setClaudeRunning(false);
        onActionChangeRef.current?.('idle');
      }

      // Rolling buffer
      rollingBufferRef.current += data;
      if (rollingBufferRef.current.length > 3000) {
        rollingBufferRef.current = rollingBufferRef.current.slice(-2000);
      }

      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        // Skip expensive analysis for hidden terminals
        if (!isVisibleRef.current) return;
        autoSwitchRef.current();
        checkCwd();
        const action = analyzeAction(rollingBufferRef.current, activeProcessRef.current === 'claude');
        onActionChangeRef.current?.(action);
        if (activeProcessRef.current === 'claude') {
          const cost = parseCostInfo(rollingBufferRef.current);
          onCostChangeRef.current?.(cost);
        }
      }, 400);
    });

    // React to theme changes
    const handleThemeChange = () => {
      if (!termRef.current) return;
      termRef.current.options.theme = getXtermTheme();
    };
    window.addEventListener('cozyPane:themeChange', handleThemeChange);

    const removeExitListener = window.cozyPane.terminal.onExit((id: string, code: number) => {
      if (id !== terminalIdRef.current) return;
      term.writeln(`\r\n[Process exited with code ${code}]`);
      activeProcessRef.current = '';
      setClaudeRunning(false);
      onActionChangeRef.current?.('idle');
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!isVisibleRef.current) return;
      requestAnimationFrame(() => fitAndSync());
    });
    resizeObserver.observe(containerRef.current);
    if (wrapperRef.current) resizeObserver.observe(wrapperRef.current);

    setTimeout(() => fitAndSync(), 200);

    return () => {
      removeDataListener();
      removeExitListener();
      resizeObserver.disconnect();
      window.removeEventListener('cozyPane:themeChange', handleThemeChange);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // Re-fit when becoming visible
  useEffect(() => {
    if (isVisible) {
      requestAnimationFrame(() => fitAndSync());
    }
  }, [isVisible, fitAndSync]);

  // Update font size when prop changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
      requestAnimationFrame(() => fitAndSync());
    }
  }, [fontSize, fitAndSync]);

  // Create PTY
  useEffect(() => {
    if (!cwd || ptyCreated.current || !termRef.current) return;
    ptyCreated.current = true;
    window.cozyPane.terminal.create(cwd).then((result) => {
      if ('error' in result) {
        console.error('Failed to create PTY:', result.error);
        return;
      }
      terminalIdRef.current = result.id;
      onTerminalReadyRef.current?.(result.id);
      fitAndSync();
    }).catch((err: any) => console.error('Failed to create PTY:', err));
  }, [cwd]);

  const scrollToBottom = useCallback(() => {
    if (termRef.current) {
      termRef.current.scrollToBottom();
      setScrolledUp(false);
    }
  }, []);

  // Load slash commands from filesystem
  useEffect(() => {
    window.cozyPane.fs.getSlashCommands(cwd || undefined).then((commands: any[]) => {
      if (commands && commands.length > 0) {
        setDynamicSlashCommands(commands.map((c: any) => ({ cmd: c.cmd, desc: c.desc })));
      }
    }).catch(() => {});
  }, [cwd]);

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setTermDragOver(false);
    const id = terminalIdRef.current;
    if (!id) return;

    let paths: string[] = [];
    if (e.dataTransfer.files.length > 0) {
      paths = Array.from(e.dataTransfer.files).map(f => window.cozyPane.getPathForFile(f)).filter(Boolean);
    }
    if (paths.length === 0) {
      const text = e.dataTransfer.getData('text/plain');
      if (text) paths = [text];
    }
    if (paths.length > 0) {
      if (focusRef.current === 'input') {
        window.dispatchEvent(new CustomEvent('cozyPane:fileDrop', { detail: paths }));
      } else {
        const escaped = paths.map(p => p.includes(' ') ? `'${p}'` : p).join(' ');
        window.cozyPane.terminal.write(id, escaped);
      }
    }
  }, []);

  return (
    <div className="terminal-full">
      <div className="terminal-output-wrapper" ref={wrapperRef}
        onDragOver={e => { e.preventDefault(); setTermDragOver(true); }}
        onDragLeave={(e) => {
          // Only trigger leave if leaving the wrapper entirely
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setTermDragOver(false);
        }}
        onDrop={handleFileDrop}
      >
        <div
          className={`terminal-output ${focus === 'terminal' && !tuiMode ? 'terminal-focused' : ''}`}
          ref={containerRef}
          onMouseDown={() => switchFocus('terminal', true)}
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); setTermDragOver(true); }}
          onDrop={handleFileDrop}
        />
        {termDragOver && (
          <div className="terminal-drop-overlay"
            onDragOver={e => e.preventDefault()}
            onDrop={handleFileDrop}
            onDragLeave={() => setTermDragOver(false)}
          >
            Drop to insert file path
          </div>
        )}
        {scrolledUp && (
          <button className="scroll-to-bottom" onClick={scrollToBottom} title="Scroll to bottom">
            ↓
          </button>
        )}
      </div>
      {!tuiMode && (
        <CommandInput
          onSubmit={handleCommandSubmit}
          onRawKey={(data) => {
            const id = terminalIdRef.current;
            if (id) window.cozyPane.terminal.write(id, data);
          }}
          visible={true}
          history={commandHistory}
          onFocus={() => switchFocus('input', true)}
          isFocused={focus === 'input'}
          showSlashCommands={true}
          dynamicSlashCommands={dynamicSlashCommands}
        />
      )}
      {!tuiMode && (
        <div className={`terminal-focus-indicator ${focus === 'terminal' ? 'raw-active' : ''}`}>
          {focus === 'terminal'
            ? 'Raw mode — keys go to terminal. Click input bar for command mode.'
            : 'Command mode. Click terminal for raw keys (menus, choices).'}
        </div>
      )}
    </div>
  );
}
