# CozyPane - Architecture & Roadmap

## Vision
A friendly, approachable terminal application designed for vibe coders who find raw terminals intimidating. Built specifically for AI CLI coding tools (Claude Code, Codex, Aider, etc.) while remaining a fully functional terminal. Shows users what AI tools are doing to their codebase in real time.

## Target Users
Complete beginners who've never used a terminal but want to use AI coding tools.

## Tech Stack Decisions

### Electron over Tauri
We evaluated both:
- **Tauri** (Rust + OS webview): lighter (~15MB), less RAM, but younger ecosystem, webview inconsistencies across platforms, harder terminal emulation, Rust learning curve
- **Electron** (Chromium + Node.js): heavier (~150MB), more RAM, but battle-tested ecosystem, xterm.js works perfectly, every hard problem already solved (PTY, file watching, diffs), used by VS Code/Cursor/Warp/Slack/Discord
- **Decision:** Electron. Terminal emulation is the core feature, and xterm.js on Electron is rock-solid. The weight tradeoff doesn't matter for a desktop dev tool. Node.js is faster to develop with for filesystem/process/git work.

### React over Vue/Svelte
- Biggest ecosystem, most examples, Monaco is React-friendly, xterm.js has React wrappers, largest developer pool for contributors.

### Monaco over CodeMirror
- Since we want a full editor (not just preview), Monaco IS the VS Code editor. Users already know the UX. Heavier than CodeMirror but we're already paying the Electron tax. Free: syntax highlighting, autocomplete, minimap, find/replace.

## Tech Stack
- **Framework:** Electron (same as VS Code, Cursor, Warp)
- **Frontend:** React + TypeScript
- **Terminal:** xterm.js + node-pty (full PTY - bash/zsh/powershell)
- **Editor:** Monaco (VS Code's editor component) - to be integrated
- **Build:** Vite (renderer) + TypeScript compiler (main process)
- **Platforms:** macOS + Windows + Linux

## Project Structure
```
cozypane/
├── src/
│   ├── main/                  # Electron main process
│   │   ├── main.ts            # App entry, window creation, lifecycle (~73 lines)
│   │   ├── pty.ts             # PTY spawn, write, resize, CWD detection
│   │   ├── filesystem.ts      # fs:readdir, readfile, writefile, homedir
│   │   ├── watcher.ts         # File watcher with dedup/noise filtering
│   │   └── preload.ts         # Bridge between main and renderer
│   └── renderer/              # React frontend
│       ├── App.tsx             # Root layout (terminal-first, panels right)
│       ├── main.tsx            # React entry point + ErrorBoundary
│       ├── types.d.ts          # TypeScript type definitions
│       ├── components/
│       │   ├── Sidebar.tsx     # File browser tree (receives watcher events via prop)
│       │   ├── FilePreview.tsx # Monaco editor with save, dirty tracking
│       │   ├── Terminal.tsx    # xterm.js + focus management
│       │   ├── CommandInput.tsx # Warp-style editable input bar
│       │   ├── StatusBar.tsx   # Bottom status bar with layout controls
│       │   ├── ActivityFeed.tsx # Real-time file change log
│       │   └── ErrorBoundary.tsx # React error boundary with reload
│       ├── lib/
│       │   └── terminalAnalyzer.ts # ANSI stripping, pattern matching, focus analysis
│       └── styles/
│           └── global.css      # All styles, CSS variables theming
├── audits/                     # Code audit reports
├── scripts/
│   └── dev.mjs                # Dev script (Vite + Electron launcher)
├── package.json
├── tsconfig.json               # Renderer TypeScript config
├── tsconfig.main.json          # Main process TypeScript config
└── vite.config.ts
```

## Layout — Terminal First

The terminal is the hero. File browser and preview are secondary panels on the right.

### Mode 1: Two-Column (stacked right panel)
```
┌──────────────────────────────┬─────────────┐
│                              │  Files      │
│                              │  > src/     │
│         TERMINAL             │  > lib/     │
│       (full height)          ├─────────────┤
│                              │  Preview    │
│                              │  [file      │
│  ┌─────────────────────────┐ │   content]  │
│  │ $ command input bar     │ │             │
│  └─────────────────────────┘ │             │
├──────────────────────────────┴─────────────┤
│ Status Bar                    Hide | Split  │
└─────────────────────────────────────────────┘
```

### Mode 2: Three-Column (side by side)
```
┌──────────────────┬──────────┬───────────┐
│                  │  Files   │  Preview  │
│    TERMINAL      │  > src/  │  [file    │
│   (full height)  │  > lib/  │   content]│
│                  │  app.ts  │           │
│  ┌─────────────┐│          │           │
│  │ $ input bar ││          │           │
│  └─────────────┘│          │           │
├──────────────────┴──────────┴───────────┤
│ Status Bar                               │
└──────────────────────────────────────────┘
```

Toggle between modes via status bar buttons. "Hide Panels" collapses right side for full-width terminal.

---

## Feature Roadmap

### Phase 1 - Foundation [DONE]
- [x] Electron + React + TypeScript project setup
- [x] Full PTY terminal (bash/zsh/powershell) via xterm.js + node-pty
- [x] Collapsible sidebar with file browser (expandable folder tree)
- [x] File preview with line numbers and tabs
- [x] Resizable panels (drag handles for all splits)
- [x] Dark theme (purple/cozy palette)
- [x] Status bar with cwd and ready indicator
- [x] Cross-platform PTY (detects shell per OS)
- [x] Claude Code nesting fix (strips CLAUDECODE env var)
- [x] Dynamic Vite port detection for dev mode

### Phase 1.5 - Terminal-First Layout & Smart Input [DONE]
- [x] Terminal-first layout (terminal left, panels right)
- [x] Two layout modes (stacked / three-column) with toggle
- [x] "Hide Panels" to collapse right side for full-width terminal
- [x] **Warp-style command input bar** — real editable text field with:
  - [x] Full mouse cursor positioning, text selection, copy/paste
  - [x] Multi-line editing (Shift+Enter for newline)
  - [x] Command history (Up/Down arrows)
  - [x] Enter to submit, Ctrl+C to cancel/clear
- [x] **Dual focus system** — command mode (input bar) + raw mode (terminal clicks):
  - [x] Input bar: type full commands, send on Enter (for shell, Claude prompts, etc.)
  - [x] Terminal click: raw keystrokes go to terminal (for menus, Y/n, password prompts)
- [x] **Auto-detection** — automatically switches between modes:
  - [x] Detects interactive menus ("Enter to confirm", "Y/n", numbered choices) → raw mode
  - [x] Detects text prompts (shell `$`/`%`, Claude `❯`, REPL `>>>`) → input bar mode
  - [x] Checks last 5 lines (not just last) to handle status bars below prompts
  - [x] Manual override (click) pauses auto-detect for 5 seconds
  - [x] Rolling output buffer (last 3000 chars) for reliable pattern matching
- [x] **TUI app detection** — auto-passthrough for vim/nano/htop/less (alternate screen buffer)
- [x] **Contextual slash commands** — autocomplete dropdown for Claude Code commands:
  - [x] Only shows when Claude is detected as running
  - [x] Tab/Arrow navigation, Enter to select
  - [x] Hardcoded list (16 commands) — TODO: parse from Claude's /help output
- [x] Focus indicator bar showing current mode

### Phase 2 - Full Editor [DONE]
- [x] Monaco editor replaces read-only file preview
- [x] Syntax highlighting for 30+ languages (auto-detected by extension)
- [x] File editing and saving (Cmd/Ctrl+S writes to disk)
- [x] Find/replace within files (Monaco built-in)
- [x] Multiple tabs with unsaved indicators (● dot on dirty tabs)
- [x] Minimap enabled
- [x] CozyPane dark theme for Monaco (matching purple/cozy palette)
- [x] Monaco web workers configured for JSON, CSS, HTML, TypeScript
- [x] Bracket pair colorization and guides
- [x] Sidebar follows terminal cwd (lsof-based PTY cwd detection)
- [x] Three-column file browser narrower (180px) for more preview space
- [x] `fs:writefile` IPC handler for saving files from renderer
- [x] `terminal:getCwd` IPC handler — queries PTY process cwd via lsof on macOS, /proc on Linux

### Phase 3 - AI Activity Tracking [DONE]
- [x] File change detection via `fs.watch` (recursive, with dedup and noise filtering)
- [x] Activity feed panel — real-time log of created/modified/deleted files with timestamps
- [x] Highlight modified files in sidebar (color-coded: green=new, yellow=modified, red=deleted)
- [x] Sidebar live updates — new/deleted files appear/disappear instantly from watcher events
- [x] Panel tab bar — toggle between Editor, Activity, Chat, and Settings tabs
- [x] Smart filtering — ignores Library/, .git/, node_modules/, .DS_Store, temp files, etc.
- [x] Deduplication — macOS duplicate events suppressed (500ms window)
- [x] Terminal scrollbar fix — thin styled scrollbar, no longer overlays content
- [x] Diff viewer — Monaco diff editor, file snapshots with git fallback for originals
- [x] Token usage / cost tracking — best-effort parsing of Claude Code output, shown in status bar
- [x] Conversation history — tracks user inputs + assistant output, chat-like UI tab
- [x] Safety indicators — green/yellow/red/blue/purple status dots for idle/reading/writing/executing/thinking
- [x] Plain English summaries — user-configurable LLM API (Anthropic/OpenAI) with Settings tab
- [x] Settings panel — provider/model/API key selection with OS-level encryption (safeStorage)

### Phase 4 - Git Integration
- [ ] Git status panel (branches, staged changes, commit history)
- [ ] Visual diff viewer
- [ ] One-click undo/revert of AI's last change
- [ ] Commit from UI

### Phase 5 - UX for Beginners
- [ ] Guided mode - suggested next prompts ("Want to test these changes?", "Want to commit?")
- [ ] File change toast notifications (popups when files created/modified/deleted)
- [ ] Prompt templates/snippets ("fix all TypeScript errors", "add tests for this file")
- [ ] Project templates ("Start a React app", "Start a Python API")
- [ ] Drag & drop files into terminal to reference them in prompts
- [ ] Dark/light themes with friendly theme options (not just "hacker green")
- [ ] Dynamic slash command parsing from Claude's /help output

### Phase 6 - Power Features
- [ ] Split view - terminal on one side, file preview on other
- [ ] Session history - browse past AI conversations and file changes
- [ ] Multi-agent view - multiple Claude/AI instances side by side
- [ ] Cost tracker dashboard - tokens/dollars per session with history

### Phase 7 - Polish & Distribution
- [ ] App icon and branding
- [ ] Proper macOS title bar integration
- [ ] Windows installer
- [ ] macOS DMG packaging
- [ ] Auto-updates
- [ ] Onboarding flow for first-time users

---

## Design Principles
1. **Terminal first** — The terminal is the hero, everything else supports it
2. **Cozy, not scary** — Warm colors, friendly UI, no intimidating terminal aesthetics
3. **Transparent** — Always show what AI is doing, never hide actions
4. **Safe** — Undo everything, confirm destructive actions, safety indicators
5. **Smart defaults, manual override** — Auto-detect what mode to be in, but user can always override
6. **Simple first** — Start minimal, add complexity only when needed
7. **Works out of the box** — No configuration needed to get started

## Color Palette
| Token              | Value     | Usage                |
|--------------------|-----------|----------------------|
| --bg-primary       | #1a1b2e   | Main background      |
| --bg-secondary     | #232438   | Sidebar, panels      |
| --bg-tertiary      | #2a2b42   | Nested panels        |
| --bg-hover         | #333456   | Hover states         |
| --bg-active        | #3d3e5c   | Active/selected      |
| --text-primary     | #e4e4f0   | Main text            |
| --text-secondary   | #9394a5   | Secondary text       |
| --text-muted       | #6b6c7e   | Muted/disabled text  |
| --accent           | #7c6ef0   | Purple accent        |
| --accent-hover     | #9488f5   | Accent hover state   |
| --accent-dim       | #4a3fb0   | Selection / raw mode |
| --border           | #333456   | Border color         |
| --success          | #5ce0a8   | Green - safe/reading |
| --warning          | #f0c95c   | Yellow - writing     |
| --danger           | #f06c7e   | Red - destructive    |
| --info             | #5cb8f0   | Blue - informational |

## Terminal Theme
Custom xterm.js theme matching the CozyPane palette. Purple cursor (#7c6ef0), warm pastels for ANSI colors, matching background (#1a1b2e).

## Name Origin
**CozyPane** = "cozy" (friendly, safe, warm) + "pane" (split panels UI). The app makes the terminal feel like a cozy, safe space rather than a scary black box.

## Key Implementation Details

### PTY Environment
- Strips `CLAUDECODE` env var so Claude Code can run inside CozyPane without nesting errors
- Sets `TERM=xterm-256color` and `COLORTERM=truecolor` for full color support
- Detects OS shell automatically (zsh on macOS, powershell on Windows)

### IPC Architecture
Main process exposes APIs via preload script (`window.cozyPane`):
- `terminal.*` - PTY create, write, resize, onData, onExit, getCwd
- `fs.*` - readdir, readfile, writefile, homedir
- `watcher.*` - start, stop, onChange

All communication is through Electron's contextBridge with contextIsolation + sandbox enabled (secure). IPC handlers are split across modules (pty.ts, filesystem.ts, watcher.ts) registered at startup.

### Monaco Editor
- Replaces the read-only FilePreview with a full VS Code editor
- Workers loaded via Vite's `?worker` import syntax (static imports required)
- Custom `cozy-dark` theme matching the CozyPane palette
- Language auto-detected from file extension (30+ languages mapped)
- Cmd/Ctrl+S saves via `fs:writefile` IPC handler
- Dirty state tracked via `model.getAlternativeVersionId()` (O(1), no full content comparison)
- Container div always stays mounted (loading/error render as overlays) to prevent Monaco destruction

### CWD Tracking
- Sidebar file browser follows the terminal's current working directory
- Uses `lsof -a -p PID -d cwd -Fn` on macOS, `/proc/PID/cwd` on Linux
- Finds child processes of the PTY via `ps` to get the actual shell PID
- Polled on output idle (400ms) and 500ms after each command submission
- Sidebar reloads file tree whenever cwd changes

### Smart Input System (Warp-style)
The command input bar is always visible at the bottom of the terminal. Two focus modes:

1. **Command mode** (input bar focused): User types in the editable input bar. Full mouse support, text selection, multi-line. Enter sends to PTY.
2. **Raw mode** (terminal focused): Keystrokes go directly to PTY. For interactive menus, Y/n prompts, password entries.

**Auto-detection** analyzes terminal output when it settles (400ms idle):
- Checks recent output against interactive patterns (menus, confirmations) → switches to raw
- Checks last 5 lines for text prompt patterns (shell, Claude, REPL) → switches to input bar
- Manual click overrides auto-detection for 5 seconds
- TUI apps (vim, nano, htop) detected via alternate screen buffer → full passthrough

**Slash commands** show as autocomplete dropdown when typing `/` inside Claude Code:
- Currently hardcoded list of 16 standard Claude Code commands
- Only visible when Claude is detected as the active process
- TODO: Parse dynamically from Claude's `/help` output

### Output Analysis (ANSI Stripping)
Terminal output contains heavy ANSI escape sequences. The `stripAnsi()` function removes:
- CSI sequences: `\x1b[...m` (colors, cursor movement)
- OSC sequences: `\x1b]...BEL` (title, hyperlinks)
- Other escape sequences and control characters
A rolling buffer of 3000 chars is maintained for pattern matching.

### Dev Workflow
1. `npm install` then `npx electron-rebuild -f -w node-pty`
2. `node scripts/dev.mjs` starts Vite + Electron with hot reload
3. Dev script auto-detects Vite's port and passes to Electron via `VITE_DEV_PORT` env var

### Sidebar File Browser
- Immutable state updates (updateNode pattern) for React compatibility
- Lazy loading: only fetches directory contents on expand
- Hidden files filtered (except .env)
- Sorted: directories first, then alphabetical

### Agreed Feature Details (from initial discussion)

**All 11 proposed features approved for implementation:**
1. Git integration panel (Phase 4)
2. Diff viewer (Phase 3/4)
3. Undo button for AI changes (Phase 4)
4. Project templates (Phase 5)
5. Session history (Phase 6)
6. Split view (Phase 6)
7. Dark/light themes (Phase 5)
8. Drag & drop files to terminal (Phase 5)
9. Prompt templates/snippets (Phase 5)
10. Cost tracker (Phase 6)
11. Multi-agent view (Phase 6)

**All 4 "Vibe Coder Safety" features approved:**
1. Safety net indicators - green/yellow/red for read/write/execute (Phase 3)
2. Plain English summaries after AI finishes (Phase 3)
3. Guided mode - suggested next prompts (Phase 5)
4. File change toast notifications (Phase 5)
