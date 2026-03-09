# CozyPane

A cozy terminal for AI coding tools. Run Claude Code, Codex, Aider, and other AI CLI tools in a purpose-built environment with smart input, a built-in editor, cost tracking, and more.

**CozyPane makes the terminal feel like a cozy, safe space — not a scary black box.**

Built for beginners who've never used a terminal but want to use AI coding tools. Also great for experienced developers who want a better AI coding workflow.

## Features

- **Smart Input** — Warp-style editable command bar with slash commands, history, and multi-line support. Auto-detects when to use the input bar vs raw terminal mode.
- **Monaco Editor** — Full VS Code editor built in. Edit files side-by-side with your terminal.
- **AI Activity Tracking** — See every file your AI tool touches in real time with change summaries.
- **Diff Viewer** — Monaco-powered side-by-side diffs for every file change.
- **Multi-Terminal** — Tabs and split view. Run multiple AI sessions or a shell alongside your coding agent.
- **Cost Tracking** — See how much each AI session costs in real time.
- **Conversation History** — Chat-like view of your prompts and AI responses.
- **AI Summaries** — One-click plain English summaries of what your coding agent changed.
- **Themes** — Cozy Dark, Ocean, Forest, and Light themes.
- **Command Palette** — Cmd+K to quickly access any action.
- **Cross-Platform** — macOS (Apple Silicon + Intel), Windows, and Linux.

## Download

Pre-built binaries are available at [cozypane.com](https://cozypane.com).

## Build from Source

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- npm

### Setup

```bash
cd cozypane
npm install
npx electron-rebuild -f -w node-pty
```

### Development

```bash
node scripts/dev.mjs
```

This starts Vite (hot-reload renderer) and Electron together. The dev script auto-detects Vite's port.

### Build

```bash
npm run build          # Build main + renderer
npm run dist:mac       # Package for macOS
npm run dist:win       # Package for Windows
npm run dist:linux     # Package for Linux
```

Built artifacts go to `cozypane/release/`.

## Tech Stack

- **Electron** — Same foundation as VS Code, Cursor, and Warp
- **React + TypeScript** — Frontend UI
- **xterm.js + node-pty** — Full PTY terminal (bash/zsh/powershell)
- **Monaco Editor** — VS Code's editor component
- **Vite** — Fast dev server and bundler

## Architecture

See [ARCHITECTURE.md](cozypane/ARCHITECTURE.md) for detailed technical documentation, design decisions, and the feature roadmap.

## Contributing

Contributions are welcome! Here's how to get started:

1. Fork the repo
2. Create a feature branch (`git checkout -b my-feature`)
3. Make your changes
4. Test locally with `node scripts/dev.mjs`
5. Commit and push
6. Open a pull request

For bugs and feature requests, please [open an issue](https://github.com/speudoname/cozypane/issues).

## License

[MIT](LICENSE) — free and open source.
