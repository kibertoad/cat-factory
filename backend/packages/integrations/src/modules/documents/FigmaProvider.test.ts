import { afterEach, describe, expect, it, vi } from 'vitest'
import { FigmaApiError, FigmaProvider } from './FigmaProvider.js'
import { MAX_TREE_DEPTH } from './figma.logic.js'

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
            version: 'file-v7',
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

    const doc = await new FigmaProvider().fetchDocument(TOKEN, 'KEY:1:2', 'ws_1')
    expect(doc.body).toContain('## Card')
    expect(doc.body).toContain('Hi')
    expect(doc.body).toContain('Rendered preview: https://figma-cdn.example/x.png')
    expect(doc.url).toBe('https://www.figma.com/design/KEY?node-id=1-2')
    expect(doc.version).toBe('file-v7') // the file version rides along as the staleness token
    expect(seen.some((u) => u.includes('/nodes?'))).toBe(true)
  })

  it('names the Enterprise plan gate on a variables 403 instead of failing', async () => {
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

    const doc = await new FigmaProvider().fetchDocument(TOKEN, 'KEY:1:2', 'ws_1')
    expect(doc.body).toContain('## Card')
    // The 403 is a PLAN GATE, and this file publishes no styles to fall back to. Saying so
    // is the point: silently omitting the section reads as a design that defines no tokens.
    expect(doc.body).toContain('not available on this plan')
    expect(doc.body).not.toMatch(/^- .+ = /m)
  })

  it('falls back to published styles for tokens when variables are plan-gated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/nodes?')) {
          return jsonResponse({
            name: 'F',
            nodes: {
              '1:2': {
                document: {
                  name: 'Card',
                  type: 'FRAME',
                  children: [
                    {
                      name: 'Heading',
                      type: 'TEXT',
                      characters: 'Hi',
                      styles: { fill: 'S1', text: 'S2' },
                      fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
                      style: { fontFamily: 'Inter', fontSize: 24, fontWeight: 700 },
                    },
                  ],
                },
                styles: {
                  S1: { name: 'brand/primary', styleType: 'FILL' },
                  S2: { name: 'text/heading', styleType: 'TEXT' },
                },
              },
            },
          })
        }
        if (url.includes('/variables/local')) return new Response('forbidden', { status: 403 })
        if (url.includes('/images/')) return jsonResponse({ images: { '1:2': null } })
        throw new Error(`unexpected ${url}`)
      }),
    )

    const doc = await new FigmaProvider().fetchDocument(TOKEN, 'KEY:1:2', 'ws_1')
    expect(doc.body).toContain('Source: published styles.')
    expect(doc.body).toContain('- Colors › brand/primary = #ff0000')
    expect(doc.body).toContain('- Typography › text/heading = Inter 24/700')
    // The styling facts ride the layout line, so the tree carries the values too.
    expect(doc.body).toContain('- Heading _TEXT_ [fill #ff0000; Inter 24/700]')
  })

  it('reads a whole-file link as real frame subtrees, and states the frames it dropped', async () => {
    const frames = Array.from({ length: 14 }, (_, i) => ({
      id: `1:${i}`,
      name: `Frame ${i}`,
      type: 'FRAME',
    }))
    const requested: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('?depth=1')) throw new Error('unexpected probe')
        if (url.includes('/nodes?')) {
          const ids = new URL(url).searchParams.get('ids')!.split(',')
          requested.push(...ids)
          return jsonResponse({
            name: 'Big File',
            nodes: Object.fromEntries(
              ids.map((id) => [
                id,
                {
                  document: {
                    id,
                    name: `Frame ${id.split(':')[1]}`,
                    type: 'FRAME',
                    children: [{ name: 'Body', type: 'TEXT', characters: `text ${id}` }],
                  },
                },
              ]),
            ),
          })
        }
        if (url.includes('/files/KEY?depth=2')) {
          return jsonResponse({
            name: 'Big File',
            version: 'v1',
            document: { name: 'Document', children: [{ name: 'Page 1', children: frames }] },
          })
        }
        throw new Error(`unexpected ${url}`)
      }),
    )

    const doc = await new FigmaProvider().fetchDocument(TOKEN, 'KEY', 'ws_1')
    // The outline read alone returns frames with NO children, so the subtree reads are what
    // makes a whole-file import more than a list of frame names.
    expect(requested).toHaveLength(12)
    expect(doc.body).toContain('- Body _TEXT_')
    expect(doc.body).toContain('- text 1:0')
    expect(doc.body).toContain(
      'This file has 14 top-level frames; the first 12 in document order were imported',
    )
    expect(doc.body).not.toContain('Frame 12')
  })

  it('names the PAGES a multi-page file spreads its frames over when the cap bites', async () => {
    // A frame count alone cannot say whether the cap stopped mid-page or dropped a whole page
    // of the design, and those are different losses.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/nodes?')) {
          const ids = new URL(url).searchParams.get('ids')!.split(',')
          return jsonResponse({
            nodes: Object.fromEntries(
              ids.map((id) => [id, { document: { id, name: `F${id}`, type: 'FRAME' } }]),
            ),
          })
        }
        if (url.includes('/files/KEY?depth=2')) {
          return jsonResponse({
            name: 'Multi',
            document: {
              name: 'Document',
              children: [
                {
                  name: 'Marketing',
                  children: Array.from({ length: 13 }, (_, i) => ({
                    id: `1:${i}`,
                    name: `M${i}`,
                    type: 'FRAME',
                  })),
                },
                { name: 'Admin', children: [{ id: '2:1', name: 'Dashboard', type: 'FRAME' }] },
              ],
            },
          })
        }
        throw new Error(`unexpected ${url}`)
      }),
    )

    const doc = await new FigmaProvider().fetchDocument(TOKEN, 'KEY', 'ws_1')
    expect(doc.body).toContain('across 2 pages (Marketing: 13, Admin: 1)')
  })

  it('carries the CAUSE of a failed subtree chunk into the note, not a bare "failed"', async () => {
    // A 403 (token scope), a 429 (rate limit) and a 502 (oversize response) need three
    // different fixes, and the note is the only place the person who can apply one will look.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/nodes?')) return new Response('slow down', { status: 429 })
        if (url.includes('/variables/local')) return jsonResponse({ meta: {} })
        if (url.includes('/files/KEY?depth=2')) {
          return jsonResponse({
            name: 'File',
            document: {
              name: 'Document',
              children: [
                { name: 'Page 1', children: [{ id: '1:1', name: 'Home', type: 'FRAME' }] },
              ],
            },
          })
        }
        throw new Error(`unexpected ${url}`)
      }),
    )

    const doc = await new FigmaProvider().fetchDocument(TOKEN, 'KEY', 'ws_1')
    expect(doc.body).toContain('1 of 1 frame subtree reads failed (HTTP 429)')
  })

  it('separates "Figma returned no subtree" from a failed read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        // The chunk SUCCEEDS but carries no entry for the requested frame.
        if (url.includes('/nodes?')) return jsonResponse({ nodes: {} })
        if (url.includes('/variables/local')) return jsonResponse({ meta: {} })
        if (url.includes('/files/KEY?depth=2')) {
          return jsonResponse({
            name: 'File',
            document: {
              name: 'Document',
              children: [
                { name: 'Page 1', children: [{ id: '1:1', name: 'Home', type: 'FRAME' }] },
              ],
            },
          })
        }
        throw new Error(`unexpected ${url}`)
      }),
    )

    const doc = await new FigmaProvider().fetchDocument(TOKEN, 'KEY', 'ws_1')
    expect(doc.body).toContain('Figma returned no subtree for 1 of 1 frames')
    expect(doc.body).not.toContain('subtree reads failed')
  })

  it('bounds a node-link subtree read by the same depth the renderer will show', async () => {
    // Unbounded, a deep frame can exceed the response cap and fail the whole import for
    // content the renderer would have capped anyway.
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url)
        if (url.includes('/nodes?')) {
          return jsonResponse({ name: 'F', nodes: { '1:2': { document: { name: 'Card' } } } })
        }
        if (url.includes('/variables/local')) return jsonResponse({ meta: {} })
        if (url.includes('/images/')) return jsonResponse({ images: { '1:2': null } })
        throw new Error(`unexpected ${url}`)
      }),
    )

    await new FigmaProvider().fetchDocument(TOKEN, 'KEY:1:2', 'ws_1')
    const nodesUrl = seen.find((u) => u.includes('/nodes?'))!
    // Derived from MAX_TREE_DEPTH rather than hard-coded, so the two cannot drift: the renderer
    // shows MAX_TREE_DEPTH levels (+2 for Figma's counting) and one MORE is needed for a node at
    // the cap to know it has children at all.
    expect(new URL(nodesUrl).searchParams.get('depth')).toBe(String(MAX_TREE_DEPTH + 3))
  })

  it('leaves a frame at outline depth when its subtree read fails, and says so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/nodes?')) return new Response('boom', { status: 500 })
        if (url.includes('/files/KEY?depth=2')) {
          return jsonResponse({
            name: 'File',
            document: {
              name: 'Document',
              children: [
                {
                  name: 'Page 1',
                  children: [
                    {
                      id: '1:1',
                      name: 'Home',
                      type: 'FRAME',
                      absoluteBoundingBox: { width: 390, height: 844 },
                    },
                  ],
                },
              ],
            },
          })
        }
        throw new Error(`unexpected ${url}`)
      }),
    )

    const doc = await new FigmaProvider().fetchDocument(TOKEN, 'KEY', 'ws_1')
    expect(doc.body).toContain('## Home (390×844)')
    expect(doc.body).toContain('1 of 1 frame subtree reads failed')
  })

  it('maps an off-host redirect to a FigmaApiError (SSRF guard runs per hop)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } }),
      ),
    )
    await expect(
      new FigmaProvider().fetchDocument(TOKEN, 'KEY:1:2', 'ws_1'),
    ).rejects.toBeInstanceOf(FigmaApiError)
  })
})

describe('FigmaProvider.probeVersion', () => {
  it('reads only the file metadata at depth=1 and returns its version token', async () => {
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url)
        if (url.includes('/files/KEY?depth=1')) {
          return jsonResponse({ name: 'My File', version: 'file-v7' })
        }
        throw new Error(`unexpected ${url}`)
      }),
    )
    const version = await new FigmaProvider().probeVersion(TOKEN, 'KEY:1:2', 'ws_1')
    expect(version).toBe('file-v7')
    // A single metadata read — no node tree, variables or preview render.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('/files/KEY?depth=1')
  })

  it('falls back to lastModified when no version field is present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ name: 'F', lastModified: '2026-07-04T00:00:00Z' })),
    )
    expect(await new FigmaProvider().probeVersion(TOKEN, 'KEY', 'ws_1')).toBe(
      '2026-07-04T00:00:00Z',
    )
  })
})
