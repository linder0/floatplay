import React, { useEffect, useState } from 'react'
import { Pause, Play, Volume2, VolumeX } from 'lucide-react'

interface MediaState {
  t: number
  d: number
  playing: boolean
  vol: number
  muted: boolean
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/**
 * The bottom media transport bar (its own WebContentsView above the video):
 * play/pause, a live scrubber with timestamps, and a volume control. Commands
 * are forwarded to the video's player through the main process.
 */
export function Transport(): React.JSX.Element {
  const [state, setState] = useState<MediaState | null>(null)
  // Local scrub position while dragging, so polled updates don't fight the drag.
  const [scrub, setScrub] = useState<number | null>(null)

  useEffect(() => window.api.onMediaState((s) => setState(s)), [])

  const ready = !!state && state.d > 0
  const duration = state?.d ?? 0
  const current = scrub ?? state?.t ?? 0
  const playing = state?.playing ?? false
  const volume = state?.muted ? 0 : (state?.vol ?? 1)

  return (
    <div className={`bar${ready ? '' : ' bar-loading'}`}>
      <button
        className="bar-btn"
        title={playing ? 'Pause' : 'Play'}
        onClick={() => window.api.playPause()}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>

      <span className="bar-time">{formatTime(current)}</span>

      <input
        className="bar-seek"
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(current, duration || 0)}
        disabled={!ready}
        onChange={(e) => setScrub(Number(e.target.value))}
        onMouseUp={(e) => {
          const v = Number((e.target as HTMLInputElement).value)
          window.api.seek(v)
          setScrub(null)
        }}
        style={{ ['--pct' as string]: `${duration > 0 ? (current / duration) * 100 : 0}%` }}
      />

      <span className="bar-time bar-time-total">{formatTime(duration)}</span>

      <button
        className="bar-btn"
        title={state?.muted ? 'Unmute' : 'Mute'}
        onClick={() => window.api.toggleMute()}
      >
        {volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </button>

      <input
        className="bar-vol"
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        onChange={(e) => window.api.setVolume(Number(e.target.value))}
        style={{ ['--pct' as string]: `${volume * 100}%` }}
      />
    </div>
  )
}
