# DevServerManager — Auto-Preview on Dev Server Detection

## Status: IMPLEMENTED (2026-04-12)

## What It Does
When a dev server URL (e.g., `http://localhost:3000`) is first detected in terminal output,
CozyPane automatically opens the Preview panel and shows a toast notification.

## Architecture

### Phase 1: Core Auto-Open
- **TerminalTab.devServerAutoOpened** (`types.d.ts`) — boolean flag, tracks if preview was auto-opened for this tab
- **App.tsx onLocalUrlDetected callback** — checks `!fresh.devServerAutoOpened && !autoPreviewDisabledRef.current`, then calls `setPreviewOpen(true)` and marks the tab

### Phase 2: Robustness
- **Background tab deferred** — only auto-opens for the active terminal tab
- **Tab switch catch-up** — when switching to a tab that detected a URL in the background, auto-opens if `!devServerAutoOpened`
- **User manual close respected** — once `devServerAutoOpened` is set, preview won't re-open on subsequent URL detections
- **Toast notification** — "Dev server detected — Preview opened" with URL, auto-dismisses after 4s

### Phase 3: Polish
- **localStorage toggle** — `cozyPane:autoPreviewDisabled` (default: false = auto-preview ON)
- **Command palette action** — "Auto-Preview on Dev Server: ON/OFF" toggle
- **Type-check verified** — both renderer and main process compile clean

## Files Modified
- `src/renderer/types.d.ts` — added `devServerAutoOpened?: boolean` to TerminalTab
- `src/renderer/App.tsx` — auto-open logic, toast state, command palette action, toggle
- `src/renderer/styles/global.css` — toast animation and styles

## Edge Cases Handled
| Scenario | Behavior |
|---|---|
| First URL detected in active tab | Auto-opens preview + toast |
| Same URL re-detected | No action (flag already set) |
| Different URL on same tab | No re-open (flag already set) |
| Background tab detects URL | Deferred until tab switch |
| User closes preview manually | Won't re-open (flag set) |
| New tab, new server | Fresh flag → auto-opens |
| Auto-preview disabled | No auto-open, no toast |
