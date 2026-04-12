# DevServerManager — Auto Dev Server + Preview

## Status: IMPLEMENTED (2026-04-12)

## What It Does
When you open a web project in CozyPane, the DevServerManager:
1. **Auto-detects** the project type (vite, next, react, etc.)
2. **Auto-starts** the dev server in a companion "Dev Server" terminal tab
3. **Health-checks** the URL (retries up to 10x, 800ms apart)
4. **Auto-opens** the Preview panel once the server responds
5. Shows a **toast notification** with the detected URL

## Architecture

### Flow: Open Project → Preview
```
launchOpenProject(cwd)
  → updateTab (Claude tab, launched)
  → maybeSpawnDevServer(cwd)
      → detectProject(cwd) → devCommand found?
      → suggestPort() → available port
      → addTerminalTab("Dev Server", autoCommand: "npm run dev --port 5173")
      → switchTerminalTab(mainTabId) ← back to Claude tab
      ...
Dev Server tab (background):
  → Terminal.tsx captures output (URL detection runs even for hidden tabs)
  → detectLocalUrls() finds http://localhost:5173
  → onLocalUrlDetected(url) fires
      → cwd matches active tab → propagates URL to App-level preview state
      → health-check: fetch(url, {mode:'no-cors'})
      → retries up to 10× if server not ready yet
      → setPreviewOpen(true) + toast
```

### Key Design Decisions
- **Companion tab pattern**: Dev server runs in its own tab, not the Claude tab
- **URL detection always runs**: Terminal.tsx runs detectLocalUrls() for ALL tabs, even hidden ones. Only focus/action analysis is skipped for hidden tabs.
- **cwd-based linkage**: Companion tab is linked to the main tab by matching `cwd`, not by explicit ID reference
- **Health check before open**: fetch() with no-cors mode, 10 retries at 800ms intervals
- **One auto-open per tab**: `devServerAutoOpened` flag prevents re-triggering
- **Switch back to Claude**: After spawning dev server tab, immediately switches back to the main tab
- **Server-only exclusion**: express/fastify/koa/hapi/nest projects are skipped (no UI to preview)

### Edge Cases
| Scenario | Behavior |
|---|---|
| First URL detected (active or companion tab) | Health-check → auto-open preview + toast |
| Same URL re-detected | No action (devServerAutoOpened flag set) |
| Background tab detects URL | Propagated if cwd matches active tab |
| Tab switch to tab with companion | Restores URL from companion dev server tab |
| User closes preview manually | Won't re-open (flag set) |
| New project, new tab | Fresh flag → full auto-start + auto-open |
| Server-only project (express etc.) | No companion tab spawned |
| Auto-preview disabled | No spawn, no auto-open, no toast |
| Server not ready yet | Retries fetch up to 10× (8s total) |
| Port conflict | suggestPort() finds available port |

## Files Modified
- `src/renderer/types.d.ts` — `devServerAutoOpened?: boolean` on TerminalTab
- `src/renderer/App.tsx` — maybeSpawnDevServer, companion tab URL propagation, health-check, toast, toggle
- `src/renderer/components/Terminal.tsx` — URL detection runs for all tabs (not just visible)
- `src/renderer/styles/global.css` — toast animation + styles
