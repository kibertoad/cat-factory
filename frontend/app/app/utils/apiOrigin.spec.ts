import { describe, expect, it } from 'vitest'
import { apiOriginFor, wsOriginFor } from '~/utils/apiOrigin'

// The split-origin deployment (an absolute apiBase) and the same-origin one (empty apiBase, one
// reverse proxy in front of both halves — the compose preview stack) must both produce a usable
// socket origin. An empty apiBase used to yield a RELATIVE WebSocket URL, which is exactly the
// case a preview stack hits: its host port is assigned at `up` time, so no absolute origin can be
// baked into the build.

describe('apiOriginFor', () => {
  it('keeps an absolute apiBase (split origins)', () => {
    expect(apiOriginFor('https://api.example.com', 'https://app.example.com')).toBe(
      'https://api.example.com',
    )
  })

  it('falls back to the page origin when apiBase is empty or blank (same origin)', () => {
    expect(apiOriginFor('', 'http://localhost:49153')).toBe('http://localhost:49153')
    expect(apiOriginFor('   ', 'http://localhost:49153')).toBe('http://localhost:49153')
  })

  it('is empty when neither is known (SSR — no socket is opened there)', () => {
    expect(apiOriginFor('', '')).toBe('')
  })
})

describe('wsOriginFor', () => {
  it('maps http→ws and https→wss', () => {
    expect(wsOriginFor('http://localhost:8787', '')).toBe('ws://localhost:8787')
    expect(wsOriginFor('https://api.example.com', '')).toBe('wss://api.example.com')
  })

  it('derives the socket origin from the page for a same-origin deployment', () => {
    expect(wsOriginFor('', 'https://preview.example.com')).toBe('wss://preview.example.com')
    expect(wsOriginFor('', 'http://localhost:49153')).toBe('ws://localhost:49153')
  })
})
