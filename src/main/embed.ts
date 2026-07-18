/**
 * Convert a pasted link into something watchable in a small window. Full sites
 * (youtube.com with sidebar, comments, etc.) are miserable at 480px — every
 * mini player converts links to the provider's bare embed player instead.
 */
export type EmbedTarget =
  /** A remote page to load directly in the sandboxed view. */
  | { kind: 'remote'; url: string; title: string }
  /** A direct media file, played by our own minimal <video> page. */
  | { kind: 'video'; src: string; title: string }

const VIDEO_EXTENSIONS = /\.(mp4|m4v|webm|mov|mp3|wav|ogg|m3u8)$/i

/** YouTube accepts t= as plain seconds or as 1h2m3s. */
function parseStart(t: string | null): number {
  if (!t) return 0
  if (/^\d+$/.test(t)) return Number(t)
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t)
  if (!m) return 0
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

function youtubeEmbed(id: string, source: URL): EmbedTarget {
  const params = new URLSearchParams({ autoplay: '1' })
  const start = parseStart(source.searchParams.get('t'))
  if (start > 0) params.set('start', String(start))
  const list = source.searchParams.get('list')
  if (list) params.set('list', list)
  return {
    kind: 'remote',
    url: `https://www.youtube.com/embed/${id}?${params}`,
    title: 'YouTube'
  }
}

export function toEmbedTarget(raw: string): EmbedTarget | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.replace(/^www\./, '').toLowerCase()

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const shorts = /^\/(?:shorts|live)\/([\w-]+)/.exec(url.pathname)
    const id = url.searchParams.get('v') ?? shorts?.[1]
    if (id) return youtubeEmbed(id, url)
    if (url.pathname.startsWith('/embed/')) {
      return { kind: 'remote', url: url.toString(), title: 'YouTube' }
    }
  }

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0]
    if (id) return youtubeEmbed(id, url)
  }

  if (host === 'vimeo.com') {
    const m = /^\/(\d+)/.exec(url.pathname)
    if (m) {
      return { kind: 'remote', url: `https://player.vimeo.com/video/${m[1]}?autoplay=1`, title: 'Vimeo' }
    }
  }

  if (host === 'twitch.tv') {
    // Twitch requires a parent= param naming the embedding site; when the
    // player is loaded top-level (not in an iframe) any value passes.
    const video = /^\/videos\/(\d+)/.exec(url.pathname)
    if (video) {
      return {
        kind: 'remote',
        url: `https://player.twitch.tv/?video=v${video[1]}&parent=localhost&autoplay=true`,
        title: 'Twitch'
      }
    }
    const channel = url.pathname.split('/')[1]
    if (channel) {
      return {
        kind: 'remote',
        url: `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=localhost&autoplay=true`,
        title: 'Twitch'
      }
    }
  }

  if (host === 'loom.com') {
    const m = /^\/share\/([0-9a-f]+)/.exec(url.pathname)
    if (m) {
      return { kind: 'remote', url: `https://www.loom.com/embed/${m[1]}?autoplay=1`, title: 'Loom' }
    }
  }

  if (VIDEO_EXTENSIONS.test(url.pathname)) {
    return { kind: 'video', src: url.toString(), title: url.pathname.split('/').pop() ?? 'Video' }
  }

  // Anything else: load it as-is and let it be a tiny floating browser.
  return { kind: 'remote', url: url.toString(), title: host }
}
