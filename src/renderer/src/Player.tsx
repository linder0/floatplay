import React, { useEffect, useState } from 'react'
import { Contrast, Ghost, GripVertical, RotateCw, Video, VideoOff, X } from 'lucide-react'

/**
 * A small control pill floating over the top of the video: a drag grip plus the
 * ghost/passive/reload/close buttons. It renders in its own WebContentsView so
 * it can paint above the sandboxed video view owned by the main process.
 */
export function Player(): React.JSX.Element {
  const [ghost, setGhost] = useState(false)
  const [passive, setPassive] = useState(false)
  const [hidden, setHidden] = useState(false)

  // Reflect toggles flipped from the menu-bar dropdown (main is source of truth).
  useEffect(() => {
    return window.api.onPlayerState((state) => {
      setGhost(state.ghost)
      setPassive(state.passive)
      setHidden(state.hidden)
    })
  }, [])

  const toggleGhost = (): void => {
    const next = !ghost
    setGhost(next)
    window.api.setGhost(next)
  }

  const togglePassive = (): void => {
    const next = !passive
    setPassive(next)
    window.api.setPassive(next)
  }

  const toggleHidden = (): void => {
    const next = !hidden
    setHidden(next)
    window.api.setHidden(next)
  }

  const startDrag = (e: React.MouseEvent): void => {
    // Left button only, and ignore drags that begin on the action buttons.
    if (e.button !== 0 || (e.target as HTMLElement).closest('.pill-actions')) return
    window.api.startDrag()
    document.body.classList.add('dragging')
    const stop = (): void => {
      window.removeEventListener('mouseup', stop)
      document.body.classList.remove('dragging')
      window.api.endDrag()
    }
    window.addEventListener('mouseup', stop)
  }

  return (
    <div className="pill-wrap">
      <div className="pill" onMouseDown={startDrag}>
        <span className="pill-grip tip" data-tip="Drag to move" aria-hidden>
          <GripVertical size={16} />
        </span>
        <div className="pill-divider" aria-hidden />
        <div className="pill-actions">
          <button
            className={`pill-btn tip${ghost ? ' active' : ''}`}
            data-tip="Ghost — dim window"
            onClick={toggleGhost}
          >
            <Contrast size={16} />
          </button>
          <button
            className={`pill-btn tip${passive ? ' active' : ''}`}
            data-tip="Passive — fade on hover"
            onClick={togglePassive}
          >
            <Ghost size={16} />
          </button>
          <button
            className={`pill-btn tip${hidden ? ' active' : ''}`}
            data-tip={hidden ? 'Show video' : 'Audio only — hide video'}
            onClick={toggleHidden}
          >
            {hidden ? <VideoOff size={16} /> : <Video size={16} />}
          </button>
          <button
            className="pill-btn tip"
            data-tip="Reload"
            onClick={() => window.api.reloadPlayer()}
          >
            <RotateCw size={16} />
          </button>
          <button
            className="pill-btn pill-btn-close tip"
            data-tip="Close"
            onClick={() => window.api.closePlayer()}
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
