import { contextBridge, ipcRenderer } from 'electron'

interface MediaState {
  t: number
  d: number
  playing: boolean
  vol: number
  muted: boolean
}

contextBridge.exposeInMainWorld('api', {
  closePlayer: () => ipcRenderer.send('player:close'),
  setGhost: (ghost: boolean) => ipcRenderer.send('player:ghost', ghost),
  setPassive: (passive: boolean) => ipcRenderer.send('player:passive', passive),
  setHidden: (hidden: boolean) => ipcRenderer.send('player:hidden', hidden),
  reloadPlayer: () => ipcRenderer.send('player:reload'),
  startDrag: () => ipcRenderer.send('player:drag-start'),
  endDrag: () => ipcRenderer.send('player:drag-end'),
  submitLink: (url: string) => ipcRenderer.send('open:submit', url),
  cancelOpen: () => ipcRenderer.send('open:cancel'),
  onInvalidLink: (cb: () => void) => {
    ipcRenderer.on('open:invalid', cb)
    return () => ipcRenderer.removeListener('open:invalid', cb)
  },
  onPlayerState: (cb: (state: { ghost: boolean; passive: boolean; hidden: boolean }) => void) => {
    const handler = (
      _e: unknown,
      state: { ghost: boolean; passive: boolean; hidden: boolean }
    ): void => cb(state)
    ipcRenderer.on('player:state', handler)
    return () => ipcRenderer.removeListener('player:state', handler)
  },
  playPause: () => ipcRenderer.send('media:playpause'),
  seek: (seconds: number) => ipcRenderer.send('media:seek', seconds),
  setVolume: (volume: number) => ipcRenderer.send('media:volume', volume),
  toggleMute: () => ipcRenderer.send('media:mute'),
  onMediaState: (cb: (state: MediaState | null) => void) => {
    const handler = (_e: unknown, state: MediaState | null): void => cb(state)
    ipcRenderer.on('media:state', handler)
    return () => ipcRenderer.removeListener('media:state', handler)
  }
})
