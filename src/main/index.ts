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
const TAB_WIDTH = 340
const TAB_HEIGHT = 74
/** Locked video aspect ratio (players are 16:9 embeds). */
const VIDEO_ASPECT = 16 / 9
/** Gutter around the video so resize grips stay clickable outside the embed. */
const RESIZE_BORDER = 12
/** Reserved strip above the video that holds the control pill (so it never
 * overlaps the video content). Sized just tall enough for the compact pill. */
const PILL_STRIP = 34
/** Chrome excluded from the 16:9 lock (side gutters + pill strip + bottom gutter). */
const ASPECT_EXTRA_W = RESIZE_BORDER * 2
const ASPECT_EXTRA_H = PILL_STRIP + RESIZE_BORDER
/** Smallest a player can be resized to (video area stays 16:9). */
const MIN_WIDTH = 240
const MIN_HEIGHT = Math.round((MIN_WIDTH - ASPECT_EXTRA_W) / VIDEO_ASPECT) + ASPECT_EXTRA_H
/** Height of a player collapsed to audio-only: just the pill strip. */
const HIDDEN_HEIGHT = PILL_STRIP + RESIZE_BORDER
/** Coalesce per-window layout work to one pass per event-loop turn while resizing. */
const layoutPending = new Set<number>()
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
type ResizeEdge = 'left' | 'right' | 'bottom'

const players = new Map<
  number,
  {
    win: BrowserWindow
    view: WebContentsView
    controls: WebContentsView
    resize: WebContentsView
    title: string
  }
>()
// Maps a control view's webContents id back to its owning player window,
// since a WebContentsView is not itself a BrowserWindow.
const controlsOwner = new Map<number, number>()

/** Resolve the player window that sent an IPC message from any of its views. */
function ownerWindow(sender: Electron.WebContents): BrowserWindow | null {
  const direct = BrowserWindow.fromWebContents(sender)
  if (direct) return direct
  const winId = controlsOwner.get(sender.id)
  return winId != null ? (players.get(winId)?.win ?? null) : null
}
// Per-window cursor-follow timers driving custom title-strip dragging.
const dragTimers = new Map<number, NodeJS.Timeout>()
// Per-window cursor-follow timers driving edge/corner resize handles.
const resizeTimers = new Map<number, NodeJS.Timeout>()
// Per-window cursor-hover polling timers: reveal the tab and drive passive fade.
const hoverTimers = new Map<number, NodeJS.Timeout>()

// Visual-effect state per player, resolved into a single window opacity.
// `hidden` collapses the player to an audio-only bar (video pane hidden,
// playback continues).
type PlayerFx = { ghost: boolean; passive: boolean; hovering: boolean; hidden: boolean }
const playerFx = new Map<number, PlayerFx>()
// Content size to restore a player to when it leaves audio-only mode.
const savedSizes = new Map<number, [number, number]>()
/** When true, all player windows are hidden (playback continues). */
let playersConcealed = false

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

/** Position the video and pill views for a player's window. In audio-only mode
 * the video pane is hidden and the window collapses to just the pill strip. */
function layoutPlayer(winId: number): void {
  const p = players.get(winId)
  if (!p || p.win.isDestroyed()) return
  const { win, view, controls, resize } = p
  const [w, h] = win.getContentSize()
  const fx = fxFor(winId)

  controls.setBounds({ x: Math.round((w - TAB_WIDTH) / 2), y: 0, width: TAB_WIDTH, height: TAB_HEIGHT })
  resize.setBounds({ x: 0, y: 0, width: w, height: h })

  if (fx.hidden) {
    view.setVisible(false)
    return
  }

  view.setVisible(true)
  view.setBounds({
    x: RESIZE_BORDER,
    y: PILL_STRIP,
    width: Math.max(0, w - ASPECT_EXTRA_W),
    height: Math.max(0, h - ASPECT_EXTRA_H)
  })
}

/** Batch layout during live resize so WebContentsView bounds update once per tick. */
function scheduleLayout(winId: number): void {
  if (layoutPending.has(winId)) return
  layoutPending.add(winId)
  setImmediate(() => {
    layoutPending.delete(winId)
    layoutPlayer(winId)
  })
}

/** Window size that keeps the inner video area at 16:9 for a given video width. */
function sizeFromVideoWidth(videoW: number): { width: number; height: number } {
  const width = Math.max(MIN_WIDTH, Math.round(videoW) + ASPECT_EXTRA_W)
  const height = Math.round((width - ASPECT_EXTRA_W) / VIDEO_ASPECT) + ASPECT_EXTRA_H
  return { width, height }
}

/** Window size that keeps the inner video area at 16:9 for a given video height. */
function sizeFromVideoHeight(videoH: number): { width: number; height: number } {
  const height = Math.max(MIN_HEIGHT, Math.round(videoH) + ASPECT_EXTRA_H)
  const width = Math.round((height - ASPECT_EXTRA_H) * VIDEO_ASPECT) + ASPECT_EXTRA_W
  return { width, height }
}

/** Aspect-lock resize with the dragged edge anchored (left / right / bottom). */
function constrainResize(
  current: Electron.Rectangle,
  next: Electron.Rectangle,
  edge: ResizeEdge
): Electron.Rectangle {
  const videoW = next.width - ASPECT_EXTRA_W
  const videoH = next.height - ASPECT_EXTRA_H

  const sized =
    edge === 'bottom' ? sizeFromVideoHeight(videoH) : sizeFromVideoWidth(videoW)

  const width = sized.width
  const height = sized.height
  const x = edge === 'left' ? current.x + current.width - width : current.x
  const y = current.y

  return { x, y, width, height }
}

/** Grow a start-rect by the cursor delta along the dragged edge, before aspect lock. */
function proposedFromDelta(
  start: Electron.Rectangle,
  dx: number,
  dy: number,
  edge: ResizeEdge
): Electron.Rectangle {
  let { x, y, width, height } = start
  if (edge === 'right') width = start.width + dx
  if (edge === 'left') {
    width = start.width - dx
    x = start.x + dx
  }
  if (edge === 'bottom') height = start.height + dy
  return { x, y, width, height }
}

/** In audio-only mode the pill stays visible; otherwise pill + resize handles
 * appear while the cursor is over the player. */
function updateChromeVisibility(winId: number): void {
  const p = players.get(winId)
  if (!p) return
  const fx = fxFor(winId)
  const show = fx.hidden || fx.hovering
  p.controls.setVisible(show)
  p.resize.setVisible(!fx.hidden && (fx.hovering || resizeTimers.has(winId)))
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

/** Toggle audio-only mode: hide the video pane and shrink the window down to
 * the control pill, keeping playback (and thus audio) alive. */
function setHiddenMode(win: BrowserWindow, value: boolean): void {
  const fx = fxFor(win.id)
  if (fx.hidden === value) return
  fx.hidden = value

  if (value) {
    savedSizes.set(win.id, win.getContentSize() as [number, number])
    // Drop the video-sized minimum so we can collapse to the pill strip.
    win.setMinimumSize(MIN_WIDTH, HIDDEN_HEIGHT)
    win.setResizable(false)
    const [w] = win.getContentSize()
    win.setContentSize(w, HIDDEN_HEIGHT)
  } else {
    win.setResizable(true)
    win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT)
    const saved = savedSizes.get(win.id)
    if (saved) win.setContentSize(saved[0], saved[1])
  }

  layoutPlayer(win.id)
  updateChromeVisibility(win.id)
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

function stopResize(winId: number): void {
  const timer = resizeTimers.get(winId)
  if (timer) {
    clearInterval(timer)
    resizeTimers.delete(winId)
  }
  setPlayerResizing(winId, false)
  updateChromeVisibility(winId)
}

/** Dim the control pill while a resize gesture is in progress. */
function setPlayerResizing(winId: number, resizing: boolean): void {
  const p = players.get(winId)
  if (!p || p.controls.webContents.isDestroyed()) return
  p.controls.webContents.send('player:resizing', resizing)
}

function stopHover(winId: number): void {
  const timer = hoverTimers.get(winId)
  if (timer) {
    clearInterval(timer)
    hoverTimers.delete(winId)
  }
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
  const height = Math.round((width - ASPECT_EXTRA_W) / VIDEO_ASPECT) + ASPECT_EXTRA_H
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
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: process.platform === 'darwin'
  })

  // Resize grips sit under the video so they only receive clicks in the edge
  // gutters — the embed stays fully clickable in the center.
  const resize = new WebContentsView({
    webPreferences: { preload, sandbox: false }
  })
  resize.setBackgroundColor('#00000000')
  win.contentView.addChildView(resize)
  controlsOwner.set(resize.webContents.id, win.id)

  // The remote page lives in its own sandboxed view with no preload, so pasted
  // sites can never reach our IPC surface.
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  win.contentView.addChildView(view)

  // The control pill lives in its own view added last, so it floats above the
  // video (a child view always paints over the ones added before it).
  const controls = new WebContentsView({
    webPreferences: { preload, sandbox: false }
  })
  controls.setBackgroundColor('#00000000')
  win.contentView.addChildView(controls)
  controlsOwner.set(controls.webContents.id, win.id)

  // Pill + handles only appear while hovering (pill always shown in audio-only).
  controls.setVisible(false)
  resize.setVisible(false)

  // Poll the OS cursor so we can react to hover across the whole window,
  // including the separate video view that swallows renderer mouse events.
  hoverTimers.set(
    win.id,
    setInterval(() => {
      if (win.isDestroyed()) return stopHover(win.id)
      const p = screen.getCursorScreenPoint()
      const b = win.getBounds()
      const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
      // Stay revealed mid-drag/resize even if the cursor briefly outruns the window.
      const hovering = inside || dragTimers.has(win.id) || resizeTimers.has(win.id)
      const fx = fxFor(win.id)
      if (hovering !== fx.hovering) {
        fx.hovering = hovering
        updateChromeVisibility(win.id)
        applyOpacity(win)
      }
    }, 80)
  )

  // Register before the first layout so layoutPlayer() can resolve this window.
  players.set(win.id, { win, view, controls, resize, title: target.title })
  // A newly opened player should be visible even if others were concealed.
  if (playersConcealed) {
    playersConcealed = false
    for (const p of players.values()) {
      if (!p.win.isDestroyed() && p.win.id !== win.id) p.win.showInactive()
    }
  }
  layoutPlayer(win.id)

  // Custom aspect lock: follow the dragged edge so side/corner drags don't fight
  // the cursor the way Cocoa's built-in ratio does on frameless transparent windows.
  win.on('will-resize', (event, newBounds, details) => {
    if (fxFor(win.id).hidden) return
    // Only honor left/right/bottom — ignore corner/top native drags.
    const edge = details.edge
    if (edge !== 'left' && edge !== 'right' && edge !== 'bottom') {
      event.preventDefault()
      return
    }
    event.preventDefault()
    setPlayerResizing(win.id, true)
    win.setBounds(constrainResize(win.getBounds(), newBounds, edge))
  })
  win.on('resize', () => scheduleLayout(win.id))
  // Final layout after the gesture so bounds aren't left one frame behind.
  win.on('resized', () => {
    layoutPlayer(win.id)
    if (!resizeTimers.has(win.id)) setPlayerResizing(win.id, false)
  })

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
  loadRoute(resize.webContents, 'resize')

  rebuildTray()
  // Mute + blank the embed before teardown — WebContentsView audio can otherwise
  // keep playing after Cmd/Ctrl+W closes the window.
  win.on('close', () => {
    silenceView(view)
  })
  win.on('closed', () => {
    stopDrag(win.id)
    stopResize(win.id)
    stopHover(win.id)
    playerFx.delete(win.id)
    savedSizes.delete(win.id)
    controlsOwner.delete(controls.webContents.id)
    controlsOwner.delete(resize.webContents.id)
    players.delete(win.id)
    if (players.size === 0) playersConcealed = false
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
  const area = screen.getPrimaryDisplay().workArea
  const width = 440
  const height = 64
  openWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height * 0.22),
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

/** Hide/show every player window without stopping playback. */
function togglePlayersVisible(): void {
  const list = [...players.values()].filter(({ win }) => !win.isDestroyed())
  if (list.length === 0) {
    playersConcealed = false
    updateTrayTitle()
    rebuildTray()
    return
  }
  playersConcealed = !playersConcealed
  for (const { win } of list) {
    if (playersConcealed) win.hide()
    else win.showInactive()
  }
  if (playersConcealed) openWindow?.hide()
  updateTrayTitle()
  rebuildTray()
}

function updateTrayTitle(): void {
  if (!tray) return
  tray.setTitle(playersConcealed ? '▷' : '▶')
  tray.setToolTip(playersConcealed ? 'FloatPlay — players hidden' : 'FloatPlay')
}

/** Kill media in a video view so audio can't outlive the window. */
function silenceView(view: WebContentsView): void {
  const wc = view.webContents
  if (wc.isDestroyed()) return
  wc.setAudioMuted(true)
  void wc.loadURL('about:blank').catch(() => {})
}

/** Build the menu-bar dropdown, listing every open player with its toggles so
 * they're all reachable without hovering the on-video pill. */
function buildTrayMenu(): Menu {
  const hasPlayers = players.size > 0
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: playersConcealed ? 'Show Players' : 'Hide Players',
      accelerator: 'CommandOrControl+Shift+H',
      enabled: hasPlayers,
      click: () => togglePlayersVisible()
    },
    { type: 'separator' },
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
  if (!tray) return
  updateTrayTitle()
  tray.setContextMenu(buildTrayMenu())
}

function createTray(): void {
  if (tray) return
  // A menu-bar title glyph instead of an icon asset keeps the app image-free.
  tray = new Tray(nativeImage.createEmpty())
  updateTrayTitle()
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
  globalShortcut.register('CommandOrControl+Shift+H', () => togglePlayersVisible())

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

  // Custom edge resize from the hover handles (aspect-locked).
  ipcMain.on('player:resize-start', (e, edge: ResizeEdge) => {
    const win = ownerWindow(e.sender)
    if (!win || fxFor(win.id).hidden) return
    if (edge !== 'left' && edge !== 'right' && edge !== 'bottom') return
    const startCursor = screen.getCursorScreenPoint()
    const startBounds = win.getBounds()
    stopResize(win.id)
    setPlayerResizing(win.id, true)
    resizeTimers.set(
      win.id,
      setInterval(() => {
        if (win.isDestroyed()) return stopResize(win.id)
        const p = screen.getCursorScreenPoint()
        const proposed = proposedFromDelta(
          startBounds,
          p.x - startCursor.x,
          p.y - startCursor.y,
          edge
        )
        win.setBounds(constrainResize(startBounds, proposed, edge))
      }, 8)
    )
    updateChromeVisibility(win.id)
  })

  ipcMain.on('player:resize-end', (e) => {
    const win = ownerWindow(e.sender)
    if (win) stopResize(win.id)
  })

  ipcMain.on('open:show', () => showOpenWindow())

  ipcMain.handle('open:submit', (e, url: string) => {
    if (createPlayer(url)) {
      openWindow?.hide()
      return true
    }
    return false
  })

  ipcMain.on('open:cancel', () => openWindow?.hide())
})

// Tray app: stay alive with zero windows.
app.on('window-all-closed', () => {})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
