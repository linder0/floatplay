import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  Tray,
  WebContentsView
} from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { toEmbedTarget } from './embed'

/** Size of the host view for the floating control pill (sized to leave room for
 * the pill, its drop shadow, and the tooltips below it; centered inside). */
const TAB_WIDTH = 260
const TAB_HEIGHT = 74
/** Height of the bottom media transport bar's host view. */
const BAR_HEIGHT = 56
/** Locked video aspect ratio (players are 16:9 embeds). */
const VIDEO_ASPECT = 16 / 9
/** Gutter left around the video view so the window's native resize edges are grabbable. */
const RESIZE_BORDER = 3
/** Reserved strip above the video that holds the control pill (so it never
 * overlaps the video content). */
const PILL_STRIP = 44
/** Smallest a player can be resized to (video area stays 16:9). */
const MIN_WIDTH = 240
const MIN_HEIGHT = Math.round((MIN_WIDTH - RESIZE_BORDER * 2) / VIDEO_ASPECT) + PILL_STRIP + RESIZE_BORDER
/** Height of a player collapsed to audio-only: just the pill strip + transport bar. */
const HIDDEN_HEIGHT = PILL_STRIP + BAR_HEIGHT + RESIZE_BORDER
/** Window opacity while "ghost" mode dims a player into the background. */
const GHOST_OPACITY = 0.45
/** Window opacity while "passive" mode fades a hovered player out of the way. */
const PASSIVE_OPACITY = GHOST_OPACITY

// Embeds autoplay with sound; without this Chromium requires a user gesture
// per page. Must be set before app ready.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const preload = join(__dirname, '../preload/index.js')

// Held in module scope so the menu-bar item isn't garbage-collected.
let tray: Tray | null = null
let openWindow: BrowserWindow | null = null
const players = new Map<
  number,
  {
    win: BrowserWindow
    view: WebContentsView
    controls: WebContentsView
    transport: WebContentsView
    title: string
  }
>()
// Maps a control view's webContents id back to its owning player window,
// since a WebContentsView is not itself a BrowserWindow.
const controlsOwner = new Map<number, number>()
// Per-window media-state polling timers (drive the transport bar).
const stateTimers = new Map<number, NodeJS.Timeout>()

/** Resolve the player window that sent an IPC message from any of its views. */
function ownerWindow(sender: Electron.WebContents): BrowserWindow | null {
  const direct = BrowserWindow.fromWebContents(sender)
  if (direct) return direct
  const winId = controlsOwner.get(sender.id)
  return winId != null ? (players.get(winId)?.win ?? null) : null
}
// Per-window cursor-follow timers driving custom title-strip dragging.
const dragTimers = new Map<number, NodeJS.Timeout>()
// Per-window cursor-hover polling timers: reveal the tab and drive passive fade.
const hoverTimers = new Map<number, NodeJS.Timeout>()

// Visual-effect state per player, resolved into a single window opacity.
// `hidden` collapses the player to an audio-only bar (video pane hidden,
// playback continues).
type PlayerFx = { ghost: boolean; passive: boolean; hovering: boolean; hidden: boolean }
const playerFx = new Map<number, PlayerFx>()
// Content size to restore a player to when it leaves audio-only mode.
const savedSizes = new Map<number, [number, number]>()

function fxFor(id: number): PlayerFx {
  let fx = playerFx.get(id)
  if (!fx) {
    fx = { ghost: false, passive: false, hovering: false, hidden: false }
    playerFx.set(id, fx)
  }
  return fx
}

function applyOpacity(win: BrowserWindow): void {
  const fx = fxFor(win.id)
  win.setOpacity(fx.passive && fx.hovering ? PASSIVE_OPACITY : fx.ghost ? GHOST_OPACITY : 1)
}

/** Push the current toggle state to a player's pill so its buttons stay in sync
 * regardless of whether the change came from the pill or the tray menu. */
function syncControls(winId: number): void {
  const p = players.get(winId)
  if (!p) return
  const fx = fxFor(winId)
  p.controls.webContents.send('player:state', {
    ghost: fx.ghost,
    passive: fx.passive,
    hidden: fx.hidden
  })
}

/** Position the video, pill, and transport views for a player's window. In
 * audio-only mode the video pane is hidden and the window collapses so only the
 * pill strip and transport bar remain. */
function layoutPlayer(winId: number): void {
  const p = players.get(winId)
  if (!p || p.win.isDestroyed()) return
  const { win, view, controls, transport } = p
  const [w, h] = win.getContentSize()
  const fx = fxFor(winId)

  controls.setBounds({ x: Math.round((w - TAB_WIDTH) / 2), y: 0, width: TAB_WIDTH, height: TAB_HEIGHT })

  if (fx.hidden) {
    view.setVisible(false)
    // Transport sits directly under the pill strip as the audio-only control bar.
    transport.setBounds({ x: RESIZE_BORDER, y: PILL_STRIP, width: Math.max(0, w - RESIZE_BORDER * 2), height: BAR_HEIGHT })
    return
  }

  view.setVisible(true)
  view.setBounds({
    x: RESIZE_BORDER,
    y: PILL_STRIP,
    width: Math.max(0, w - RESIZE_BORDER * 2),
    height: Math.max(0, h - PILL_STRIP - RESIZE_BORDER)
  })
  transport.setBounds({
    x: RESIZE_BORDER,
    y: Math.max(0, h - BAR_HEIGHT),
    width: Math.max(0, w - RESIZE_BORDER * 2),
    height: BAR_HEIGHT
  })
}

/** In audio-only mode the transport bar is always shown (it's the only control
 * surface); otherwise it only appears while the cursor is over the player. */
function updateTransportVisibility(winId: number): void {
  const p = players.get(winId)
  if (!p) return
  const fx = fxFor(winId)
  p.transport.setVisible(fx.hidden || fx.hovering)
}

function setGhostMode(win: BrowserWindow, value: boolean): void {
  fxFor(win.id).ghost = value
  applyOpacity(win)
  syncControls(win.id)
  rebuildTray()
}

function setPassiveMode(win: BrowserWindow, value: boolean): void {
  fxFor(win.id).passive = value
  applyOpacity(win)
  syncControls(win.id)
  rebuildTray()
}

/** Toggle audio-only mode: hide the video pane and shrink the window down to a
 * compact media bar, keeping playback (and thus audio) alive. */
function setHiddenMode(win: BrowserWindow, value: boolean): void {
  const fx = fxFor(win.id)
  if (fx.hidden === value) return
  fx.hidden = value

  if (value) {
    savedSizes.set(win.id, win.getContentSize() as [number, number])
    // Drop the 16:9 lock and the video-sized minimum so we can collapse.
    win.setAspectRatio(0)
    win.setMinimumSize(MIN_WIDTH, HIDDEN_HEIGHT)
    win.setResizable(false)
    const [w] = win.getContentSize()
    win.setContentSize(w, HIDDEN_HEIGHT)
  } else {
    win.setResizable(true)
    win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT)
    win.setAspectRatio(VIDEO_ASPECT, { width: RESIZE_BORDER * 2, height: PILL_STRIP + RESIZE_BORDER })
    const saved = savedSizes.get(win.id)
    if (saved) win.setContentSize(saved[0], saved[1])
  }

  layoutPlayer(win.id)
  updateTransportVisibility(win.id)
  syncControls(win.id)
  rebuildTray()
}

function stopDrag(winId: number): void {
  const timer = dragTimers.get(winId)
  if (timer) {
    clearInterval(timer)
    dragTimers.delete(winId)
  }
}

function stopHover(winId: number): void {
  const timer = hoverTimers.get(winId)
  if (timer) {
    clearInterval(timer)
    hoverTimers.delete(winId)
  }
}

function stopState(winId: number): void {
  const timer = stateTimers.get(winId)
  if (timer) {
    clearInterval(timer)
    stateTimers.delete(winId)
  }
}

/** Read the current media state from whatever player lives in a video view.
 * Works for YouTube (its internal #movie_player API) and any same-origin page
 * with a raw <video> element (Vimeo, Loom, direct files, …). */
const MEDIA_STATE_JS = `(function () {
  try {
    var p = document.querySelector('#movie_player')
    if (p && typeof p.getCurrentTime === 'function' && typeof p.getDuration === 'function') {
      var d = p.getDuration()
      if (d && d > 0) {
        return {
          t: p.getCurrentTime(),
          d: d,
          playing: p.getPlayerState && p.getPlayerState() === 1,
          vol: (p.getVolume ? p.getVolume() : 100) / 100,
          muted: p.isMuted ? p.isMuted() : false
        }
      }
    }
    var v = document.querySelector('video')
    if (v && !isNaN(v.duration)) {
      return { t: v.currentTime, d: v.duration, playing: !v.paused, vol: v.volume, muted: v.muted }
    }
  } catch (e) {}
  return null
})()`

/** Build a snippet that applies a transport command to the active player. */
function mediaCommandJS(action: string, value: number): string {
  return `(function () {
    var action = ${JSON.stringify(action)}, val = ${Number(value) || 0}
    var p = document.querySelector('#movie_player')
    var yt = p && typeof p.getPlayerState === 'function'
    var v = document.querySelector('video')
    try {
      if (action === 'playpause') {
        if (yt) { p.getPlayerState() === 1 ? p.pauseVideo() : p.playVideo() }
        else if (v) { v.paused ? v.play() : v.pause() }
      } else if (action === 'seek') {
        if (yt) p.seekTo(val, true); else if (v) v.currentTime = val
      } else if (action === 'volume') {
        if (yt) { if (p.unMute) p.unMute(); if (p.setVolume) p.setVolume(val * 100) }
        else if (v) { v.muted = false; v.volume = val }
      } else if (action === 'mute') {
        if (yt) { (p.isMuted && p.isMuted()) ? p.unMute() : p.mute() }
        else if (v) { v.muted = !v.muted }
      }
    } catch (e) {}
  })()`
}

function mediaCommand(sender: Electron.WebContents, action: string, value: number): void {
  const win = ownerWindow(sender)
  if (!win) return
  const p = players.get(win.id)
  if (p) void p.view.webContents.executeJavaScript(mediaCommandJS(action, value), true).catch(() => {})
}

/** Load our renderer (dev server or built file) with a hash route. */
function loadRoute(contents: Electron.WebContents, hash: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void contents.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
  } else {
    const fileUrl = pathToFileURL(join(__dirname, '../renderer/index.html'))
    fileUrl.hash = hash
    void contents.loadURL(fileUrl.toString())
  }
}

function createPlayer(rawUrl: string): boolean {
  const target = toEmbedTarget(rawUrl)
  if (!target) return false

  const area = screen.getPrimaryDisplay().workArea
  // Size the window so the video area (below the pill strip, inside the resize
  // gutter) is a clean 16:9.
  const width = 480
  const height =
    Math.round((width - RESIZE_BORDER * 2) / VIDEO_ASPECT) + PILL_STRIP + RESIZE_BORDER
  // Cascade multiple players so they don't stack invisibly on top of each other.
  const offset = (players.size % 5) * 36

  const win = new BrowserWindow({
    x: area.x + area.width - width - 24 - offset,
    y: area.y + area.height - height - 24 - offset,
    width,
    height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    frame: false,
    // Removes the phantom rounded-corner title strip that would otherwise
    // activate our app (stealing focus) when clicked on a panel window.
    roundedCorners: false,
    resizable: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    // Transparent so the pill strip above the video has no background — just the
    // floating pill over whatever is behind the window.
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // NSPanel: floats without activating, so clicking play/pause never steals
    // keyboard focus from the app you're working in.
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: { preload, sandbox: false }
  })
  win.setAlwaysOnTop(true, 'floating')
  // Keep the inner video area locked to 16:9 while resizing (the pill strip and
  // gutter around the view are excluded from the ratio via extraSize).
  win.setAspectRatio(VIDEO_ASPECT, {
    width: RESIZE_BORDER * 2,
    height: PILL_STRIP + RESIZE_BORDER
  })
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: process.platform === 'darwin'
  })

  // The remote page lives in its own sandboxed view with no preload, so pasted
  // sites can never reach our IPC surface.
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  win.contentView.addChildView(view)

  // The control tab lives in its own view added last, so it floats above the
  // video (a child view always paints over the ones added before it).
  const controls = new WebContentsView({
    webPreferences: { preload, sandbox: false }
  })
  controls.setBackgroundColor('#00000000')
  win.contentView.addChildView(controls)
  controlsOwner.set(controls.webContents.id, win.id)

  // Bottom transport bar (play/pause, seek, volume) in its own top-most view.
  const transport = new WebContentsView({
    webPreferences: { preload, sandbox: false }
  })
  transport.setBackgroundColor('#00000000')
  win.contentView.addChildView(transport)
  controlsOwner.set(transport.webContents.id, win.id)

  // The pill lives in its own strip above the video, so it stays visible. The
  // transport bar overlays the video, so it only appears while hovering.
  transport.setVisible(false)

  // Poll the OS cursor so we can react to hover across the whole window,
  // including the separate video view that swallows renderer mouse events.
  hoverTimers.set(
    win.id,
    setInterval(() => {
      if (win.isDestroyed()) return stopHover(win.id)
      const p = screen.getCursorScreenPoint()
      const b = win.getBounds()
      const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
      // Stay revealed mid-drag even if the cursor briefly outruns the window.
      const hovering = inside || dragTimers.has(win.id)
      const fx = fxFor(win.id)
      if (hovering !== fx.hovering) {
        fx.hovering = hovering
        updateTransportVisibility(win.id)
        applyOpacity(win)
      }
    }, 80)
  )

  // Poll media state and feed it to the transport bar so its scrubber/time/
  // play state stay live.
  stateTimers.set(
    win.id,
    setInterval(() => {
      if (win.isDestroyed()) return stopState(win.id)
      void view.webContents
        .executeJavaScript(MEDIA_STATE_JS, true)
        .then((state) => {
          if (!transport.webContents.isDestroyed()) transport.webContents.send('media:state', state)
        })
        .catch(() => {})
    }, 500)
  )

  // Register before the first layout so layoutPlayer() can resolve this window.
  players.set(win.id, { win, view, controls, transport, title: target.title })
  layoutPlayer(win.id)
  win.on('resize', () => layoutPlayer(win.id))

  // Popups (share buttons, "watch on YouTube") go to the real browser instead
  // of spawning unmanaged Electron windows.
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  view.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http:') && !url.startsWith('https:')) e.preventDefault()
  })

  if (target.kind === 'video') {
    loadRoute(view.webContents, `video?src=${encodeURIComponent(target.src)}`)
  } else {
    void view.webContents.loadURL(target.url)
  }
  loadRoute(controls.webContents, 'player')
  loadRoute(transport.webContents, 'transport')

  rebuildTray()
  win.on('closed', () => {
    stopDrag(win.id)
    stopHover(win.id)
    stopState(win.id)
    playerFx.delete(win.id)
    savedSizes.delete(win.id)
    controlsOwner.delete(controls.webContents.id)
    controlsOwner.delete(transport.webContents.id)
    players.delete(win.id)
    rebuildTray()
  })
  // showInactive keeps focus on whatever you're working in — the player floats
  // in without stealing your keyboard, matching the non-activating panel intent.
  controls.webContents.once('did-finish-load', () => win.showInactive())
  return true
}

function showOpenWindow(): void {
  if (openWindow && !openWindow.isDestroyed()) {
    openWindow.show()
    openWindow.focus()
    return
  }
  openWindow = new BrowserWindow({
    width: 480,
    height: 96,
    frame: false,
    transparent: true,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    webPreferences: { preload, sandbox: false }
  })
  openWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: process.platform === 'darwin'
  })
  loadRoute(openWindow.webContents, 'open')
  openWindow.once('ready-to-show', () => {
    openWindow?.show()
    openWindow?.focus()
  })
  // Spotlight-style: clicking anywhere else dismisses it.
  openWindow.on('blur', () => openWindow?.hide())
  openWindow.on('closed', () => {
    openWindow = null
  })
}

/** Global shortcut: play whatever URL is on the clipboard, else ask for one. */
function openFromClipboard(): void {
  const text = clipboard.readText().trim()
  if (!text || !createPlayer(text)) showOpenWindow()
}

/** Build the menu-bar dropdown, listing every open player with its toggles so
 * they're all reachable without hovering the on-video pill. */
function buildTrayMenu(): Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: 'Play from Clipboard', accelerator: 'CommandOrControl+Shift+Y', click: () => openFromClipboard() },
    { label: 'Open Link…', click: () => showOpenWindow() },
    { type: 'separator' }
  ]

  const list = [...players.values()]
  for (const p of list) {
    const fx = fxFor(p.win.id)
    template.push(
      { label: p.title, enabled: false },
      {
        label: 'Ghost — dim window',
        type: 'checkbox',
        checked: fx.ghost,
        click: () => setGhostMode(p.win, !fxFor(p.win.id).ghost)
      },
      {
        label: 'Passive — fade on hover',
        type: 'checkbox',
        checked: fx.passive,
        click: () => setPassiveMode(p.win, !fxFor(p.win.id).passive)
      },
      {
        label: 'Audio only — hide video',
        type: 'checkbox',
        checked: fx.hidden,
        click: () => setHiddenMode(p.win, !fxFor(p.win.id).hidden)
      },
      { label: 'Reload', click: () => p.view.webContents.reload() },
      { label: 'Close', click: () => p.win.close() },
      { type: 'separator' }
    )
  }

  if (list.length > 1) {
    template.push({
      label: 'Close All Players',
      click: () => [...players.values()].forEach(({ win }) => win.close())
    })
    template.push({ type: 'separator' })
  }

  template.push({ label: 'Quit FloatPlay', role: 'quit' })
  return Menu.buildFromTemplate(template)
}

function rebuildTray(): void {
  if (tray) tray.setContextMenu(buildTrayMenu())
}

function createTray(): void {
  if (tray) return
  // A menu-bar title glyph instead of an icon asset keeps the app image-free.
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('▶')
  tray.setToolTip('FloatPlay')
  tray.setContextMenu(buildTrayMenu())
}

app.whenReady().then(() => {
  // Menu-bar-only app: no Dock icon, never activates as a regular app.
  if (process.platform === 'darwin') {
    app.setActivationPolicy('accessory')
    app.dock?.hide()
  }

  // YouTube's embed player rejects playback ("Error 153") unless the request
  // carries an HTTP Referer naming an embedding origin, which top-level Electron
  // navigations don't send. It must be a *third-party* origin: using
  // youtube.com itself is treated as an invalid embed context ("Error 152"), so
  // we present a neutral origin for every YouTube request.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'] },
    (details, callback) => {
      details.requestHeaders['Referer'] = 'https://floatplay.app/'
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  createTray()
  globalShortcut.register('CommandOrControl+Shift+Y', () => openFromClipboard())

  ipcMain.on('player:close', (e) => {
    ownerWindow(e.sender)?.close()
  })

  // "Ghost mode": dim the whole window so it reads as background ambience.
  ipcMain.on('player:ghost', (e, ghost: boolean) => {
    const win = ownerWindow(e.sender)
    if (win) setGhostMode(win, ghost)
  })

  // "Passive mode": fade the player out while the cursor is over it, so it gets
  // out of the way of whatever is behind. Hover is tracked by the per-player
  // poll set up in createPlayer, so here we just flip the flag.
  ipcMain.on('player:passive', (e, passive: boolean) => {
    const win = ownerWindow(e.sender)
    if (win) setPassiveMode(win, passive)
  })

  // "Audio only": collapse the video away but keep it playing in the background.
  ipcMain.on('player:hidden', (e, hidden: boolean) => {
    const win = ownerWindow(e.sender)
    if (win) setHiddenMode(win, hidden)
  })

  ipcMain.on('player:reload', (e) => {
    const win = ownerWindow(e.sender)
    if (win) players.get(win.id)?.view.webContents.reload()
  })

  // Media transport: forwarded to the video view's player via executeJavaScript.
  ipcMain.on('media:playpause', (e) => mediaCommand(e.sender, 'playpause', 0))
  ipcMain.on('media:seek', (e, seconds: number) => mediaCommand(e.sender, 'seek', seconds))
  ipcMain.on('media:volume', (e, volume: number) => mediaCommand(e.sender, 'volume', volume))
  ipcMain.on('media:mute', (e) => mediaCommand(e.sender, 'mute', 0))

  // Custom title-strip drag: follow the OS cursor from the main process so the
  // motion stays smooth even though the video view sits on top of the window
  // (which would otherwise swallow the renderer's mouse events).
  ipcMain.on('player:drag-start', (e) => {
    const win = ownerWindow(e.sender)
    if (!win) return
    const cursor = screen.getCursorScreenPoint()
    const [wx, wy] = win.getPosition()
    const dx = cursor.x - wx
    const dy = cursor.y - wy
    stopDrag(win.id)
    dragTimers.set(
      win.id,
      setInterval(() => {
        if (win.isDestroyed()) return stopDrag(win.id)
        const p = screen.getCursorScreenPoint()
        win.setPosition(p.x - dx, p.y - dy)
      }, 8)
    )
  })

  ipcMain.on('player:drag-end', (e) => {
    const win = ownerWindow(e.sender)
    if (win) stopDrag(win.id)
  })

  ipcMain.on('open:submit', (e, url: string) => {
    if (createPlayer(url)) {
      openWindow?.hide()
    } else {
      e.sender.send('open:invalid')
    }
  })

  ipcMain.on('open:cancel', () => openWindow?.hide())
})

// Tray app: stay alive with zero windows.
app.on('window-all-closed', () => {})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
