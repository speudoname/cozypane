# Contributing to CozyPane

Thanks for your interest in contributing! CozyPane is a community project and we welcome contributions of all kinds.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- npm
- Git

### Development Setup

The repository root contains both the desktop app (`cozypane/`) and the
cloud backend (`cozypane-cloud/`). Most contributions will be inside
`cozypane/` — these commands assume that.

```bash
git clone https://github.com/speudoname/cozypane.git
cd cozypane/cozypane            # desktop app subdirectory
npm install
npx electron-rebuild -f -w node-pty
node scripts/dev.mjs
```

This starts Vite (hot-reload) and Electron together.

To work on the cloud backend instead:

```bash
cd cozypane/cozypane-cloud
npm install
cp .env.example .env            # fill in secrets (see comments)
docker compose up --build       # starts Traefik + api + postgres
```

### Project Structure

Two codebases live in this repo:

**Desktop app (`cozypane/`):**
- `src/main/` — Electron main process: PTY, filesystem, IPC, Git, Deploy client, MCP server, preview static server
- `src/renderer/` — React frontend (components, styles, lib)
- `src/renderer/components/` — UI components (Terminal, FilePreview/Monaco, Sidebar, DeployPanel, GitPanel, Preview, etc.)
- `src/renderer/lib/` — Utilities (`terminalAnalyzer`, `languageMap`, `shellUtils`, `cozyMode`, `monacoThemes`)
- `website/` — Landing page (static HTML/CSS/JS, served via Cloudflare Pages)
- `scripts/` — Dev launcher (`dev.mjs`)

**Cloud backend (`cozypane-cloud/`):**
- `src/routes/` — Fastify HTTP routes (auth, deploy, admin, health)
- `src/services/` — Docker builder, container lifecycle, per-deployment Postgres, project detector, cleanup helper
- `src/middleware/` — JWT auth, admin gate
- `src/db/` — PostgreSQL pool + schema
- `docker-compose.yml` — Traefik + API + Postgres orchestration

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
