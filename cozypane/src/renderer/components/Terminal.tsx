import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { stripAnsi, TUI_ENTER, TUI_EXIT, analyzeFocus, analyzeAction, parseCostInfo, type AiAction, type CostInfo } from '../lib/terminalAnalyzer';
import type { ConversationTurn } from './ConversationHistory';
import CommandInput from './CommandInput';
import '@xterm/xterm/css/xterm.css';

interface Props {
  cwd: string;
  onCwdChange?: (newCwd: string) => void;
  onActionChange?: (action: AiAction) => void;
  onCostChange?: (cost: CostInfo) => void;
  onConversationUpdate?: (turns: ConversationTurn[]) => void;
}

export default function Terminal({ cwd, onCwdChange, onActionChange, onCostChange, onConversationUpdate }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyCreated = useRef(false);
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
  const conversationRef = useRef<ConversationTurn[]>([]);
  const assistantBufferRef = useRef('');

  const [tuiMode, setTuiMode] = useState(false);
  const [focus, setFocus] = useState<'input' | 'terminal'>('input');
  const [commandHistory, setCommandHistory] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('cozyPane:commandHistory');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [claudeRunning, setClaudeRunning] = useState(false);

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

  const checkCwd = useCallback(() => {
    window.cozyPane.terminal.getCwd().then(newCwd => {
      if (newCwd && newCwd !== lastReportedCwd.current) {
        lastReportedCwd.current = newCwd;
        onCwdChangeRef.current?.(newCwd);
      }
    });
  }, []);

  const handleCommandSubmit = useCallback((command: string) => {
    if (command === '\x03') {
      window.cozyPane.terminal.write('\x03');
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

    window.cozyPane.terminal.write(command + '\n');
    manualUntilRef.current = 0;

    // Check cwd after command executes
    setTimeout(checkCwd, 500);
  }, [checkCwd]);

  // Initialize xterm
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;

    const term = new XTerm({
      fontFamily: "'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: {
        background: '#1a1b2e',
        foreground: '#e4e4f0',
        cursor: '#7c6ef0',
        cursorAccent: '#1a1b2e',
        selectionBackground: '#4a3fb050',
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
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'c' && term.hasSelection()) return true;
      if ((e.metaKey || e.ctrlKey) && e.key === 'v') return true;
      if (tuiModeRef.current || focusRef.current === 'terminal') return true;
      return false;
    });

    term.onData(data => {
      window.cozyPane.terminal.write(data);
    });

    const removeDataListener = window.cozyPane.terminal.onData((data: string) => {
      term.write(data);

      if (TUI_ENTER.test(data)) { tuiModeRef.current = true; setTuiMode(true); }
      if (TUI_EXIT.test(data)) { tuiModeRef.current = false; setTuiMode(false); }

      // Accumulate assistant output for conversation tracking
      if (activeProcessRef.current === 'claude') {
        assistantBufferRef.current += stripAnsi(data);
        // Cap buffer to avoid memory issues
        if (assistantBufferRef.current.length > 10000) {
          assistantBufferRef.current = assistantBufferRef.current.slice(-8000);
        }
      }

      // Detect Claude exiting (shell prompt returns)
      const cleaned = stripAnsi(data);
      if (activeProcessRef.current === 'claude' && /[$%#]\s*$/.test(cleaned)) {
        // Finalize last assistant turn
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

    const removeExitListener = window.cozyPane.terminal.onExit(code => {
      term.writeln(`\r\n[Process exited with code ${code}]`);
      activeProcessRef.current = '';
      setClaudeRunning(false);
      onActionChangeRef.current?.('idle');
    });

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (fitAddonRef.current && termRef.current && containerRef.current) {
          try {
            fitAddonRef.current.fit();
            window.cozyPane.terminal.resize(termRef.current.cols, termRef.current.rows);
          } catch (e) {}
        }
      });
    });
    resizeObserver.observe(containerRef.current);

    setTimeout(() => {
      try { if (fitAddonRef.current) fitAddonRef.current.fit(); } catch {}
    }, 200);

    return () => {
      removeDataListener();
      removeExitListener();
      resizeObserver.disconnect();
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!cwd || ptyCreated.current || !termRef.current) return;
    ptyCreated.current = true;
    window.cozyPane.terminal.create(cwd).then(() => {
      if (termRef.current) {
        window.cozyPane.terminal.resize(termRef.current.cols, termRef.current.rows);
      }
    }).catch((err: any) => console.error('Failed to create PTY:', err));
  }, [cwd]);

  return (
    <div className="terminal-full">
      <div
        className={`terminal-output ${focus === 'terminal' && !tuiMode ? 'terminal-focused' : ''}`}
        ref={containerRef}
        onMouseDown={() => switchFocus('terminal', true)}
      />
      {!tuiMode && (
        <CommandInput
          onSubmit={handleCommandSubmit}
          visible={true}
          history={commandHistory}
          onFocus={() => switchFocus('input', true)}
          isFocused={focus === 'input'}
          showSlashCommands={claudeRunning}
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
