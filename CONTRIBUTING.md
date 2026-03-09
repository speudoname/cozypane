# Contributing to CozyPane

Thanks for your interest in contributing! CozyPane is a community project and we welcome contributions of all kinds.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- npm
- Git

### Development Setup

```bash
git clone https://github.com/speudoname/cozypane.git
cd cozypane/cozypane
npm install
npx electron-rebuild -f -w node-pty
node scripts/dev.mjs
```

This starts Vite (hot-reload) and Electron together.

### Project Structure

- `src/main/` — Electron main process (PTY, filesystem, IPC)
- `src/renderer/` — React frontend (components, styles)
- `src/renderer/components/` — UI components (Terminal, Editor, Sidebar, etc.)
- `src/renderer/lib/` — Utilities (terminal analysis, language map)
- `website/` — Landing page (static HTML/CSS/JS)
- `scripts/` — Dev and build scripts

See [ARCHITECTURE.md](cozypane/ARCHITECTURE.md) for detailed technical docs.

## How to Contribute

### Reporting Bugs

- Open an issue at [github.com/speudoname/cozypane/issues](https://github.com/speudoname/cozypane/issues)
- Include your OS, CozyPane version, and steps to reproduce
- Screenshots or terminal output are very helpful

### Suggesting Features

- Open an issue with the "feature request" label
- Describe what you want and why it would be useful

### Submitting Code

1. Fork the repo
2. Create a feature branch (`git checkout -b my-feature`)
3. Make your changes
4. Test locally with `node scripts/dev.mjs`
5. Commit with a clear message
6. Push and open a pull request

### Code Style

- TypeScript for all source code
- React functional components with hooks
- Keep components focused — one responsibility per file
- No unnecessary abstractions or over-engineering

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
