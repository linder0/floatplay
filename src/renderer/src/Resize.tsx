import React from 'react'

type ResizeEdge = 'left' | 'right' | 'bottom'

const EDGES: ResizeEdge[] = ['left', 'right', 'bottom']

/**
 * Hover-only resize chrome on the left, right, and bottom edges.
 * Drags are handled in the main process so aspect lock stays consistent.
 */
export function Resize(): React.JSX.Element {
  const start = (edge: ResizeEdge) => (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    window.api.startResize(edge)
    const stop = (): void => {
      window.removeEventListener('mouseup', stop)
      window.api.endResize()
    }
    window.addEventListener('mouseup', stop)
  }

  return (
    <div className="resize-frame">
      {EDGES.map((edge) => (
        <div
          key={edge}
          className={`resize-hit resize-${edge}`}
          onMouseDown={start(edge)}
        >
          <span className="resize-grip" aria-hidden />
        </div>
      ))}
    </div>
  )
}
