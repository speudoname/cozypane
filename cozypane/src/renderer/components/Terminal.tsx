import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { stripAnsi, TUI_ENTER, TUI_EXIT, decideFocus, detectClaudeExit, analyzeAction, detectDeployUrl, detectLocalUrls, classifyTerminalErrors } from '../lib/terminalAnalyzer';
import { shellEscape } from '../lib/shellUtils';
import CommandInput from './CommandInput';
import ChatView from './ChatView';
import { ChatParser } from '../lib/chatParser';
import '@xterm/xterm/css/xterm.css';

interface Props {
  terminalId: string | null;  // null until PTY created
  cwd: string;
  isVisible: boolean;
  fontSize?: number;
  autoCommand?: string;
  onCwdChange?: (newCwd: string) => void;
  onActionChange?: (action: AiAction) => void;
  onClaudeRunningChange?: (running: boolean) => void;
  onTerminalReady?: (id: string) => void;
  onLocalUrlDetected?: (url: string) => void;
  onLocalUrlsDetected?: (urls: string[]) => void;
  onProdUrlDetected?: (url: string) => void;
  onDevServerStateChange?: (state: DevServerState) => void;
  bufferSize?: number;
}

export default function Terminal({ terminalId, cwd, isVisible, fontSize = 13, autoCommand, onCwdChange, onActionChange, onClaudeRunningChange, onTerminalReady, onLocalUrlDetected, onLocalUrlsDetected, onProdUrlDetected, onDevServerStateChange, bufferSize = 50 }: Props) {
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
  const rollingBufferRef = useRef<string[]>([]);
  const lastDeployUrlRef = useRef('');
  const lastLocalUrlRef = useRef('');
  const lastLocalUrlsRef = useRef<string[]>([]);
  const activeProcessRef = useRef('');
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;
  const onActionChangeRef = useRef(onActionChange);
  onActionChangeRef.current = onActionChange;
  const onClaudeRunningChangeRef = useRef(onClaudeRunningChange);
  onClaudeRunningChangeRef.current = onClaudeRunningChange;
  const onTerminalReadyRef = useRef(onTerminalReady);
  onTerminalReadyRef.current = onTerminalReady;
  const onLocalUrlDetectedRef = useRef(onLocalUrlDetected);
  onLocalUrlDetectedRef.current = onLocalUrlDetected;
  const onLocalUrlsDetectedRef = useRef(onLocalUrlsDetected);
  onLocalUrlsDetectedRef.current = onLocalUrlsDetected;
  const onProdUrlDetectedRef = useRef(onProdUrlDetected);
  onProdUrlDetectedRef.current = onProdUrlDetected;
  const onDevServerStateChangeRef = useRef(onDevServerStateChange);
  onDevServerStateChangeRef.current = onDevServerStateChange;
  const bufferSizeRef = useRef(bufferSize);
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;
  const followOutputRef = useRef(true);
  const inputTextRef = useRef('');
  const scrollRafRef = useRef(0); // requestAnimationFrame handle for debounced scroll
  const scrollDisengageRef = useRef({ cumulative: 0, timer: 0 });
  const termEventCleanupRef = useRef<(() => void) | null>(null);

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
  const [isChoicePrompt, setIsChoicePrompt] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const [chatMode, setChatMode] = useState(false);
  const chatParserRef = useRef(new ChatParser());

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

  const lastReportedCwd = useRef('');
  const wrapperRef = useRef<HTMLDivElement>(null);

  const fitAndSync = useCallback(() => {
    const id = terminalIdRef.current;
    if (!fitAddonRef.current || !termRef.current || !id) return;
    try {
      // Snapshot relative position before fit() rewraps the buffer.
      // viewportY is rows-from-bottom when user has scrolled up; preserve that.
      const term = termRef.current;
      const bufBefore = term.buffer.active;
      const rowsFromBottom = followOutputRef.current
        ? 0
        : Math.max(0, bufBefore.baseY - bufBefore.viewportY);

      fitAddonRef.current.fit();
      window.cozyPane.terminal.resize(id, term.cols, term.rows);

      // After fit(), xterm rewraps lines which shifts viewportY. Re-anchor to
      // the correct position so the user doesn't see a jump.
      const bufAfter = term.buffer.active;
      if (followOutputRef.current) {
        term.scrollToBottom();
      } else {
        // Restore approximate rows-from-bottom position.
        const targetViewportY = Math.max(0, bufAfter.baseY - rowsFromBottom);
        term.scrollToLine(targetViewportY);
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
    if (/^(claude|npx\s+claude)(\s|$)/.test(trimmed)) {
      activeProcessRef.current = 'claude';
      setClaudeRunning(true);
      onClaudeRunningChangeRef.current?.(true);
    }

    window.cozyPane.terminal.write(id, command.replace(/\n/g, '\r') + '\r');
    // Feed user message to chat parser
    chatParserRef.current.addUserMessage(command);
    // Don't snap to bottom if user deliberately scrolled up — respect their position.
    // followOutput stays whatever it was; the ↓ button remains visible if scrolled up.
    manualUntilRef.current = 0;

    // Check cwd after command executes
    setTimeout(checkCwd, 500);
  }, [checkCwd]);

  // Initialize xterm
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;

    const getXtermTheme = () => {
      const style = getComputedStyle(document.documentElement);
      const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
      const bg = v('--terminal-bg', '#1a1b2e');
      return {
        background: bg,
        foreground: v('--terminal-fg', '#e4e4f0'),
        cursor: v('--terminal-cursor', '#7c6ef0'),
        cursorAccent: bg,
        selectionBackground: v('--accent-dim', '#4a3fb0') + '50',
        black: v('--terminal-black', '#1a1b2e'),
        red: v('--terminal-red', '#f06c7e'),
        green: v('--terminal-green', '#5ce0a8'),
        yellow: v('--terminal-yellow', '#f0c95c'),
        blue: v('--terminal-blue', '#5cb8f0'),
        magenta: v('--terminal-magenta', '#c07ef0'),
        cyan: v('--terminal-cyan', '#5ce0d0'),
        white: v('--terminal-white', '#e4e4f0'),
        brightBlack: v('--terminal-bright-black', '#6b6c7e'),
        brightRed: v('--terminal-bright-red', '#f5909e'),
        brightGreen: v('--terminal-bright-green', '#7ef0c0'),
        brightYellow: v('--terminal-bright-yellow', '#f5dc8a'),
        brightBlue: v('--terminal-bright-blue', '#82ccf5'),
        brightMagenta: v('--terminal-bright-magenta', '#d4a0f5'),
        brightCyan: v('--terminal-bright-cyan', '#7ef0e0'),
        brightWhite: v('--terminal-bright-white', '#ffffff'),
      };
    };

    const term = new XTerm({
      fontFamily: "'DejaVu Sans Mono', 'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', Menlo, Monaco, Consolas, monospace",
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

    // Scroll tracking: followOutputRef is the single source of truth for
    // whether the terminal should auto-scroll on new data. It is set to
    // false only by explicit user scroll-up actions, and back to true only
    // by explicit user actions (scroll down to bottom, submit command,
    // click scroll-to-bottom button). No timers, cooldowns, or resize
    // events touch scrolling — this eliminates all scroll-fighting bugs.

    const scheduleScrollToBottom = () => {
      if (scrollRafRef.current) return; // already scheduled
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = 0;
        if (!termRef.current || !followOutputRef.current) return;
        termRef.current.scrollToBottom();
      });
    };

    // Flag to distinguish user-initiated scroll-down (wheel) from
    // write-triggered scroll events. Only wheel sets this; it auto-clears.
    const userScrollingDown = { active: false };

    // L18: keep named handler refs so we can remove them in the cleanup
    // return. Previously these listeners were attached anonymously and
    // only removed implicitly via `term.dispose()` — which works today
    // but leaks under StrictMode double-mount during dev and breaks unit
    // tests that don't fully dispose the terminal.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && followOutputRef.current) {
        // User scrolling up — accumulate delta and only disengage after meaningful scroll.
        // Prevents accidental Mac trackpad touches (tiny deltaY) from breaking auto-scroll.
        const sd = scrollDisengageRef.current;
        sd.cumulative += Math.abs(e.deltaY);
        if (sd.timer) window.clearTimeout(sd.timer);
        sd.timer = window.setTimeout(() => { sd.cumulative = 0; sd.timer = 0; }, 300);

        // Cancel any pending scroll-to-bottom immediately so the user isn't
        // yanked back between wheel events while cumulative builds up.
        if (scrollRafRef.current) {
          cancelAnimationFrame(scrollRafRef.current);
          scrollRafRef.current = 0;
        }

        if (sd.cumulative > 15) {
          followOutputRef.current = false;
          setScrolledUp(true);
          sd.cumulative = 0;
          if (sd.timer) { window.clearTimeout(sd.timer); sd.timer = 0; }
        }
      } else if (e.deltaY > 0 && !followOutputRef.current) {
        // User scrolling down while disengaged — signal onScroll handler
        // that re-engagement is allowed, then clear the flag after a brief
        // window so that write-triggered onScroll events don't re-engage.
        userScrollingDown.active = true;
        setTimeout(() => { userScrollingDown.active = false; }, 150);

        if (!termRef.current) return;
        const buf = termRef.current.buffer.active;
        if (buf.viewportY >= buf.baseY - Math.max(50, termRef.current.rows)) {
          followOutputRef.current = true;
          setScrolledUp(false);
          scheduleScrollToBottom();
        }
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'PageUp' || (e.key === 'ArrowUp' && e.shiftKey)) {
        followOutputRef.current = false;
        setScrolledUp(true);
      }
      if (e.key === 'End' && e.ctrlKey) {
        followOutputRef.current = true;
        setScrolledUp(false);
      }
    };
    term.element?.addEventListener('wheel', onWheel, { passive: true });
    term.element?.addEventListener('keydown', onKey);
    termEventCleanupRef.current = () => {
      term.element?.removeEventListener('wheel', onWheel);
      term.element?.removeEventListener('keydown', onKey);
    };

    // Re-engage follow mode when the viewport reaches near the bottom,
    // but ONLY when the user is actively scrolling (wheel events set this flag).
    // We must not re-engage on onScroll alone because term.write() also fires
    // onScroll as baseY grows — that would yank the user back to the bottom
    // while they're trying to read scrollback during fast streaming.
    term.onScroll(() => {
      if (followOutputRef.current || !userScrollingDown.active) return;
      const buf = term.buffer.active;
      if (buf.viewportY >= buf.baseY - Math.max(50, term.rows)) {
        followOutputRef.current = true;
        setScrolledUp(false);
      }
    });

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // Copy: Cmd+C (mac) or Ctrl+Shift+C (linux/win) when text is selected
      if (e.key === 'c' && (e.metaKey || (e.ctrlKey && e.shiftKey)) && term.hasSelection()) return true;
      // Also allow Ctrl+C for copy when there's a selection (cross-platform)
      if (e.key === 'c' && e.ctrlKey && !e.shiftKey && term.hasSelection()) return true;
      // Paste: Cmd+V (mac) or Ctrl+Shift+V (linux/win) or Ctrl+V
      if (e.key === 'v' && (e.metaKey || e.ctrlKey)) return true;
      if (tuiModeRef.current || focusRef.current === 'terminal') {
        // H5: Escape in terminal mode (non-TUI) → switch back to input
        if (e.key === 'Escape' && !tuiModeRef.current && e.type === 'keydown') {
          switchFocus('input', true);
          return false;
        }
        return true;
      }
      return false;
    });

    term.onData(data => {
      const id = terminalIdRef.current;
      if (id) window.cozyPane.terminal.write(id, data);
    });

    const removeDataListener = window.cozyPane.terminal.onData((id: string, data: string) => {
      if (id !== terminalIdRef.current) return;

      term.write(data, () => {
        if (followOutputRef.current) {
          scheduleScrollToBottom();
        }
      });

      if (TUI_ENTER.test(data)) { tuiModeRef.current = true; setTuiMode(true); }
      if (TUI_EXIT.test(data)) { tuiModeRef.current = false; setTuiMode(false); switchFocus('input'); }

      // Rolling buffer: strip ANSI once, store as clean lines
      const strippedData = stripAnsi(data);
      const newLines = strippedData.split('\n').filter(l => l.trim());
      if (newLines.length > 0) {
        rollingBufferRef.current.push(...newLines);
        const maxBuf = bufferSizeRef.current;
        if (rollingBufferRef.current.length > maxBuf) {
          rollingBufferRef.current = rollingBufferRef.current.slice(-maxBuf);
        }
        // Feed chat parser with raw stripped text (parser buffers internally)
        chatParserRef.current.feedRawText(strippedData);
      }

      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        const lines = rollingBufferRef.current;
        const joined = lines.join('\n');

        // URL detection runs for ALL terminals (including hidden/background)
        // so companion dev-server tabs can report URLs to the active tab.
        const localUrls = detectLocalUrls(joined, true);
        const latestUrl = localUrls.length > 0 ? localUrls[localUrls.length - 1] : null;
        if (latestUrl && latestUrl !== lastLocalUrlRef.current) {
          lastLocalUrlRef.current = latestUrl;
          onLocalUrlDetectedRef.current?.(latestUrl);
        }
        if (localUrls.length > 0) {
          const prev = lastLocalUrlsRef.current;
          if (localUrls.length !== prev.length || localUrls.some((u, i) => u !== prev[i])) {
            lastLocalUrlsRef.current = localUrls;
            onLocalUrlsDetectedRef.current?.(localUrls);
          }
        }

        // Deploy URL detection also runs for all terminals
        const deployUrl = detectDeployUrl(joined, true);
        if (deployUrl && deployUrl !== lastDeployUrlRef.current) {
          lastDeployUrlRef.current = deployUrl;
          onProdUrlDetectedRef.current?.(deployUrl);
        }

        // Dev server state: classify errors and emit state for all terminals
        if (onDevServerStateChangeRef.current) {
          const errors = classifyTerminalErrors(lines);
          const hasErrors = errors.some(e => e.type !== 'warning');
          const url = lastLocalUrlRef.current || null;
          const status: DevServerState['status'] = hasErrors ? 'error' : url ? 'running' : 'starting';
          const typeCounts: Record<string, number> = {};
          for (const e of errors) { typeCounts[e.type] = (typeCounts[e.type] || 0) + 1; }
          const summaryParts = Object.entries(typeCounts).map(([t, n]) => `${n} ${t}`);
          onDevServerStateChangeRef.current({
            status,
            url,
            hasErrors,
            errorSummary: summaryParts.length > 0 ? summaryParts.join(', ') : '',
            errors,
            recentOutput: lines.slice(-30),
            timestamp: Date.now(),
          });
        }

        // Skip expensive focus/action analysis for hidden terminals
        if (!isVisibleRef.current) return;

        // Unified focus decision (replaces separate autoSwitch + detectChoicePrompt)
        if (!tuiModeRef.current && Date.now() >= manualUntilRef.current) {
          const decision = decideFocus(lines);
          if (decision.target && decision.target !== focusRef.current) {
            const inputHasText = !!inputTextRef.current;
            if (decision.target === 'terminal' && focusRef.current === 'input' && inputHasText) {
              // Skip — user is typing
            } else {
              switchFocus(decision.target);
            }
          }
          setIsChoicePrompt(decision.isChoicePrompt);
        }

        // Detect Claude running from output
        if (activeProcessRef.current !== 'claude') {
          const hasClaudePrompt = lines.slice(-5).some(l => /❯\s*$/.test(l.trim()));
          if (hasClaudePrompt) {
            activeProcessRef.current = 'claude';
            setClaudeRunning(true);
            onClaudeRunningChangeRef.current?.(true);
          }
        }

        // Detect Claude exiting
        if (activeProcessRef.current === 'claude' && detectClaudeExit(lines)) {
          activeProcessRef.current = '';
          setClaudeRunning(false);
          onClaudeRunningChangeRef.current?.(false);
          onActionChangeRef.current?.('idle');
        }

        checkCwd();
        const action = analyzeAction(joined, activeProcessRef.current === 'claude', true);
        onActionChangeRef.current?.(action);
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
      onClaudeRunningChangeRef.current?.(false);
      onActionChangeRef.current?.('idle');
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!isVisibleRef.current) return;
      requestAnimationFrame(() => fitAndSync());
    });
    resizeObserver.observe(containerRef.current);
    if (wrapperRef.current) resizeObserver.observe(wrapperRef.current);

    // L19: use requestAnimationFrame instead of a magic 200ms delay. The
    // previous setTimeout raced the PTY-create effect (which also calls
    // `fitAndSync` when the PTY resolves); on slow machines the timer
    // could fire before the PTY existed. rAF runs after the current
    // paint and is deterministic — fitAndSync itself already guards
    // against `!id` so the ordering is safe.
    requestAnimationFrame(() => fitAndSync());

    return () => {
      removeDataListener();
      removeExitListener();
      resizeObserver.disconnect();
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
      if (scrollDisengageRef.current.timer) window.clearTimeout(scrollDisengageRef.current.timer);
      window.removeEventListener('cozyPane:themeChange', handleThemeChange);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      // L18: explicitly remove the wheel/keydown listeners on `term.element`
      // before disposing the terminal so we don't rely on dispose() to do it.
      termEventCleanupRef.current?.();
      termEventCleanupRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // Re-fit and refocus input when becoming visible (tab switch)
  const prevVisibleRef = useRef(isVisible);
  useEffect(() => {
    const wasHidden = !prevVisibleRef.current;
    prevVisibleRef.current = isVisible;
    if (isVisible) {
      requestAnimationFrame(() => fitAndSync());
      // When switching to this tab, focus the input bar
      if (wasHidden && !tuiModeRef.current) {
        switchFocus('input');
        // Bump focus counter so CommandInput re-focuses the textarea
        setFocusTick(t => t + 1);
      }
    }
  }, [isVisible, fitAndSync, switchFocus]);

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
      // Auto-run command if specified (e.g. claude --dangerously-skip-permissions)
      if (autoCommand) {
        setTimeout(() => {
          window.cozyPane.terminal.write(result.id, autoCommand + '\r');
        }, 300);
      }
    }).catch((err: any) => console.error('Failed to create PTY:', err));
  }, [cwd]);

  const scrollToBottom = useCallback(() => {
    if (termRef.current) {
      followOutputRef.current = true;
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
        window.dispatchEvent(new CustomEvent('cozyPane:fileDrop', { detail: { paths, terminalId: id } }));
      } else {
        const escaped = paths.map(p => shellEscape(p)).join(' ');
        window.cozyPane.terminal.write(id, escaped);
      }
    }
  }, []);

  return (
    <div className="terminal-full">
      {/* Chat mode toggle */}
      {!tuiMode && (
        <button
          className={`chat-mode-toggle ${chatMode ? 'active' : ''}`}
          onClick={() => setChatMode(prev => !prev)}
          title={chatMode ? 'Switch to Terminal' : 'Switch to Chat'}
        >
          {chatMode ? '\u2328\uFE0F' : '\uD83D\uDCAC'}
        </button>
      )}

      {/* Terminal view -- hidden but alive when chat mode is on */}
      <div className="terminal-output-wrapper" ref={wrapperRef}
        style={{ display: (chatMode && !tuiMode) ? 'none' : undefined }}
        onDragOver={e => { e.preventDefault(); setTermDragOver(true); }}
        onDragLeave={(e) => {
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
            {'\u2193'}
          </button>
        )}
      </div>

      {/* Chat view -- shown when chat mode is on */}
      {chatMode && !tuiMode && (
        <div className="chat-view-wrapper">
          <ChatView parser={chatParserRef.current} fontSize={fontSize} />
        </div>
      )}

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
          showSlashCommands={claudeRunning}
          dynamicSlashCommands={dynamicSlashCommands}
          terminalId={terminalIdRef.current || undefined}
          isChoicePrompt={isChoicePrompt}
          focusTick={focusTick}
          onTextChange={(text) => { inputTextRef.current = text; }}
          fontSize={fontSize}
        />
      )}
      {!tuiMode && !chatMode && (
        <div className={`terminal-focus-indicator ${focus === 'terminal' ? 'raw-active' : ''}`}>
          {focus === 'terminal'
            ? 'Raw mode \u2014 keys go to terminal. Click input bar for command mode.'
            : 'Command mode. Click terminal for raw keys (menus, choices).'}
        </div>
      )}
    </div>
  );
}
