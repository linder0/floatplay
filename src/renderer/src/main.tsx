import React from 'react'
import { createRoot } from 'react-dom/client'
import { Player } from './Player'
import { OpenLink } from './OpenLink'
import { Resize } from './Resize'
import { Video } from './Video'
import './styles.css'

const hash = window.location.hash.replace(/^#/, '')
const [route, query] = hash.split('?')
const params = new URLSearchParams(query)

function App(): React.JSX.Element {
  if (route === 'player') return <Player />
  if (route === 'resize') return <Resize />
  if (route === 'video') return <Video src={params.get('src') ?? ''} />
  return <OpenLink />
}

createRoot(document.getElementById('root')!).render(<App />)
