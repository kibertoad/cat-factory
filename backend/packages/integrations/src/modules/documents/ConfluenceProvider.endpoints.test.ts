import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfluenceProvider } from './ConfluenceProvider.js'

// Confluence Cloud REST v1 `/wiki/rest/api/content/{id}` was retired on 2025-04-30 (RFC-19), so
// page reads must target v2. Search is the deliberate exception: RFC-19 left it alone and v2
// publishes no search endpoint, so a "migrate everything" refactor would break it.
describe('ConfluenceProvider endpoint versions', () => {
  afterEach(() => vi.unstubAllGlobals())

  const credentials = {
    baseUrl: 'https://site.atlassian.net',
    accountEmail: 'a@b.co',
    apiToken: 'token',
  }

  function stubJson(body: unknown): { urls: string[] } {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        urls.push(String(url))
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    return { urls }
  }

  it('reads a page from v2 with the storage body format', async () => {
    const { urls } = stubJson({
      id: '42',
      title: 'Doc',
      version: { number: 7 },
      body: { storage: { value: '<p>hi</p>' } },
      _links: { base: 'https://site.atlassian.net/wiki', webui: '/spaces/S/pages/42' },
    })

    const doc = await new ConfluenceProvider().fetchDocument(credentials, '42', 'ws')

    expect(urls).toEqual(['https://site.atlassian.net/wiki/api/v2/pages/42?body-format=storage'])
    expect(doc).toMatchObject({ externalId: '42', version: '7' })
  })

  it('probes the version off v2 without asking for a body', async () => {
    const { urls } = stubJson({ id: '42', version: { number: 9 } })

    expect(await new ConfluenceProvider().probeVersion(credentials, '42', 'ws')).toBe('9')
    expect(urls).toEqual(['https://site.atlassian.net/wiki/api/v2/pages/42'])
  })

  it('accepts a numeric id, which older sites have been seen to send', async () => {
    stubJson({ id: 42, title: 'Doc', version: { number: 1 }, body: { storage: { value: '' } } })

    const doc = await new ConfluenceProvider().fetchDocument(credentials, '42', 'ws')

    expect(doc.externalId).toBe('42')
  })

  it('keeps CQL search on v1, which has no v2 equivalent', async () => {
    const { urls } = stubJson({ results: [] })

    await new ConfluenceProvider().search(credentials, 'hello')

    expect(urls[0]).toContain('/wiki/rest/api/content/search?cql=')
  })
})
