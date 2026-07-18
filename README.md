# FloatPlay

Paste a link, watch it in a floating always-on-top mini player over any app — like Arc's picture-in-picture, but for anything with a URL.

## How it works

- **`⌘⇧Y`** (global): plays the URL on your clipboard. If the clipboard isn't a URL, a Spotlight-style input pops up instead.
- **Menu bar `▶`**: "Play from Clipboard", "Open Link…", "Close All Players", quit.
- Player windows float above every app (including native-fullscreen Spaces) and are non-activating panels — clicking pause/scrub never steals keyboard focus from what you're working on.
- Chrome strip controls: **◐** ghost mode (dims the window to 45%), **↻** reload, **✕** close. Drag the strip to move, drag edges to resize. Multiple players cascade.

## Supported links

| Source | Handling |
| --- | --- |
| YouTube (watch / shorts / live / youtu.be, with `t=` and playlists) | bare embed player |
| Vimeo | bare embed player |
| Twitch (channels and VODs) | bare embed player |
| Loom | bare embed player |
| Direct media (`.mp4`, `.webm`, `.mov`, `.mp3`, …) | minimal built-in `<video>` player |
| Anything else | loaded as-is (tiny floating browser) |

Netflix/Disney+ and other DRM services won't play — stock Electron has no Widevine.

## Architecture notes

- Remote pages load in a sandboxed `WebContentsView` with **no preload**, so pasted sites can never reach the app's IPC. Only the 34px chrome strip (our own UI) has the preload bridge.
- Popups and "watch on site" links open in your real browser.
- Menu-bar-only app (accessory activation policy) — no Dock icon.

## Development

```bash
npm install
npm run dev        # dev with HMR
npm run build      # production build to out/
npm run start      # preview the production build
npm run typecheck
```

To package it as a distributable `.app`, add [electron-builder](https://www.electron.build/) with `LSUIElement: true` in the mac config (keeps it out of the Dock).
