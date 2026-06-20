import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BraveWebSearchUpstream,
  SearxngWebSearchUpstream,
  createWebSearchUpstreamFromEnv,
} from '../src/modules/webSearch/upstreams.js'

// The container web-search upstreams: pure `fetch` + payload mapping into the
// normalised SearXNG `{url,title,content}` shape the proxy returns. The provider key
// lives on the backend here (in the upstream), never in the sandbox.

afterEach(() => vi.restoreAllMocks())

/** Stub global fetch with a JSON body + recorded request, returning the captured call. */
function stubFetch(
  body: unknown,
  status = 200,
): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return { calls }
}

describe('BraveWebSearchUpstream', () => {
  it('maps Brave web results onto {url,title,content} and sends the key as a header', async () => {
    const { calls } = stubFetch({
      web: {
        results: [
          { url: 'https://a.example', title: 'A', description: 'about a' },
          { url: 'https://b.example', title: 'B', description: 'about b' },
        ],
      },
    })
    const upstream = new BraveWebSearchUpstream('brave-key')
    const res = await upstream.search('how to foo', { count: 3 })

    expect(res).toEqual({
      query: 'how to foo',
      results: [
        { url: 'https://a.example', title: 'A', content: 'about a' },
        { url: 'https://b.example', title: 'B', content: 'about b' },
      ],
    })
    // The key travels as a Brave header — it is never exposed to the container.
    const headers = new Headers(calls[0]!.init?.headers)
    expect(headers.get('x-subscription-token')).toBe('brave-key')
    expect(calls[0]!.url).toContain('q=how+to+foo')
    expect(calls[0]!.url).toContain('count=3')
  })

  it('drops results without a url and tolerates missing fields', async () => {
    stubFetch({ web: { results: [{ title: 'no url' }, { url: 'https://c.example' }] } })
    const res = await new BraveWebSearchUpstream('k').search('q')
    expect(res.results).toEqual([{ url: 'https://c.example', title: '', content: '' }])
  })

  it('throws on a non-2xx upstream', async () => {
    stubFetch({}, 429)
    await expect(new BraveWebSearchUpstream('k').search('q')).rejects.toThrow(/Brave search failed/)
  })
})

describe('SearxngWebSearchUpstream', () => {
  it('passes results through and adds the bearer when configured', async () => {
    const { calls } = stubFetch({
      results: [{ url: 'https://d.example', title: 'D', content: 'snippet' }],
    })
    const res = await new SearxngWebSearchUpstream('https://searx.local/', 'sx-key').search('q')
    expect(res.results).toEqual([{ url: 'https://d.example', title: 'D', content: 'snippet' }])
    expect(calls[0]!.url).toBe('https://searx.local/search?q=q&format=json')
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer sx-key')
  })

  it('omits the bearer when no key is set', async () => {
    const { calls } = stubFetch({ results: [] })
    await new SearxngWebSearchUpstream('https://searx.local').search('q')
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBeNull()
  })
})

describe('createWebSearchUpstreamFromEnv', () => {
  it('is undefined when nothing is configured', () => {
    expect(createWebSearchUpstreamFromEnv({})).toBeUndefined()
  })

  it('prefers Brave when its key is set', () => {
    const up = createWebSearchUpstreamFromEnv({
      WEB_SEARCH_BRAVE_API_KEY: 'k',
      WEB_SEARCH_SEARXNG_URL: 'https://searx.local',
    })
    expect(up).toBeInstanceOf(BraveWebSearchUpstream)
  })

  it('falls back to a self-hosted SearXNG', () => {
    const up = createWebSearchUpstreamFromEnv({ WEB_SEARCH_SEARXNG_URL: 'https://searx.local' })
    expect(up).toBeInstanceOf(SearxngWebSearchUpstream)
  })
})
