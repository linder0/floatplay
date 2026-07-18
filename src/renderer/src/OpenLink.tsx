import React, { useEffect, useRef, useState } from 'react'

/** Spotlight-style floating input: paste a link, Enter to play, Esc to dismiss. */
export function OpenLink(): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    inputRef.current?.focus()
    return window.api.onInvalidLink(() => setInvalid(true))
  }, [])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && value.trim()) {
      window.api.submitLink(value.trim())
      setValue('')
    } else if (e.key === 'Escape') {
      setValue('')
      window.api.cancelOpen()
    }
  }

  return (
    <div className={`open-box${invalid ? ' invalid' : ''}`}>
      <span className="open-glyph">▶</span>
      <input
        ref={inputRef}
        value={value}
        placeholder="Paste a video link…"
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value)
          setInvalid(false)
        }}
        onKeyDown={onKeyDown}
      />
      {invalid && <span className="open-error">not a valid link</span>}
    </div>
  )
}
