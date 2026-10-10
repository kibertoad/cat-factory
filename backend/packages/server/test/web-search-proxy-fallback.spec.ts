import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { ContainerSessionService } from '../src/containers/ContainerSessionService.js'
import { webSearchProxyController } from '../src/modules/webSearch/WebSearchProxyController.js'
import type { AppEnv } from '../src/http/env.js'
import type { WebSearchResponse, WebSearchUpstream } from '../src/runtime/gateways.js'

// The search proxy falls back to a DEPLOYMENT-configured trusted default upstream when the
// run's account has no web-search config of its own — this is how local mode's self-hosted
// SearXNG serves every account with zero per-account key entry. The account path still wins
// when present. We mount the real controller with a minimal fake container and inject a FAKE
// upstream as the default (a plain `WebSearchUpstream`), so the resolution logic is exercised
// with no network / fetch mocking.

const SECRET = 'proxy-secret'
const BASE = 'https://cat-factory.test'
// A public host so the account-supplied path (constructed internally, SSRF-guarded) isn't
// rejected before we can observe precedence.
const ACCOUNT_SEARX = 'https://searx.account.example'

/** A no-network upstream that records its calls, so we can assert which one the proxy used. */
function fakeUpstream(
  results: WebSearchResponse['results'],
): WebSearchUpstream & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    provider: 'searxng',
    search: async (query: string) => (calls.push(query), { query, results }),
  }
}

interface FakeContainer {
  accountSettings?: { service: { resolve: (id: string) => Promise<{ webSearch?: unknown }> } }
  defaultWebSearchUpstream?: WebSearchUpstream
  overBudget?: boolean
}

function appFor(container: FakeContainer) {
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('container', {
      config: { auth: { sessionSecret: SECRET } },
      spendService: { isOverBudget: async () => Boolean(container.overBudget) },
      accountSettings: container.accountSettings,
      defaultWebSearchUpstream: container.defaultWebSearchUpstream,
    } as unknown as AppEnv['Variables']['container'])
    return next()
  })
  app.route('/', webSearchProxyController())
  return app
}

async function mint(accountId?: string) {
  return new ContainerSessionService({ secret: SECRET }).mint({
    workspaceId: `ws-${Math.random().toString(36).slice(2)}`,
    executionId: `ex-${Math.random().toString(36).slice(2)}`,
    agentKind: 'coder',
    provider: 'qwen',
    model: 'qwen3-max',
    ...(accountId ? { accountId } : {}),
  })
}

function search(app: ReturnType<typeof appFor>, token: string, q = 'zod version') {
  return app.fetch(
    new Request(`${BASE}/v1/web-search/search?q=${encodeURIComponent(q)}&format=json`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  )
}

describe('web-search proxy default-upstream fallback', () => {
  it('falls back to the deployment default when the account has no upstream', async () => {
    const dflt = fakeUpstream([{ url: 'https://zod.dev', title: 'Zod', content: 'TS schemas' }])
    const app = appFor({
      accountSettings: { service: { resolve: async () => ({}) } }, // account has none
      defaultWebSearchUpstream: dflt,
    })
    const res = await search(app, await mint('acct-1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: unknown[]; number_of_results: number }
    expect(body.results).toEqual([{ url: 'https://zod.dev', title: 'Zod', content: 'TS schemas' }])
    expect(body.number_of_results).toBe(1)
    expect(dflt.calls).toEqual(['zod version'])
  })

  it('falls back to the default even with no accountSettings wired at all', async () => {
    const dflt = fakeUpstream([{ url: 'https://d.example', title: 'D', content: 'x' }])
    const res = await search(appFor({ defaultWebSearchUpstream: dflt }), await mint('acct-1'))
    expect(res.status).toBe(200)
    expect(dflt.calls).toHaveLength(1)
  })

  it('prefers the account upstream over the default when the account has keys', async () => {
    // The account resolves its own upstream (built internally from these keys), so the default
    // must NOT be consulted — asserting precedence without needing the account fetch to succeed.
    const dflt = fakeUpstream([{ url: 'https://from.default', title: 'x', content: 'x' }])
    const app = appFor({
      accountSettings: {
        service: { resolve: async () => ({ webSearch: { searxngUrl: ACCOUNT_SEARX } }) },
      },
      defaultWebSearchUpstream: dflt,
    })
    await search(app, await mint('acct-1'))
    expect(dflt.calls).toEqual([]) // account path won; the default was never used
  })

  it('still degrades to an empty result set when neither account nor default is configured', async () => {
    const app = appFor({ accountSettings: { service: { resolve: async () => ({}) } } })
    const res = await search(app, await mint('acct-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ query: '', number_of_results: 0, results: [] })
  })

  it('enforces the spend budget on the default-upstream path too', async () => {
    const dflt = fakeUpstream([{ url: 'https://x', title: 'x', content: 'x' }])
    const app = appFor({ overBudget: true, defaultWebSearchUpstream: dflt })
    const res = await search(app, await mint('acct-1'))
    expect(res.status).toBe(402)
    expect(dflt.calls).toEqual([]) // budget is gated before the search runs
  })

  it('rejects a request without a valid session token', async () => {
    const dflt = fakeUpstream([])
    const app = appFor({ defaultWebSearchUpstream: dflt })
    const res = await app.fetch(new Request(`${BASE}/v1/web-search/search?q=x&format=json`))
    expect(res.status).toBe(401)
  })
})
