import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetch as undiciFetch, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
import {
  BraveWebSearchUpstream,
  SearxngWebSearchUpstream,
  createDefaultWebSearchUpstream,
  createWebSearchUpstream,
} from '../src/modules/webSearch/upstreams.js'

// The container web-search upstreams: pure `fetch` + payload mapping into the
// normalised SearXNG `{url,title,content}` shape the proxy returns. The provider key
// lives on the backend here (in the upstream), never in the sandbox. We intercept the
// real `fetch` with undici's MockAgent (instead of replacing `fetch` wholesale), so the
// real URL building + header handling are exercised; `disableNetConnect` fails loudly on
// any un-mocked request.
const BRAVE = 'https://api.search.brave.com'
const SEARX = 'https://searx.example.com'
// A loopback SearXNG — what local mode's self-hosted instance looks like from the host. A high,
// almost-certainly-closed port so the "trusted reaches the socket" assertions fail at CONNECT
// (not at a live server), independent of what else is running.
const LOCAL_SEARX = 'http://127.0.0.1:59237'

let agent: MockAgent
let previousDispatcher: ReturnType<typeof getGlobalDispatcher>

beforeEach(() => {
  previousDispatcher = getGlobalDispatcher()
  agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  // Node's built-in `fetch` binds to its OWN bundled undici (v7 on Node 24), which ignores a
  // dispatcher set on the userland `undici` package (v8) — so the MockAgent above would be
  // silently bypassed and the upstream would hit the REAL network. Route the SUT's `fetch` through
  // the userland undici's fetch, which honours the dispatcher we set.
  vi.stubGlobal('fetch', undiciFetch)
})

afterEach(async () => {
  vi.unstubAllGlobals()
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
    const res = await new SearxngWebSearchUpstream('https://searx.example.com/', 'sx-key').search(
      'q',
    )
    expect(res.results).toEqual([{ url: 'https://d.example', title: 'D', content: 'snippet' }])
    expect(seen[0]!.path).toBe('/search?q=q&format=json')
    expect(seen[0]!.headers.authorization).toBe('Bearer sx-key')
  })

  it('omits the bearer when no key is set', async () => {
    const seen = captureGet(SEARX, '/search', { results: [] })
    await new SearxngWebSearchUpstream('https://searx.example.com').search('q')
    expect(seen[0]!.headers.authorization).toBeUndefined()
  })

  // The trusted flag is exercised by FAILURE MODE, so no live SearXNG is needed: an untrusted
  // instance rejects at the SSRF host check (before any socket); a trusted one skips only that
  // check and proceeds to the real connection (which refuses in-test) — proving the loopback
  // URL a deployment default targets is permitted.
  it('SSRF-rejects a loopback URL when untrusted (the account-supplied path)', async () => {
    await expect(new SearxngWebSearchUpstream(LOCAL_SEARX).search('q')).rejects.toThrow(
      /public host/,
    )
  })

  it('permits a loopback URL when trusted — reaches the socket instead of SSRF-rejecting', async () => {
    const err = await new SearxngWebSearchUpstream(LOCAL_SEARX, undefined, true).search('q').then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    // It got PAST the host guard: the failure is a connection error, not the SSRF rejection.
    expect((err as Error).message).not.toMatch(/public host/)
  })

  it('trusted still SSRF-guards a CROSS-origin redirect to an internal host', async () => {
    // `trusted` trusts only the configured origin — it must NOT disable per-hop redirect
    // revalidation, or a trusted-but-compromised SearXNG could 302 the request (bearer stripped,
    // but the fetch still happens) to `169.254.169.254`. A public trusted base that redirects to
    // a metadata host is rejected at the redirect hop, exactly as the untrusted path would be.
    const PUBLIC_SEARX = 'https://searx.public.example'
    agent
      .get(PUBLIC_SEARX)
      .intercept({ path: (p) => p.startsWith('/search'), method: 'GET' })
      .reply(302, '', { headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
    await expect(
      new SearxngWebSearchUpstream(PUBLIC_SEARX, undefined, true).search('q'),
    ).rejects.toThrow(/public host/)
  })
})

describe('createWebSearchUpstream', () => {
  it('is undefined when nothing is configured', () => {
    expect(createWebSearchUpstream({})).toBeUndefined()
  })

  it('prefers Brave when its key is set', () => {
    const up = createWebSearchUpstream({
      braveApiKey: 'k',
      searxngUrl: 'https://searx.example.com',
    })
    expect(up).toBeInstanceOf(BraveWebSearchUpstream)
  })

  it('falls back to a self-hosted SearXNG', () => {
    const up = createWebSearchUpstream({ searxngUrl: 'https://searx.example.com' })
    expect(up).toBeInstanceOf(SearxngWebSearchUpstream)
  })
})

describe('createDefaultWebSearchUpstream', () => {
  it('is undefined when nothing is configured', () => {
    expect(createDefaultWebSearchUpstream({})).toBeUndefined()
  })

  it('prefers Brave when its key is set', () => {
    const up = createDefaultWebSearchUpstream({ braveApiKey: 'k', searxngUrl: LOCAL_SEARX })
    expect(up).toBeInstanceOf(BraveWebSearchUpstream)
  })

  it('builds a TRUSTED SearXNG (targets a loopback URL without SSRF-rejecting)', async () => {
    const up = createDefaultWebSearchUpstream({ searxngUrl: LOCAL_SEARX })
    expect(up).toBeInstanceOf(SearxngWebSearchUpstream)
    // Trusted ⇒ it reaches the socket (connection error) rather than the SSRF host rejection.
    const err = await up!.search('q').then(
      () => null,
      (e: unknown) => e,
    )
    expect((err as Error | null)?.message ?? '').not.toMatch(/public host/)
  })
})
