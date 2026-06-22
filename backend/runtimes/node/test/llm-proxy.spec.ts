import { RecordingEventPublisher } from '@cat-factory/conformance'
import { ContainerSessionService } from '@cat-factory/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildNodeContainer } from '../src/container.js'
import { createApp } from '../src/server.js'
import { setupTestDb } from './harness.js'

// The LLM proxy + its live `llmCall` activity event are runtime-neutral (shared
// `@cat-factory/server` controller), but each facade composes the proxy over its own
// gateways + publisher. This spec proves the Node facade's real Hono app pushes the
// SAME compact activity event the Cloudflare Worker does (the Worker asserts it over
// the DO publisher in its own `llm-proxy.spec.ts`) — so the live "Model activity"
// stream can't silently work on one runtime and not the other. CI provides Postgres
// via `DATABASE_URL`; without it the spec skips.

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

  describe('[node] llm proxy live activity event', () => {
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

      // Inject a recording publisher so we can observe the emit directly (Node's real
      // publisher is the no-op NoopEventPublisher — there is no real-time transport yet,
      // but the shared controller still drives the emit identically to the Worker).
      const recorder = new RecordingEventPublisher()
      const container = buildNodeContainer({
        db,
        env: TEST_ENV,
        overrides: { executionEventPublisher: recorder },
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
    })
  })
} else {
  describe.skip('[node] llm proxy live activity event (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
