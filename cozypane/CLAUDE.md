# CozyPane

## Release Process

Releases are fully automated via GitHub Actions. **Do NOT build locally or upload artifacts.**

1. Bump version in `package.json`
2. Commit and tag: `git tag v<version>`
3. Push: `git push origin main --tags`
4. GitHub Actions builds Mac/Win/Linux and publishes to GitHub Releases automatically
5. Use `gh run list --limit 1` to monitor

Use `/release` skill to automate all steps.

## Dev

- `node scripts/dev.mjs` — launch dev (Vite + Electron)
- `npx tsc -p tsconfig.main.json` — build main process
- `npx electron-rebuild -f -w node-pty` — required after installing deps
- PTY env must set `CLAUDECODE: ''` for Claude Code to work inside CozyPane

## Key Conventions

- `package.json` author field must be string: `"CozyPane <levan@sarke.ge>"`
- Monaco container must always stay mounted (no conditional early returns)
- Use full paths for system commands in Electron (e.g., `/usr/sbin/lsof`)
- Monaco workers: use static `?worker` imports (Vite rejects dynamic template strings)
