export interface MediaState {
  t: number
  d: number
  playing: boolean
  vol: number
  muted: boolean
}

export interface FloatPlayApi {
  closePlayer: () => void
  setGhost: (ghost: boolean) => void
  setPassive: (passive: boolean) => void
  setHidden: (hidden: boolean) => void
  reloadPlayer: () => void
  startDrag: () => void
  endDrag: () => void
  submitLink: (url: string) => void
  cancelOpen: () => void
  onInvalidLink: (cb: () => void) => () => void
  onPlayerState: (
    cb: (state: { ghost: boolean; passive: boolean; hidden: boolean }) => void
  ) => () => void
  playPause: () => void
  seek: (seconds: number) => void
  setVolume: (volume: number) => void
  toggleMute: () => void
  onMediaState: (cb: (state: MediaState | null) => void) => () => void
}

declare global {
  interface Window {
    api: FloatPlayApi
  }
}
