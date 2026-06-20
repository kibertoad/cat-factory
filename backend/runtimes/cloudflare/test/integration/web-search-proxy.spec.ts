import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { createApp } from '../../src/app'
import { ContainerSessionService } from '../../src/infrastructure/containers/ContainerSessionService'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'

// The container web-search proxy is the seam that keeps a search-provider key out of
// the sandbox: a container reaches it with the same model-locked session token it uses
// for the LLM proxy, and the facade runs the search server-side under its own key.
// These specs hit the real Hono app + local D1, stubbing the Brave upstream via fetch.

const SECRET = 'proxy-secret'
const BASE = 'https://cat-factory.test'

function testEnv(overrides: Record<string, string> = {}) {
  return {
    ...env,
    AUTH_SESSION_SECRET: SECRET,
    SPEND_MONTHLY_LIMIT: '100',
    SPEND_CURRENCY: 'EUR',
    // A Brave key on the BACKEND turns the proxy on; it never reaches the container.
    WEB_SEARCH_BRAVE_API_KEY: 'brave-key',
    ...overrides,
  }
}

function searchRequest(token: string | null, q = 'current zod version') {
  return new Request(`${BASE}/v1/web-search/search?q=${encodeURIComponent(q)}&format=json`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

async function mint(overrides: Partial<Parameters<ContainerSessionService['mint']>[0]> = {}) {
  return new ContainerSessionService({ secret: SECRET }).mint({
    workspaceId: `ws-${crypto.randomUUID()}`,
    executionId: `ex-${crypto.randomUUID()}`,
    agentKind: 'coder',
    provider: 'qwen',
    model: 'qwen3-max',
    ...overrides,
  })
}

describe('web search proxy /v1/web-search/search', () => {
  afterEach(() => vi.restoreAllMocks())

  it('503s when no search upstream is configured', async () => {
    const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
    const token = await mint()
    const res = await app.fetch(searchRequest(token), testEnv({ WEB_SEARCH_BRAVE_API_KEY: '' }))
    expect(res.status).toBe(503)
  })

  it('rejects a request without a valid session token', async () => {
    const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
    const res = await app.fetch(searchRequest(null), testEnv())
    expect(res.status).toBe(401)
  })

  it('runs the search server-side under the backend key and returns SearXNG-shaped JSON', async () => {
    let braveUrl = ''
    let braveKey = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
        braveUrl = String(input)
        braveKey = new Headers(init?.headers).get('x-subscription-token') ?? ''
        return new Response(
          JSON.stringify({
            web: { results: [{ url: 'https://zod.dev', title: 'Zod', description: 'TS schemas' }] },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      }),
    )

    const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
    const token = await mint()
    const res = await app.fetch(searchRequest(token), testEnv())
    expect(res.status).toBe(200)

    // The key is injected server-side onto the Brave call — never handed to the container.
    expect(braveUrl).toContain('api.search.brave.com')
    expect(braveKey).toBe('brave-key')

    const body = (await res.json()) as { results: Array<{ url: string; content: string }> }
    expect(body.results).toEqual([{ url: 'https://zod.dev', title: 'Zod', content: 'TS schemas' }])
  })

  it('returns 402 when the spend budget is exhausted', async () => {
    const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
    const token = await mint()
    const res = await app.fetch(searchRequest(token), testEnv({ SPEND_MONTHLY_LIMIT: '0' }))
    expect(res.status).toBe(402)
  })
})
