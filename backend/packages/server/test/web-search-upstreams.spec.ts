import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
import {
  BraveWebSearchUpstream,
  SearxngWebSearchUpstream,
  createWebSearchUpstream,
} from '../src/modules/webSearch/upstreams.js'

// The container web-search upstreams: pure `fetch` + payload mapping into the
// normalised SearXNG `{url,title,content}` shape the proxy returns. The provider key
// lives on the backend here (in the upstream), never in the sandbox. We intercept the
// real `fetch` with undici's MockAgent (instead of replacing `fetch` wholesale), so the
// real URL building + header handling are exercised; `disableNetConnect` fails loudly on
// any un-mocked request.
const BRAVE = 'https://api.search.brave.com'
const SEARX = 'https://searx.local'

let agent: MockAgent
let previousDispatcher: ReturnType<typeof getGlobalDispatcher>

beforeEach(() => {
  previousDispatcher = getGlobalDispatcher()
  agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
})

afterEach(async () => {
  setGlobalDispatcher(previousDispatcher)
  await agent.close()
})

interface SeenRequest {
  /** Full request path incl. query string. */
  path: string
  headers: Record<string, string>
}

/** Reply to the next GET under `pathPrefix` on `origin`, capturing the request. */
function captureGet(
  origin: string,
  pathPrefix: string,
  body: unknown,
  status = 200,
): SeenRequest[] {
  const seen: SeenRequest[] = []
  agent
    .get(origin)
    .intercept({ path: (p) => p.startsWith(pathPrefix), method: 'GET' })
    .reply(status, (opts) => {
      seen.push({ path: String(opts.path), headers: opts.headers as Record<string, string> })
      return JSON.stringify(body)
    })
  return seen
}

describe('BraveWebSearchUpstream', () => {
  it('maps Brave web results onto {url,title,content} and sends the key as a header', async () => {
    const seen = captureGet(BRAVE, '/res/v1/web/search', {
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
    expect(seen[0]!.headers['x-subscription-token']).toBe('brave-key')
    expect(seen[0]!.path).toContain('q=how+to+foo')
    expect(seen[0]!.path).toContain('count=3')
  })

  it('drops results without a url and tolerates missing fields', async () => {
    captureGet(BRAVE, '/res/v1/web/search', {
      web: { results: [{ title: 'no url' }, { url: 'https://c.example' }] },
    })
    const res = await new BraveWebSearchUpstream('k').search('q')
    expect(res.results).toEqual([{ url: 'https://c.example', title: '', content: '' }])
  })

  it('throws on a non-2xx upstream', async () => {
    captureGet(BRAVE, '/res/v1/web/search', {}, 429)
    await expect(new BraveWebSearchUpstream('k').search('q')).rejects.toThrow(/Brave search failed/)
  })
})

describe('SearxngWebSearchUpstream', () => {
  it('passes results through and adds the bearer when configured', async () => {
    const seen = captureGet(SEARX, '/search', {
      results: [{ url: 'https://d.example', title: 'D', content: 'snippet' }],
    })
    const res = await new SearxngWebSearchUpstream('https://searx.local/', 'sx-key').search('q')
    expect(res.results).toEqual([{ url: 'https://d.example', title: 'D', content: 'snippet' }])
    expect(seen[0]!.path).toBe('/search?q=q&format=json')
    expect(seen[0]!.headers.authorization).toBe('Bearer sx-key')
  })

  it('omits the bearer when no key is set', async () => {
    const seen = captureGet(SEARX, '/search', { results: [] })
    await new SearxngWebSearchUpstream('https://searx.local').search('q')
    expect(seen[0]!.headers.authorization).toBeUndefined()
  })
})

describe('createWebSearchUpstream', () => {
  it('is undefined when nothing is configured', () => {
    expect(createWebSearchUpstream({})).toBeUndefined()
  })

  it('prefers Brave when its key is set', () => {
    const up = createWebSearchUpstream({
      braveApiKey: 'k',
      searxngUrl: 'https://searx.local',
    })
    expect(up).toBeInstanceOf(BraveWebSearchUpstream)
  })

  it('falls back to a self-hosted SearXNG', () => {
    const up = createWebSearchUpstream({ searxngUrl: 'https://searx.local' })
    expect(up).toBeInstanceOf(SearxngWebSearchUpstream)
  })
})
