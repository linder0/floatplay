import React, { useEffect, useRef, useState } from 'react'

/** Spotlight-style pill input: paste a link, Enter to play, Esc to dismiss. */
export function OpenLink(): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const onKeyDown = async (e: React.KeyboardEvent): Promise<void> => {
    if (e.key === 'Enter' && value.trim()) {
      const ok = await window.api.submitLink(value.trim())
      if (ok) setValue('')
      else setInvalid(true)
    } else if (e.key === 'Escape') {
      setValue('')
      window.api.cancelOpen()
    }
  }

  return (
    <div className="open-wrap">
      <input
        ref={inputRef}
        className={`open-pill${invalid ? ' invalid' : ''}`}
        value={value}
        placeholder={invalid ? 'Not a valid link' : 'Paste a video link…'}
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value)
          setInvalid(false)
        }}
        onKeyDown={(e) => void onKeyDown(e)}
      />
    </div>
  )
}
