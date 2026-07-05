import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { DEFAULT_SPEND_PRICING, SpendService } from '@cat-factory/spend'
import {
  type AppEnv,
  ContainerSessionService,
  type LlmUpstream,
  llmProxyController,
} from '@cat-factory/server'
import { freePort, listen, streamingLlmStub } from './support'

/** A minimal OpenAI-compatible upstream gateway pointing at the in-test stub. */
function stubLlmUpstream(baseURL: string): LlmUpstream {
  return {
    resolveOpenAiCompatible: (provider) =>
      provider === 'qwen' ? { baseURL, apiKey: 'real-upstream-key' } : null,
    // No in-process (binding) path in this test; the proxy forwards over HTTP.
    runInProcess: () => null,
  }
}

// Real-proxy acceptance test: exercises the **actual** production proxy
// (LlmProxyController) + the real SpendService over real HTTP — the same code a
// container's Pi calls — with only the upstream provider and the spend ledger
// stubbed. It proves the proxy verifies the session token, LOCKS the model,
// INJECTS the real provider key (the container's token never reaches upstream),
// streams the response, and METERS exactly one priced call.
//
// (The container ↔ proxy network wiring itself is covered by the dummy-proxy
// container E2E in container.acceptance.test.ts; here we focus on the real proxy
// behaviour, in-process, so it runs fast and deterministically.)

const SECRET = 'real-proxy-secret'

/** Stand up the real proxy in front of a canned streaming upstream. */
async function startRealProxy() {
  const upstream = streamingLlmStub()
  const upstreamPort = await listen(upstream.server)

  // Real SpendService, backed by an in-memory ledger (the proxy is agnostic to
  // whether it's D1) so we can assert exactly what was metered.
  const ledger: {
    provider: string
    model: string
    inputTokens: number
    outputTokens: number
    workspaceId: string
    executionId: string | null
  }[] = []
  const spendService = new SpendService({
    tokenUsageRepository: {
      record: async (row) => {
        ledger.push(row)
      },
      totalsSince: async () => ({ inputTokens: 0, outputTokens: 0, costEstimate: 0 }),
      totalsSinceForWorkspace: async () => ({ inputTokens: 0, outputTokens: 0, costEstimate: 0 }),
      totalsSinceForAccount: async () => ({ inputTokens: 0, outputTokens: 0, costEstimate: 0 }),
      totalsSinceForUser: async () => ({ inputTokens: 0, outputTokens: 0, costEstimate: 0 }),
      deleteOlderThan: async () => 0,
    },
    idGenerator: { next: (p: string) => `${p}-${ledger.length}` },
    clock: { now: () => Date.now() },
    pricing: DEFAULT_SPEND_PRICING,
  })

  // Provide an execution context so streamed-usage metering via waitUntil is tracked
  // (Hono exposes the 3rd `app.fetch` arg as `c.executionCtx`); the controller reads
  // the session secret + the upstream gateway off the request container.
  const pending: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(Promise.resolve(p)),
    passThroughOnException: () => {},
  }
  const container = {
    config: { auth: { sessionSecret: SECRET } },
    spendService,
    gateways: { llmUpstream: stubLlmUpstream(`http://127.0.0.1:${upstreamPort}/v1`) },
    // Provider keys are DB-backed now: the proxy leases the real upstream key from the
    // pool (not the env/gateway). Stub the pool to lease it so the injected-key + usage
    // assertions hold, mirroring a configured workspace.
    apiKeys: {
      lease: async () => ({ keyId: 'apikey-real', provider: 'qwen', secret: 'real-upstream-key' }),
      recordUsage: async () => {},
    },
  }

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container as never)
    await next()
  })
  app.route('/', llmProxyController())

  const port = await freePort()
  const server = serve({
    fetch: (req: Request) => app.fetch(req, {} as never, ctx as never),
    port,
    hostname: '127.0.0.1',
  }) as unknown as Server

  return { upstream, ledger, pending, port, server, spendService }
}

describe('real proxy (in-process LlmProxyController)', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn()
  })

  function token(overrides: Record<string, string> = {}) {
    return new ContainerSessionService({ secret: SECRET }).mint({
      workspaceId: 'ws-real',
      executionId: 'ex-real',
      agentKind: 'coder',
      provider: 'qwen',
      model: 'qwen3-max',
      ...overrides,
    })
  }

  it('rejects an unauthenticated request', async () => {
    const proxy = await startRealProxy()
    cleanups.push(() => {
      proxy.server.close()
      proxy.upstream.server.close()
    })
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    })
    expect(res.status).toBe(401)
  })

  it('locks the model, injects the real key, streams, and meters usage', async () => {
    const proxy = await startRealProxy()
    cleanups.push(() => {
      proxy.server.close()
      proxy.upstream.server.close()
    })

    // A streaming request like Pi's second turn (a tool result is present, so the
    // stub returns the final message + a usage chunk). The client asks for a
    // different model on purpose — the proxy must override it.
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'whatever-the-client-asked',
        stream: true,
        messages: [
          { role: 'user', content: 'do it' },
          { role: 'tool', content: 'wrote the file' },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const sse = await res.text()
    expect(sse).toContain('data:')
    expect(sse).toContain('[DONE]')

    // The upstream saw the injected real key and the session-locked model — never
    // the session token nor the client's requested model.
    expect(proxy.upstream.requests).toHaveLength(1)
    expect(proxy.upstream.requests[0]!.auth).toBe('Bearer real-upstream-key')
    expect(proxy.upstream.requests[0]!.model).toBe('qwen3-max')

    // The real SpendService metered exactly one priced call against the run.
    await Promise.all(proxy.pending)
    expect(proxy.ledger).toHaveLength(1)
    expect(proxy.ledger[0]).toMatchObject({
      provider: 'qwen',
      model: 'qwen3-max',
      inputTokens: 12,
      outputTokens: 4,
      workspaceId: 'ws-real',
      executionId: 'ex-real',
    })
  })

  it('returns 402 when the spend budget is exhausted', async () => {
    const upstream = streamingLlmStub()
    const upstreamPort = await listen(upstream.server)
    // SpendService whose ledger already reports spend at/over the limit.
    const spendService = new SpendService({
      tokenUsageRepository: {
        record: async () => {},
        totalsSince: async () => ({ inputTokens: 0, outputTokens: 0, costEstimate: 999 }),
        totalsSinceForWorkspace: async () => ({
          inputTokens: 0,
          outputTokens: 0,
          costEstimate: 999,
        }),
        totalsSinceForAccount: async () => ({ inputTokens: 0, outputTokens: 0, costEstimate: 999 }),
        totalsSinceForUser: async () => ({ inputTokens: 0, outputTokens: 0, costEstimate: 999 }),
        deleteOlderThan: async () => 0,
      },
      idGenerator: { next: (p: string) => p },
      clock: { now: () => Date.now() },
      pricing: DEFAULT_SPEND_PRICING,
    })
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} }
    const container = {
      config: { auth: { sessionSecret: SECRET } },
      spendService,
      gateways: { llmUpstream: stubLlmUpstream(`http://127.0.0.1:${upstreamPort}/v1`) },
    }
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('container', container as never)
      await next()
    })
    app.route('/', llmProxyController())
    const port = await freePort()
    const server = serve({
      fetch: (req: Request) => app.fetch(req, {} as never, ctx as never),
      port,
      hostname: '127.0.0.1',
    }) as unknown as Server
    cleanups.push(() => {
      server.close()
      upstream.server.close()
    })

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    })
    expect(res.status).toBe(402)
    // Budget gate fires before any upstream call.
    expect(upstream.requests).toHaveLength(0)
  })
})
