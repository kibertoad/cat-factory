import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZeplinApiError, ZeplinProvider } from './ZeplinProvider.js'

// Fetch-shell tests for the Zeplin provider: they exercise the HTTP behaviour the pure
// `zeplin.logic` tests can't — host-pinning + Bearer header, the best-effort drop of an
// unreadable section, and the SSRF redirect guard mapping to a ZeplinApiError. `fetch`
// is stubbed; no network.

const TOKEN = { apiToken: 'zpn_test' }

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

describe('ZeplinProvider.normalizeConnection', () => {
  it('requires and trims a token', () => {
    const p = new ZeplinProvider()
    expect(() => p.normalizeConnection({})).toThrow(/personal access token/)
    expect(p.normalizeConnection({ apiToken: ' zpn_x ' })).toEqual({
      credentials: { apiToken: 'zpn_x' },
      label: 'Zeplin',
    })
  })
})

describe('ZeplinProvider.fetchDocument', () => {
  it('renders a screen + components, pins api.zeplin.dev, sends the Bearer header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(new URL(url).hostname).toBe('api.zeplin.dev')
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer zpn_test')
        if (url.endsWith('/projects/p1')) return jsonResponse({ name: 'Acme' })
        if (url.includes('/screens/s1')) return jsonResponse({ id: 's1', name: 'Home' })
        if (url.includes('/components')) {
          return jsonResponse([{ name: 'Button', section: { name: 'Actions' } }])
        }
        if (url.includes('/design_tokens')) {
          return jsonResponse({ colors: [{ name: 'primary', r: 255, g: 0, b: 0, a: 1 }] })
        }
        throw new Error(`unexpected ${url}`)
      }),
    )

    const doc = await new ZeplinProvider().fetchDocument(TOKEN, 'p1:s1')
    expect(doc.title).toBe('Acme — Home')
    expect(doc.url).toBe('https://app.zeplin.io/project/p1/screen/s1')
    expect(doc.body).toContain('## Home')
    expect(doc.body).toContain('- Actions › Button')
    expect(doc.body).toContain('- Colors › primary = #ff0000')
  })

  it('drops an unreadable SUPPLEMENTARY section (tokens) instead of failing the import', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/projects/p1')) return jsonResponse({ name: 'Acme' })
        if (url.includes('/screens')) return jsonResponse([{ id: 's1', name: 'Home' }])
        if (url.includes('/components')) return jsonResponse([{ name: 'Button' }])
        // design_tokens (a supplementary, plan-gated section) fails
        return new Response('nope', { status: 500 })
      }),
    )
    const doc = await new ZeplinProvider().fetchDocument(TOKEN, 'p1')
    expect(doc.title).toBe('Acme')
    expect(doc.body).toContain('### Components')
    expect(doc.body).not.toContain('### Design tokens')
  })

  it('fails the import when the PRIMARY screens read fails (not a silent empty success)', async () => {
    // Screens are the primary design content: a transient/permission failure must surface
    // as an error, not persist an empty-but-"successful" import (unlike the supplementary
    // components/tokens sections, which are best-effort).
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/projects/p1')) return jsonResponse({ name: 'Acme' })
        if (url.includes('/screens')) return new Response('nope', { status: 500 })
        return jsonResponse([])
      }),
    )
    await expect(new ZeplinProvider().fetchDocument(TOKEN, 'p1')).rejects.toBeInstanceOf(
      ZeplinApiError,
    )
  })

  it('throws when a project renders no design content at all (no empty import)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/projects/p1')) return jsonResponse({ name: 'Acme' })
        // an empty project: screens/components/tokens all read but carry nothing
        return jsonResponse([])
      }),
    )
    await expect(new ZeplinProvider().fetchDocument(TOKEN, 'p1')).rejects.toBeInstanceOf(
      ZeplinApiError,
    )
  })

  it('unwraps a single-screen { screen: {...} } envelope like the list/array reads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/projects/p1')) return jsonResponse({ name: 'Acme' })
        if (url.includes('/screens/s1')) return jsonResponse({ screen: { id: 's1', name: 'Home' } })
        return jsonResponse([])
      }),
    )
    const doc = await new ZeplinProvider().fetchDocument(TOKEN, 'p1:s1')
    expect(doc.title).toBe('Acme — Home')
    expect(doc.body).toContain('## Home')
  })

  it('throws a ZeplinApiError when the project read fails (bad token)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401 })),
    )
    await expect(new ZeplinProvider().fetchDocument(TOKEN, 'p1')).rejects.toBeInstanceOf(
      ZeplinApiError,
    )
  })

  it('maps an off-host redirect to a ZeplinApiError (SSRF guard runs per hop)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } }),
      ),
    )
    await expect(new ZeplinProvider().fetchDocument(TOKEN, 'p1')).rejects.toBeInstanceOf(
      ZeplinApiError,
    )
  })
})
