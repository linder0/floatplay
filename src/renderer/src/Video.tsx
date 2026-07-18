import React from 'react'

/**
 * Minimal player for direct media links (.mp4, .webm, …). Loaded inside the
 * sandboxed view — no preload, no IPC — so it renders just a video element.
 */
export function Video({ src }: { src: string }): React.JSX.Element {
  return (
    <div className="video-page">
      <video src={src} controls autoPlay />
    </div>
  )
}
