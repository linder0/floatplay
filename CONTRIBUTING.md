# Contributing to FloatPlay

Thanks for wanting to help. Small, focused changes are easiest to review.

## Development

```bash
npm install
npm run dev
npm run typecheck
```

- **`⌘⇧Y` / `Ctrl+Shift+Y`**: play the URL on the clipboard (or open the link prompt)
- **`⌘⇧H` / `Ctrl+Shift+H`**: hide/show all players
- Menu bar **▶**: tray actions

## Project layout

| Path | Role |
| --- | --- |
| `src/main/` | Electron main process (windows, tray, IPC, embeds) |
| `src/preload/` | Thin `contextBridge` API for chrome UI only |
| `src/renderer/` | React UI (control pill, resize grips, open-link prompt, video page) |

Remote pages load in a sandboxed `WebContentsView` with **no preload**. Keep it that way — never attach the app preload to untrusted content.

## Pull requests

1. Keep PRs scoped to one change when you can.
2. Run `npm run typecheck` before opening a PR.
3. Update the README if you change shortcuts, supported links, or packaging.

## Releases

Tagged versions (`v0.1.0`, …) trigger the GitHub Actions release workflow, which builds macOS / Windows / Linux artifacts and attaches them to a draft GitHub Release.
