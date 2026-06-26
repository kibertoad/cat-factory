import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import { AccountSettingsService, ACCOUNT_SETTINGS_CIPHER_INFO } from '@cat-factory/integrations'
import { createApp } from '../../src/app'
import { ContainerSessionService } from '../../src/infrastructure/containers/ContainerSessionService'
import { D1AccountSettingsRepository } from '../../src/infrastructure/repositories/D1AccountSettingsRepository'
import { D1WorkspaceSettingsRepository } from '../../src/infrastructure/repositories/D1WorkspaceSettingsRepository'
import { WebCryptoSecretCipher } from '../../src/infrastructure/environments/WebCryptoSecretCipher'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'

// The container web-search proxy keeps a search-provider key out of the sandbox: a
// container reaches it with the same model-locked session token it uses for the LLM proxy,
// and the facade runs the search server-side under the key configured in the run's ACCOUNT
// settings (web-search keys live per-account now, not in env). These specs hit the real
// Hono app + local D1, stubbing the Brave upstream via fetch.

const SECRET = 'proxy-secret'
const BASE = 'https://cat-factory.test'

function testEnv(overrides: Record<string, string> = {}) {
  return { ...env, AUTH_SESSION_SECRET: SECRET, ...overrides }
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

/**
 * Seal a Brave web-search key into an ACCOUNT's settings (web-search keys are per-account
 * now). Uses the shared `ENCRYPTION_KEY` + the same HKDF tag the app's resolver uses, so
 * the proxy decrypts it back out for the run.
 */
async function seedAccountBraveKey(accountId: string, braveApiKey = 'brave-key') {
  await new AccountSettingsService({
    accountSettingsRepository: new D1AccountSettingsRepository({ db: env.DB }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: env.ENCRYPTION_KEY!,
      info: ACCOUNT_SETTINGS_CIPHER_INFO,
    }),
    clock: { now: () => Date.now() },
  }).write(accountId, { secrets: { webSearch: { braveApiKey } } })
}

/** Force a workspace over budget by pinning its monthly spend limit to 0. */
async function seedZeroBudget(workspaceId: string) {
  await new D1WorkspaceSettingsRepository({ db: env.DB }).upsert(workspaceId, {
    ...DEFAULT_WORKSPACE_SETTINGS,
    spendMonthlyLimit: 0,
  })
}

describe('web search proxy /v1/web-search/search', () => {
  afterEach(() => vi.restoreAllMocks())

  it('degrades to an empty result set when the run has no configured upstream', async () => {
    const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
    // A run with no account (or an account with no keys) gets an empty result set rather
    // than a hard error — the executor only advertises web_search when keys exist.
    const token = await mint()
    const res = await app.fetch(searchRequest(token), testEnv())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ query: '', number_of_results: 0, results: [] })
  })

  it('rejects a request without a valid session token', async () => {
    const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
    const res = await app.fetch(searchRequest(null), testEnv())
    expect(res.status).toBe(401)
  })

  it('runs the search server-side under the account key and returns SearXNG-shaped JSON', async () => {
    const accountId = `acct-${crypto.randomUUID()}`
    await seedAccountBraveKey(accountId)

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
    const token = await mint({ accountId })
    const res = await app.fetch(searchRequest(token), testEnv())
    expect(res.status).toBe(200)

    // The key is injected server-side onto the Brave call — never handed to the container.
    expect(braveUrl).toContain('api.search.brave.com')
    expect(braveKey).toBe('brave-key')

    const body = (await res.json()) as { results: Array<{ url: string; content: string }> }
    expect(body.results).toEqual([{ url: 'https://zod.dev', title: 'Zod', content: 'TS schemas' }])
  })

  it('returns 402 when the spend budget is exhausted', async () => {
    const accountId = `acct-${crypto.randomUUID()}`
    const workspaceId = `ws-${crypto.randomUUID()}`
    await seedAccountBraveKey(accountId)
    await seedZeroBudget(workspaceId)
    const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
    const token = await mint({ accountId, workspaceId })
    const res = await app.fetch(searchRequest(token), testEnv())
    expect(res.status).toBe(402)
  })
})
