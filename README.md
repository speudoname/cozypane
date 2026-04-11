# CozyPane

A cozy terminal for AI coding tools. Run Claude Code, Codex, Aider, and other AI CLI tools in a purpose-built environment with smart input, a built-in editor, an integrated Git panel, one-click cloud deploys, and more.

**CozyPane makes the terminal feel like a cozy, safe space — not a scary black box.**

Built for beginners who've never used a terminal but want to use AI coding tools. Also great for experienced developers who want a better AI coding workflow.

## Features

- **Smart Input** — Warp-style editable command bar with slash commands, history, and multi-line support. Auto-detects when to use the input bar vs raw terminal mode for interactive TUIs.
- **Monaco Editor** — Full VS Code editor built in. Edit files side-by-side with your terminal, with image/video/audio/PDF preview fallbacks.
- **File Sidebar** — Follows your terminal's working directory. Inline rename, create, delete, and color-coded indicators for files your AI has modified.
- **Diff Viewer** — Monaco-powered side-by-side diffs for every file change tracked by the built-in watcher.
- **Multi-Terminal** — Tabs and split view. Run multiple AI sessions or a shell alongside your coding agent.
- **Git Panel** — Full status/commit/push/pull from inside the app, including GitHub OAuth, repo create/connect, AI-generated commit messages, and a "Revert AI Changes" button scoped to watcher events.
- **Deploy to the Cloud** — One-click deploy to [CozyPane Cloud](https://cozypane.com), a PaaS for Node, Python, Go, and static projects. Includes PostgreSQL provisioning, custom domains, and live log streaming.
- **MCP Integration** — Exposes `cozypane_deploy`, `cozypane_list_deployments`, `cozypane_get_logs`, and other tools directly to Claude Code, so you can deploy with a prompt.
- **Preview Panel** — Built-in webview with mobile/tablet/desktop device modes, console log capture, network error tracking, and a "Send to Claude" button that bridges browser context into your AI session.
- **Themes** — Cozy Dark, Ocean, Forest, and Cozy Light themes. Terminal, editor, and diff viewer all switch in sync.
- **Command Palette** — Cmd+K to quickly access any action.
- **Auto-Update** — Built-in updater that pulls new versions from GitHub Releases, plus a dependency checker for Homebrew + `claude` CLI.
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
