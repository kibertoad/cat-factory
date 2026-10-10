import { RecordingEventPublisher } from '@cat-factory/conformance'
import { ContainerSessionService } from '@cat-factory/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildNodeContainer } from '../src/container.js'
import { createApp } from '../src/server.js'
import { setupTestDb } from './harness.js'

// The LLM proxy controller is runtime-neutral (shared `@cat-factory/server`), but each facade
// composes it over its OWN gateways and publisher, so what this spec is for is the behaviour that
// only the composition can show. Two things:
//
//   - the live `llmCall` activity event: the Node app must push the SAME compact event the
//     Cloudflare Worker does (the Worker asserts it over the DO publisher in its own
//     `llm-proxy.spec.ts`), or the "Model activity" stream silently works on one runtime only;
//   - `workers-ai` routing: the Worker runs it in-process through the `AI` binding, and this facade
//     has no binding, so the controller's fall-through to Cloudflare's OpenAI-compatible REST
//     endpoint can only be driven here. That fall-through is what stops a dispatch guard that
//     admits `workers-ai` everywhere from killing a run on a facade that refuses it.
//
// CI provides Postgres via `DATABASE_URL`; without it the spec skips.

const BASE = 'https://cat-factory.test'
const SECRET = 'proxy-secret'

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()

  // Minimal env to load the Node config: dev-open auth, the always-required shared
  // ENCRYPTION_KEY, the session secret the proxy verifies tokens with, and an upstream
  // key so a `qwen`-locked call resolves an OpenAI-compatible upstream (stubbed below).
  const TEST_ENV: NodeJS.ProcessEnv = {
    ...process.env,
    AUTH_DEV_OPEN: 'true',
    ENVIRONMENT: 'test',
    ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
    AUTH_SESSION_SECRET: SECRET,
    QWEN_API_KEY: 'sk-upstream',
  }

  function chatRequest(token: string) {
    return new Request(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'whatever', messages: [{ role: 'user', content: 'hi' }] }),
    })
  }

  /** Capture the single upstream call the proxy makes, answering an OpenAI-shaped completion. */
  function stubUpstream(): { url: () => string; auth: () => string } {
    let url = ''
    let auth = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (target: string, init: { headers: Record<string, string> }) => {
        url = target
        auth = init.headers.authorization ?? ''
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      }),
    )
    return { url: () => url, auth: () => auth }
  }

  describe('[node] llm proxy', () => {
    afterEach(() => vi.restoreAllMocks())

    it('pushes a compact llmCall activity event per proxied call (no prompt/response bodies)', async () => {
      const workspaceId = `ws-${crypto.randomUUID()}`
      const executionId = `ex-${crypto.randomUUID()}`
      const token = await new ContainerSessionService({ secret: SECRET }).mint({
        workspaceId,
        executionId,
        agentKind: 'coder',
        provider: 'qwen',
        model: 'qwen3-max',
      })

      stubUpstream()

      // Inject a recording publisher so we can observe the emit directly (Node's real
      // publisher is the no-op NoopEventPublisher — there is no real-time transport yet,
      // but the shared controller still drives the emit identically to the Worker).
      const recorder = new RecordingEventPublisher()
      const container = buildNodeContainer({
        db,
        env: TEST_ENV,
        overrides: { executionEventPublisher: recorder },
      })
      // Provider keys are DB-backed now (no longer env): seed the workspace-scoped qwen
      // key the proxy leases for the upstream call.
      await container.apiKeys!.addKey('workspace', workspaceId, {
        provider: 'qwen',
        label: 'upstream',
        key: 'sk-upstream',
      })
      const app = createApp(container, TEST_ENV)

      const res = await app.fetch(chatRequest(token))
      expect(res.status).toBe(200)

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

    it('serves a workers-ai-locked step over the Cloudflare REST endpoint, with no pooled key', async () => {
      // The other half of the shared controller's `workers-ai` decision, and the one only this
      // facade can drive: there is no `AI` binding here, so `runInProcess` answers null and the
      // controller must fall THROUGH to the forward path. `isProxyableProvider` admits `workers-ai`
      // on every facade and the catalog offers every Cloudflare model once these two vars are set,
      // so refusing it here killed a `coder` step at its first proxy call on a model the picker had
      // just called available.
      const workspaceId = `ws-${crypto.randomUUID()}`
      const executionId = `ex-${crypto.randomUUID()}`
      const token = await new ContainerSessionService({ secret: SECRET }).mint({
        workspaceId,
        executionId,
        agentKind: 'coder',
        provider: 'workers-ai',
        model: '@cf/meta/llama-3.1-8b-instruct',
      })
      const upstream = stubUpstream()

      const container = buildNodeContainer({
        db,
        env: {
          ...TEST_ENV,
          CLOUDFLARE_ACCOUNT_ID: 'acct1',
          CLOUDFLARE_API_TOKEN: 'cf-account-token',
        },
      })
      // Deliberately NO seeded key: `workers-ai` is not an `ApiKeyProvider`, so there is no pool to
      // lease from and the bearer has to ride the resolved endpoint instead.
      const app = createApp(container, TEST_ENV)

      const res = await app.fetch(chatRequest(token))
      expect(res.status).toBe(200)
      expect(upstream.url()).toBe(
        'https://api.cloudflare.com/client/v4/accounts/acct1/ai/v1/chat/completions',
      )
      expect(upstream.auth()).toBe('Bearer cf-account-token')
    })

    it('refuses a workers-ai-locked step when the Cloudflare pair is unset', async () => {
      // Neither route: no binding on Node and no REST credentials to forward with. Reported as the
      // provider being unavailable rather than as an upstream failure, because nothing was dialled.
      const token = await new ContainerSessionService({ secret: SECRET }).mint({
        workspaceId: `ws-${crypto.randomUUID()}`,
        executionId: `ex-${crypto.randomUUID()}`,
        agentKind: 'coder',
        provider: 'workers-ai',
        model: '@cf/meta/llama-3.1-8b-instruct',
      })
      const upstream = stubUpstream()

      const app = createApp(buildNodeContainer({ db, env: TEST_ENV }), TEST_ENV)
      const res = await app.fetch(chatRequest(token))
      expect(res.status).toBe(502)
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
        /Provider 'workers-ai' is not available/,
      )
      expect(upstream.url()).toBe('')
    })
  })
} else {
  describe.skip('[node] llm proxy (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
