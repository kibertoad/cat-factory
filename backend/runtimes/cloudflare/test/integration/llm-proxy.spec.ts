import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { RecordingEventPublisher } from '@cat-factory/conformance'
import { createApp } from '../../src/app'
import { buildContainer } from '../../src/infrastructure/container'
import { ContainerSessionService } from '../../src/infrastructure/containers/ContainerSessionService'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'

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

/**
 * Seed a workspace-scoped qwen key into the DB pool. Provider keys are DB-backed now
 * (no longer env), so the proxy leases this for the upstream call. Shares `env.DB` +
 * `ENCRYPTION_KEY` with the app the test drives, so the cipher round-trips.
 */
async function seedQwenKey(workspaceId: string, key = 'sk-upstream') {
  // A fake executor so buildContainer doesn't require the container-runner prerequisites
  // (we only need the apiKeys service, which builds from ENCRYPTION_KEY + the shared DB).
  const c = buildContainer(env, { agentExecutor: new FakeAgentExecutor() })
  await c.apiKeys!.addKey('workspace', workspaceId, { provider: 'qwen', label: 'upstream', key })
}

describe('llm proxy /v1/chat/completions', () => {
  afterEach(() => vi.restoreAllMocks())

  it('rejects a request without a valid session token', async () => {
    const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
    const res = await app.fetch(chatRequest(null), testEnv())
    expect(res.status).toBe(401)
  })

  it('returns 402 when the spend budget is exhausted', async () => {
    const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
    const token = await mint()
    const res = await app.fetch(chatRequest(token), testEnv({ SPEND_MONTHLY_LIMIT: '0' }))
    expect(res.status).toBe(402)
  })

  it('forwards with the locked model + injected key, and meters usage', async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`
    const executionId = `ex-${crypto.randomUUID()}`
    const token = await mint({ workspaceId, executionId })
    await seedQwenKey(workspaceId)

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

    const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
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

  it('pushes a compact llmCall activity event per proxied call (no prompt/response bodies)', async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`
    const executionId = `ex-${crypto.randomUUID()}`
    const token = await mint({ workspaceId, executionId })
    await seedQwenKey(workspaceId)

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    )

    // Inject a recording publisher in place of the DO-backed one so we can observe the
    // emit directly (the real one fans out to the WorkspaceEventsHub).
    const recorder = new RecordingEventPublisher()
    const app = createApp({
      overrides: { agentExecutor: new FakeAgentExecutor(), executionEventPublisher: recorder },
    })
    const res = await app.fetch(chatRequest(token, 'cheap-model'), testEnv())
    expect(res.status).toBe(200)

    // The proxy pushed exactly one activity event, sourced at the proxy (not the driver).
    expect(recorder.llmCalls).toHaveLength(1)
    const activity = recorder.llmCalls[0]!
    expect(activity.workspaceId).toBe(workspaceId)
    expect(activity.executionId).toBe(executionId)
    expect(activity.agentKind).toBe('coder')
    expect(activity.provider).toBe('qwen')
    expect(activity.model).toBe('qwen3-max')
    expect(activity.ok).toBe(true)
    expect(activity.httpStatus).toBe(200)
    expect(activity.promptTokens).toBe(10)
    expect(activity.completionTokens).toBe(5)
    expect(activity.totalTokens).toBe(15)
    expect(activity.finishReason).toBe('stop')
    expect(typeof activity.id).toBe('string')
    // Compact wire shape: the heavy bodies are never pushed over the stream.
    expect(activity).not.toHaveProperty('promptText')
    expect(activity).not.toHaveProperty('responseText')
    expect(activity).not.toHaveProperty('reasoningText')
  })

  it('returns 502 when the locked provider has no configured key', async () => {
    const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
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

    const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
    const token = await mint({ provider: 'workers-ai', model: '@cf/meta/llama-3.1-8b-instruct' })
    // No QWEN_API_KEY needed; AI binding removed → guarded 502 (not 502 "no key").
    const noBinding = { ...testEnv({ QWEN_API_KEY: '' }), AI: undefined }
    const res = await app.fetch(chatRequest(token), noBinding as Parameters<typeof app.fetch>[1])

    expect(res.status).toBe(502)
    // With no in-process path available (AI binding removed), the runtime-neutral
    // controller reports the provider as unavailable rather than forwarding upstream.
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
      /Provider 'workers-ai' is not available/,
    )
    // The workers-ai path never reaches the OpenAI-compatible fetch upstream.
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
