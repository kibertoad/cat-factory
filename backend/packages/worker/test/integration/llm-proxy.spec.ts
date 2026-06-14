import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { createApp } from '../../src/app'
import { ContainerSessionService } from '../../src/infrastructure/containers/ContainerSessionService'

// The LLM proxy is the seam that keeps provider keys out of containers and meters
// their spend. These specs hit the real Hono app + local D1, stubbing the
// upstream provider via global fetch.

const SECRET = 'proxy-secret'
const BASE = 'https://cat-factory.test'

function testEnv(overrides: Record<string, string> = {}) {
  return {
    ...env,
    AUTH_SESSION_SECRET: SECRET,
    QWEN_API_KEY: 'sk-upstream',
    SPEND_MONTHLY_LIMIT: '100',
    SPEND_CURRENCY: 'EUR',
    ...overrides,
  }
}

function chatRequest(token: string | null, model = 'whatever') {
  return new Request(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
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

describe('llm proxy /v1/chat/completions', () => {
  afterEach(() => vi.restoreAllMocks())

  it('rejects a request without a valid session token', async () => {
    const app = createApp()
    const res = await app.fetch(chatRequest(null), testEnv())
    expect(res.status).toBe(401)
  })

  it('returns 402 when the spend budget is exhausted', async () => {
    const app = createApp()
    const token = await mint()
    const res = await app.fetch(chatRequest(token), testEnv({ SPEND_MONTHLY_LIMIT: '0' }))
    expect(res.status).toBe(402)
  })

  it('forwards with the locked model + injected key, and meters usage', async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`
    const executionId = `ex-${crypto.randomUUID()}`
    const token = await mint({ workspaceId, executionId })

    let upstreamUrl = ''
    let upstreamAuth = ''
    let upstreamModel = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
        upstreamUrl = url
        upstreamAuth = init.headers.authorization ?? ''
        upstreamModel = (JSON.parse(init.body) as { model: string }).model
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      }),
    )

    const app = createApp()
    // Client asks for a different (cheap) model; the proxy must override it.
    const res = await app.fetch(chatRequest(token, 'cheap-model'), testEnv())
    expect(res.status).toBe(200)

    // Forwarded to DashScope, with the real key and the session-locked model.
    expect(upstreamUrl).toContain('dashscope')
    expect(upstreamAuth).toBe('Bearer sk-upstream')
    expect(upstreamModel).toBe('qwen3-max')

    // Usage was metered into the ledger exactly once, against the run.
    const rows = await env.DB.prepare(
      'SELECT provider, model, input_tokens, output_tokens FROM token_usage WHERE execution_id = ?',
    )
      .bind(executionId)
      .all()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0]).toMatchObject({
      provider: 'qwen',
      model: 'qwen3-max',
      input_tokens: 10,
      output_tokens: 5,
    })
  })

  it('returns 502 when the locked provider has no configured key', async () => {
    const app = createApp()
    const token = await mint({ provider: 'qwen', model: 'qwen3-max' })
    // QWEN_API_KEY removed → upstream cannot be resolved.
    const res = await app.fetch(chatRequest(token), testEnv({ QWEN_API_KEY: '' }))
    expect(res.status).toBe(502)
  })

  it('serves workers-ai via the AI binding, not an upstream fetch or provider key', async () => {
    // workers-ai has no external upstream: it must run through the Worker's AI
    // binding (no key, no fetch). Drop the binding to assert the routing without
    // hitting the real Workers AI network in tests.
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const app = createApp()
    const token = await mint({ provider: 'workers-ai', model: '@cf/meta/llama-3.1-8b-instruct' })
    // No QWEN_API_KEY needed; AI binding removed → guarded 502 (not 502 "no key").
    const noBinding = { ...testEnv({ QWEN_API_KEY: '' }), AI: undefined }
    const res = await app.fetch(chatRequest(token), noBinding as Parameters<typeof app.fetch>[1])

    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
      /Workers AI binding/,
    )
    // The workers-ai path never reaches the OpenAI-compatible fetch upstream.
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
