import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import { RecordingEventPublisher } from '@cat-factory/conformance'
import { createApp } from '../../src/app'
import { buildContainer } from '../../src/infrastructure/container'
import { ContainerSessionService } from '../../src/infrastructure/containers/ContainerSessionService'
import { D1WorkspaceSettingsRepository } from '../../src/infrastructure/repositories/D1WorkspaceSettingsRepository'
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
    ...overrides,
  }
}

/**
 * Force a workspace over budget by pinning its monthly spend limit to 0 (the budget is
 * per-workspace on `workspace_settings` now, no longer the `SPEND_MONTHLY_LIMIT` env).
 */
async function seedZeroBudget(workspaceId: string) {
  await new D1WorkspaceSettingsRepository({ db: env.DB }).upsert(workspaceId, {
    ...DEFAULT_WORKSPACE_SETTINGS,
    spendMonthlyLimit: 0,
  })
}

function chatRequest(token: string | null, model = 'whatever', phase?: string) {
  // The phase-tagged path the harness points Pi at for the pass it is running; the plain path
  // is the same handler with nothing to attribute.
  const path = phase ? `/v1/phase/${phase}/chat/completions` : '/v1/chat/completions'
  return new Request(`${BASE}${path}`, {
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
    const workspaceId = `ws-${crypto.randomUUID()}`
    await seedZeroBudget(workspaceId)
    const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
    const token = await mint({ workspaceId })
    const res = await app.fetch(chatRequest(token), testEnv())
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

  // The CONTAINER half of gateway attribution: what the proxy ASKS for. The inline path asks for
  // the same two things through `openRouterResolver`, and a path that stopped asking keeps working
  // and simply records nothing, which downstream is indistinguishable from a gateway that reports
  // nothing. What is done with the ANSWER is pinned next door (`gateway-attribution` unit tests
  // for the read, the conformance suite for the column mapping), for the reason the cached-classes
  // test below records: both sinks are composed from one pass, so what can drift is the
  // derivation, not the write.
  it('asks OpenRouter for usage accounting and parameter-aware routing', async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`
    const token = await mint({
      workspaceId,
      provider: 'openrouter',
      model: 'anthropic/claude-opus-5',
    })
    const c = buildContainer(env, { agentExecutor: new FakeAgentExecutor() })
    await c.apiKeys!.addKey('workspace', workspaceId, {
      provider: 'openrouter',
      label: 'gateway',
      key: 'sk-or',
    })

    let forwarded: Record<string, unknown> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        forwarded = JSON.parse(init.body) as Record<string, unknown>
        return new Response(
          JSON.stringify({
            provider: 'anthropic',
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0421 },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      }),
    )

    const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
    expect((await app.fetch(chatRequest(token), testEnv())).status).toBe(200)

    expect(forwarded.usage).toEqual({ include: true })
    expect(forwarded.provider).toMatchObject({ require_parameters: true, data_collection: 'deny' })
    // The locked model still wins over whatever the container asked for, gateway params or not.
    expect(forwarded.model).toBe('anthropic/claude-opus-5')
  })

  it('sends no gateway params to a provider that has none', async () => {
    // An unknown key in the body of a strict endpoint buys nothing and can be refused, so the
    // params are gateway-only rather than merged for everyone.
    const workspaceId = `ws-${crypto.randomUUID()}`
    const token = await mint({ workspaceId })
    await seedQwenKey(workspaceId)

    let forwarded: Record<string, unknown> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        forwarded = JSON.parse(init.body) as Record<string, unknown>
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
    expect((await app.fetch(chatRequest(token), testEnv())).status).toBe(200)

    expect(forwarded.usage).toBeUndefined()
    expect(forwarded.provider).toBeUndefined()
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

  it('records a cached upstream call as its three orthogonal input classes', async () => {
    // The proxy is where an upstream's usage payload becomes the recorded input split, and a
    // wrong sign here quietly halves or doubles every number downstream. The upstream shape is
    // INCLUSIVE (the OpenAI wire): `prompt_tokens` is the whole prompt, with the cached share
    // inside it — so the recorded fresh figure is the difference, and the three classes must
    // still add back up to what the vendor said it billed.
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
              usage: {
                prompt_tokens: 5_000,
                prompt_tokens_details: { cached_tokens: 4_400 },
                completion_tokens: 5,
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    )

    const recorder = new RecordingEventPublisher()
    const app = createApp({
      overrides: { agentExecutor: new FakeAgentExecutor(), executionEventPublisher: recorder },
    })
    const res = await app.fetch(chatRequest(token, 'cheap-model'), testEnv())
    expect(res.status).toBe(200)

    const activity = recorder.llmCalls[0]!
    expect(activity.promptTokens).toBe(600)
    expect(activity.cacheReadTokens).toBe(4_400)
    // Qwen exposes no write class: 0, never guessed into existence.
    expect(activity.cacheWriteTokens).toBe(0)
    expect(activity.completionTokens).toBe(5)
    // The classes are additive, so the total is their sum plus the output — and its input half
    // still equals the vendor's own `prompt_tokens`.
    expect(activity.totalTokens).toBe(5_005)
    // The live event is asserted rather than the persisted row because both sinks are composed
    // from the SAME values in one pass: what could drift is the derivation, which this pins,
    // not the two writes. The row's own column mapping is pinned by the conformance suite.
  })

  it('attributes a call to the run phase on its path, and refuses a bogus one', async () => {
    // The phase axis (docs/initiatives/token-burn-instrumentation.md): the harness re-points Pi
    // at a phase-tagged URL per pass, so the proxy — which otherwise sees only an HTTP request —
    // can say WHICH slice of the run spent a call. The segment is untrusted (a session token is
    // all it takes to write one), so anything outside the phase alphabet must fall back to the
    // unattributed slice rather than become a grouping key of its own.
    const workspaceId = `ws-${crypto.randomUUID()}`
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

    const recorder = new RecordingEventPublisher()
    const app = createApp({
      overrides: { agentExecutor: new FakeAgentExecutor(), executionEventPublisher: recorder },
    })
    const call = async (phase?: string) => {
      const token = await mint({ workspaceId, executionId: `ex-${crypto.randomUUID()}` })
      const res = await app.fetch(chatRequest(token, 'cheap-model', phase), testEnv())
      expect(res.status).toBe(200)
      return recorder.llmCalls[recorder.llmCalls.length - 1]!
    }

    expect((await call('validation-repair')).phase).toBe('validation-repair')
    // The unphased path still serves the same handler — that is what keeps an older harness
    // image working — and its calls are honestly unattributed.
    expect((await call()).phase).toBe('')
    expect((await call('Not A Phase!')).phase).toBe('')
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
