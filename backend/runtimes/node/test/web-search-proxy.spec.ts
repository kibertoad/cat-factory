import { ContainerSessionService } from '@cat-factory/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildNodeContainer } from '../src/container.js'
import { createApp } from '../src/server.js'
import { setupTestDb } from './harness.js'

// The container web-search proxy is a shared `@cat-factory/server` controller, but each facade
// composes the DEPLOYMENT-WIDE default upstream from its OWN `WEB_SEARCH_*` env (the fallback the
// proxy uses when a run's account configured none of its own). This spec proves the Node facade
// builds + surfaces `defaultWebSearchUpstream` from env and the proxy falls back to it — the
// symmetric counterpart to the Worker's `web-search-proxy.spec.ts` "deployment-default" case, so a
// facade that forgot the wiring fails a test instead of silently 200-degrading. CI provides
// Postgres via `DATABASE_URL`; without it the spec skips.

const BASE = 'https://cat-factory.test'
const SECRET = 'proxy-secret'

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()

  function searchRequest(token: string | null, q = 'current zod version') {
    return new Request(`${BASE}/v1/web-search/search?q=${encodeURIComponent(q)}&format=json`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  }

  async function mint(accountId?: string) {
    return new ContainerSessionService({ secret: SECRET }).mint({
      workspaceId: `ws-${crypto.randomUUID()}`,
      executionId: `ex-${crypto.randomUUID()}`,
      agentKind: 'coder',
      provider: 'qwen',
      model: 'qwen3-max',
      ...(accountId ? { accountId } : {}),
    })
  }

  describe('[node] web search proxy deployment-default fallback', () => {
    afterEach(() => vi.restoreAllMocks())

    it('falls back to the deployment-default upstream when the account has no keys', async () => {
      // `WEB_SEARCH_BRAVE_API_KEY` configures a deployment-wide default; an account with no keys of
      // its own must be served by it. (Brave is used so the stubbed `fetch` covers the whole path.)
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AUTH_DEV_OPEN: 'true',
        ENVIRONMENT: 'test',
        ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
        AUTH_SESSION_SECRET: SECRET,
        WEB_SEARCH_BRAVE_API_KEY: 'deploy-brave-key',
      }

      let braveUrl = ''
      let braveKey = ''
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
          braveUrl = String(input)
          braveKey = new Headers(init?.headers).get('x-subscription-token') ?? ''
          return new Response(
            JSON.stringify({
              web: {
                results: [{ url: 'https://zod.dev', title: 'Zod', description: 'TS schemas' }],
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        }),
      )

      const container = buildNodeContainer({ db, env })
      const app = createApp(container, env)
      // The deployment default is surfaced on the container, so the proxy can fall back to it.
      expect(container.defaultWebSearchUpstream).toBeDefined()

      const token = await mint(`acct-${crypto.randomUUID()}`)
      const res = await app.fetch(searchRequest(token))
      expect(res.status).toBe(200)
      // The deployment key is injected server-side onto the Brave call — never in the container.
      expect(braveUrl).toContain('api.search.brave.com')
      expect(braveKey).toBe('deploy-brave-key')
      const body = (await res.json()) as { results: Array<{ url: string; content: string }> }
      expect(body.results).toEqual([
        { url: 'https://zod.dev', title: 'Zod', content: 'TS schemas' },
      ])
    })

    it('degrades to an empty result set when neither account nor deployment default is configured', async () => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AUTH_DEV_OPEN: 'true',
        ENVIRONMENT: 'test',
        ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
        AUTH_SESSION_SECRET: SECRET,
      }
      const container = buildNodeContainer({ db, env })
      expect(container.defaultWebSearchUpstream).toBeUndefined()
      const app = createApp(container, env)
      const res = await app.fetch(searchRequest(await mint(`acct-${crypto.randomUUID()}`)))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ query: '', number_of_results: 0, results: [] })
    })
  })
} else {
  describe.skip('[node] web search proxy deployment-default fallback (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
