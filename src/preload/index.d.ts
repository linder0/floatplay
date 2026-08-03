export type ResizeEdge = 'left' | 'right' | 'bottom'

export interface FloatPlayApi {
  closePlayer: () => void
  setGhost: (ghost: boolean) => void
  setPassive: (passive: boolean) => void
  setHidden: (hidden: boolean) => void
  reloadPlayer: () => void
  startDrag: () => void
  endDrag: () => void
  startResize: (edge: ResizeEdge) => void
  endResize: () => void
  openLink: () => void
  submitLink: (url: string) => Promise<boolean>
  cancelOpen: () => void
  onPlayerState: (
    cb: (state: { ghost: boolean; passive: boolean; hidden: boolean }) => void
  ) => () => void
  onResizing: (cb: (resizing: boolean) => void) => () => void
}

declare global {
  interface Window {
    api: FloatPlayApi
  }
}
