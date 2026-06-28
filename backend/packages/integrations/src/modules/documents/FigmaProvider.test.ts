import { afterEach, describe, expect, it, vi } from 'vitest'
import { FigmaApiError, FigmaProvider } from './FigmaProvider.js'

// Fetch-shell tests for the Figma provider: they exercise the HTTP behaviour the pure
// `figma.logic` tests can't — host-pinning + Bearer/X-Figma-Token headers, the Enterprise
// drop-on-403 for variables, the best-effort preview, and the SSRF redirect guard mapping
// to a FigmaApiError. `fetch` is stubbed; no network.

const TOKEN = { apiToken: 'figd_test' }

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FigmaProvider.normalizeConnection', () => {
  it('requires and trims a token', () => {
    const p = new FigmaProvider()
    expect(() => p.normalizeConnection({})).toThrow(/personal access token/)
    expect(p.normalizeConnection({ apiToken: ' figd_x ' })).toEqual({
      credentials: { apiToken: 'figd_x' },
      label: 'Figma',
    })
  })
})

describe('FigmaProvider.fetchDocument', () => {
  it('renders a node subtree + preview, pins api.figma.com, sends the token header', async () => {
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push(url)
        expect(new URL(url).hostname).toBe('api.figma.com')
        expect((init.headers as Record<string, string>)['x-figma-token']).toBe('figd_test')
        if (url.includes('/nodes?')) {
          return jsonResponse({
            name: 'My File',
            nodes: {
              '1:2': {
                document: {
                  id: '1:2',
                  name: 'Card',
                  type: 'FRAME',
                  children: [{ name: 'Title', type: 'TEXT', characters: 'Hi' }],
                },
                components: {},
              },
            },
          })
        }
        if (url.includes('/variables/local')) return jsonResponse({ meta: { variables: {} } })
        if (url.includes('/images/')) {
          return jsonResponse({ images: { '1:2': 'https://figma-cdn.example/x.png' } })
        }
        throw new Error(`unexpected ${url}`)
      }),
    )

    const doc = await new FigmaProvider().fetchDocument(TOKEN, 'KEY:1:2')
    expect(doc.body).toContain('## Card')
    expect(doc.body).toContain('Hi')
    expect(doc.body).toContain('Rendered preview: https://figma-cdn.example/x.png')
    expect(doc.url).toBe('https://www.figma.com/design/KEY?node-id=1-2')
    expect(seen.some((u) => u.includes('/nodes?'))).toBe(true)
  })

  it('drops the design-tokens section on a 403 (non-Enterprise) instead of failing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/nodes?')) {
          return jsonResponse({
            name: 'F',
            nodes: { '1:2': { document: { name: 'Card', type: 'FRAME' } } },
          })
        }
        if (url.includes('/variables/local')) return new Response('forbidden', { status: 403 })
        if (url.includes('/images/')) return jsonResponse({ images: { '1:2': null } })
        throw new Error(`unexpected ${url}`)
      }),
    )

    const doc = await new FigmaProvider().fetchDocument(TOKEN, 'KEY:1:2')
    expect(doc.body).toContain('## Card')
    expect(doc.body).not.toContain('Design tokens')
  })

  it('maps an off-host redirect to a FigmaApiError (SSRF guard runs per hop)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } }),
      ),
    )
    await expect(new FigmaProvider().fetchDocument(TOKEN, 'KEY:1:2')).rejects.toBeInstanceOf(
      FigmaApiError,
    )
  })
})
