# FloatPlay

Paste a link, watch it in a floating always-on-top mini player over any app — like Arc's picture-in-picture, but for anything with a URL.

**License:** [MIT](./LICENSE)

## Install (macOS)

1. Grab the latest `.dmg` from [Releases](https://github.com/linder0/floatplay/releases).
2. Open the disk image and drag **FloatPlay** into Applications.
3. First launch: right-click the app → **Open** (Gatekeeper; builds are currently unsigned).
4. Look for **▶** in the menu bar — there's no Dock icon.

### Build a local `.app`

```bash
npm install
npm run build:mac
```

Artifacts land in `dist/` (`FloatPlay-0.1.0-<arch>.dmg` and `.zip`).

Windows: `npm run build:win` · Linux: `npm run build:linux`

## How it works

- **`⌘⇧Y`** / **`Ctrl+Shift+Y`** (global): plays the URL on your clipboard. If the clipboard isn't a URL, a Spotlight-style input pops up instead.
- **`⌘⇧H`** / **`Ctrl+Shift+H`**: hide/show all player windows (playback continues).
- **Menu bar `▶`**: Play from Clipboard, Open Link…, per-player toggles, quit.
- Player windows float above every app (including native-fullscreen Spaces) and are non-activating panels — clicking pause/scrub never steals keyboard focus from what you're working on.
- Chrome strip controls: ghost mode (dims the window), passive mode (fades on hover), audio-only, reload, close. Drag the strip to move, drag edges to resize. Multiple players cascade.

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

## Security

FloatPlay is a **mini browser for URLs you paste**. Treat it like opening a link in Chrome:

- Only load links you trust.
- Remote pages run in a sandboxed `WebContentsView` with **no preload**, so they cannot call the app's IPC.
- Only the local chrome UI (control pill / resize grips / open prompt) has the preload bridge.
- Popups and "watch on site" links open in your real browser.

YouTube embeds need an HTTP `Referer` or they fail with Error 153. FloatPlay sends `https://floatplay.app/` as a neutral third-party origin for YouTube requests (the domain is not required to resolve).

No analytics or telemetry.

## Architecture notes

- Menu-bar-only on macOS (`LSUIElement` + accessory activation policy) — no Dock icon.
- Remote content is isolated from the privileged chrome views (see Security above).

## Development

```bash
npm install
npm run dev        # dev with HMR
npm run build      # production build to out/
npm run start      # preview the production build
npm run typecheck
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for PR guidelines and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

### Cutting a release

```bash
git tag v0.1.0
git push origin v0.1.0
```

That triggers [.github/workflows/release.yml](./.github/workflows/release.yml), which builds macOS / Windows / Linux and attaches artifacts to a **draft** GitHub Release. Review and publish when ready.
