import React, { useEffect, useRef, useState } from 'react'
import { Contrast, Ghost, GripVertical, Link2, RotateCw, Video, VideoOff, X } from 'lucide-react'

const LINK_WIDTH = 320

/**
 * A small control pill floating over the top of the video: a drag grip plus the
 * ghost/passive/open/reload/close buttons. It renders in its own WebContentsView so
 * it can paint above the sandboxed video view owned by the main process.
 */
export function Player(): React.JSX.Element {
  const [ghost, setGhost] = useState(false)
  const [passive, setPassive] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [linking, setLinking] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const [linkInvalid, setLinkInvalid] = useState(false)
  const [resizing, setResizing] = useState(false)
  const linkRef = useRef<HTMLInputElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  const chromeRef = useRef<HTMLDivElement>(null)

  // Reflect toggles flipped from the menu-bar dropdown (main is source of truth).
  useEffect(() => {
    return window.api.onPlayerState((state) => {
      setGhost(state.ghost)
      setPassive(state.passive)
      setHidden(state.hidden)
    })
  }, [])

  useEffect(() => window.api.onResizing(setResizing), [])

  // Keep the compact width measured so the pill doesn't jump after icon changes.
  useEffect(() => {
    if (linking) return
    const pill = pillRef.current
    if (!pill) return
    pill.style.width = `${compactWidth()}px`
  }, [linking, ghost, passive, hidden])

  useEffect(() => {
    if (!linking) return
    const id = window.setTimeout(() => linkRef.current?.focus(), 200)
    return () => window.clearTimeout(id)
  }, [linking])

  // Use offsetWidth — scrollWidth is inflated by absolutely-positioned tooltips.
  const compactWidth = (): number => {
    const chrome = chromeRef.current
    // Match .pill padding (3px each side).
    return chrome ? chrome.offsetWidth + 6 : 160
  }

  const expandWidth = (): number => {
    const wrap = pillRef.current?.parentElement
    const max = wrap ? wrap.clientWidth - 16 : LINK_WIDTH
    return Math.min(LINK_WIDTH, max)
  }

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
    // Left button only, and ignore drags that begin on the action buttons / link input.
    if (e.button !== 0 || (e.target as HTMLElement).closest('.pill-actions, .pill-link')) return
    window.api.startDrag()
    document.body.classList.add('dragging')
    const stop = (): void => {
      window.removeEventListener('mouseup', stop)
      document.body.classList.remove('dragging')
      window.api.endDrag()
    }
    window.addEventListener('mouseup', stop)
  }

  const openLink = (): void => {
    const pill = pillRef.current
    if (!pill) {
      setLinking(true)
      return
    }
    pill.style.width = `${compactWidth()}px`
    setLinking(true)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        pill.style.width = `${expandWidth()}px`
      })
    })
  }

  const collapseLink = (): void => {
    const pill = pillRef.current
    if (pill) pill.style.width = `${pill.getBoundingClientRect().width}px`
    setLinkValue('')
    setLinkInvalid(false)
    setLinking(false)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (pill) pill.style.width = `${compactWidth()}px`
      })
    })
  }

  const submitLink = async (): Promise<void> => {
    const url = linkValue.trim()
    if (!url) return
    const ok = await window.api.submitLink(url)
    if (ok) collapseLink()
    else setLinkInvalid(true)
  }

  return (
    <div className={`pill-wrap${resizing ? ' is-resizing' : ''}`}>
      <div
        ref={pillRef}
        className={`pill${linking ? ' pill-linking' : ''}`}
        onMouseDown={startDrag}
      >
        <div ref={chromeRef} className={`pill-chrome${linking ? ' is-hidden' : ''}`}>
          <span className="pill-grip tip" data-tip="Drag to move" aria-hidden>
            <GripVertical size={13} />
          </span>
          <div className="pill-divider" aria-hidden />
          <div className="pill-actions">
            <button
              className={`pill-btn tip${ghost ? ' active' : ''}`}
              data-tip="Ghost — dim window"
              onClick={toggleGhost}
              tabIndex={linking ? -1 : 0}
            >
              <Contrast size={13} />
            </button>
            <button
              className={`pill-btn tip${passive ? ' active' : ''}`}
              data-tip="Passive — fade on hover"
              onClick={togglePassive}
              tabIndex={linking ? -1 : 0}
            >
              <Ghost size={13} />
            </button>
            <button
              className={`pill-btn tip${hidden ? ' active' : ''}`}
              data-tip={hidden ? 'Show video' : 'Audio only — hide video'}
              onClick={toggleHidden}
              tabIndex={linking ? -1 : 0}
            >
              {hidden ? <VideoOff size={13} /> : <Video size={13} />}
            </button>
            <button
              className="pill-btn tip"
              data-tip="Open link"
              onClick={openLink}
              tabIndex={linking ? -1 : 0}
            >
              <Link2 size={13} />
            </button>
            <button
              className="pill-btn tip"
              data-tip="Reload"
              onClick={() => window.api.reloadPlayer()}
              tabIndex={linking ? -1 : 0}
            >
              <RotateCw size={13} />
            </button>
            <button
              className="pill-btn pill-btn-close tip"
              data-tip="Close"
              onClick={() => window.api.closePlayer()}
              tabIndex={linking ? -1 : 0}
            >
              <X size={13} />
            </button>
          </div>
        </div>
        <input
          ref={linkRef}
          className={`pill-link${linking ? ' is-shown' : ''}${linkInvalid ? ' invalid' : ''}`}
          value={linkValue}
          placeholder={linkInvalid ? 'Not a valid link' : 'Paste a video link…'}
          spellCheck={false}
          tabIndex={linking ? 0 : -1}
          onChange={(e) => {
            setLinkValue(e.target.value)
            setLinkInvalid(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submitLink()
            else if (e.key === 'Escape') collapseLink()
          }}
          onBlur={() => {
            if (!linkValue.trim()) collapseLink()
          }}
        />
      </div>
    </div>
  )
}
