import { contextBridge, ipcRenderer } from 'electron'

export type ResizeEdge = 'left' | 'right' | 'bottom'

contextBridge.exposeInMainWorld('api', {
  closePlayer: () => ipcRenderer.send('player:close'),
  setGhost: (ghost: boolean) => ipcRenderer.send('player:ghost', ghost),
  setPassive: (passive: boolean) => ipcRenderer.send('player:passive', passive),
  setHidden: (hidden: boolean) => ipcRenderer.send('player:hidden', hidden),
  reloadPlayer: () => ipcRenderer.send('player:reload'),
  startDrag: () => ipcRenderer.send('player:drag-start'),
  endDrag: () => ipcRenderer.send('player:drag-end'),
  startResize: (edge: ResizeEdge) => ipcRenderer.send('player:resize-start', edge),
  endResize: () => ipcRenderer.send('player:resize-end'),
  openLink: () => ipcRenderer.send('open:show'),
  submitLink: (url: string) => ipcRenderer.invoke('open:submit', url) as Promise<boolean>,
  cancelOpen: () => ipcRenderer.send('open:cancel'),
  onPlayerState: (cb: (state: { ghost: boolean; passive: boolean; hidden: boolean }) => void) => {
    const handler = (
      _e: unknown,
      state: { ghost: boolean; passive: boolean; hidden: boolean }
    ): void => cb(state)
    ipcRenderer.on('player:state', handler)
    return () => ipcRenderer.removeListener('player:state', handler)
  },
  onResizing: (cb: (resizing: boolean) => void) => {
    const handler = (_e: unknown, resizing: boolean): void => cb(resizing)
    ipcRenderer.on('player:resizing', handler)
    return () => ipcRenderer.removeListener('player:resizing', handler)
  }
})
