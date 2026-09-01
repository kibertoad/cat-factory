import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type {
  AgentContextSnapshot,
  AgentSearchQuery,
  AgentToolCall,
  LlmCallMetric,
} from '@cat-factory/kernel'
import { HmacSigner, TOKEN_AUDIENCE } from '../src/auth/signing.js'
import { mintMachineToken } from '../src/auth/machineToken.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { telemetryIngestController } from '../src/modules/telemetry/TelemetryIngestController.js'
import {
  HttpMachineTelemetryClient,
  MAX_TELEMETRY_INGEST_CHARS,
  MachineTokenUnavailableError,
  TELEMETRY_INGEST_LIMITS,
} from '../src/telemetry/machineTelemetry.js'

// The mothership-mode telemetry INGEST endpoint (`POST /internal/telemetry/ingest`, PR 5's sync
// UP): a machine-authed mothership-mode node uploads a quiesced run's locally captured telemetry
// so hosted teammates can read it and it outlives the node's short local retention window.
//
// Verify the machine-token audience pin (missing / wrong-audience / wrong-secret), the workspace →
// account scope binding (uniform 404, no existence leak), the property that carries the security
// weight — the batch's SCOPE is stamped onto every row, so a node cannot file rows into a
// workspace or a run it did not address — the row caps and byte backstop (refused, never silently
// truncated), whole-batch rejection of out-of-contract rows, the 503 on a facade that is not a
// mothership, and the client round-trip.

const SECRET = 'test-session-secret-0123456789'
const ACCOUNT = 'acc_1'
const OTHER_ACCOUNT = 'acc_2'
const ACCOUNT_BY_WORKSPACE: Record<string, string> = { ws_1: ACCOUNT, ws_other: OTHER_ACCOUNT }

function metric(overrides: Partial<LlmCallMetric> & Pick<LlmCallMetric, 'id'>): LlmCallMetric {
  return {
    workspaceId: 'ws_1',
    executionId: 'exe_1',
    agentKind: 'coder',
    provider: 'workers-ai',
    model: 'm',
    createdAt: 1,
    streaming: false,
    phase: 'agent',
    turnIndex: null,
    spendOnly: false,
    messageCount: 2,
    toolCount: 1,
    requestMaxTokens: 1000,
    promptTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    completionTokens: 50,
    totalTokens: 150,
    finishReason: 'stop',
    upstreamMs: 200,
    overheadMs: 30,
    totalMs: 230,
    ok: true,
    httpStatus: 200,
    errorMessage: null,
    promptText: '[]',
    promptPrefixCount: 0,
    promptHash: '',
    responseText: 'ok',
    reasoningText: '',
    reportedCostUsd: null,
    upstreamProvider: null,
    ...overrides,
  }
}

function snapshot(
  overrides: Partial<AgentContextSnapshot> & Pick<AgentContextSnapshot, 'id'>,
): AgentContextSnapshot {
  return {
    workspaceId: 'ws_1',
    executionId: 'exe_1',
    agentKind: 'coder',
    stepIndex: 0,
    createdAt: 1,
    model: 'workers-ai:m',
    harness: 'pi',
    systemPrompt: 'system',
    userPrompt: 'user',
    fragments: [],
    contextFiles: [],
    extras: {},
    ...overrides,
  }
}

function search(
  overrides: Partial<AgentSearchQuery> & Pick<AgentSearchQuery, 'id'>,
): AgentSearchQuery {
  return {
    workspaceId: 'ws_1',
    executionId: 'exe_1',
    agentKind: 'coder',
    provider: 'searxng',
    query: 'q',
    resultCount: 1,
    createdAt: 1,
    ...overrides,
  }
}

function toolCall(overrides: Partial<AgentToolCall> & Pick<AgentToolCall, 'id'>): AgentToolCall {
  return {
    workspaceId: 'ws_1',
    executionId: 'exe_1',
    agentKind: 'coder',
    jobId: 'job_1',
    seq: 0,
    tool: 'bash',
    startedAt: 1,
    endedAt: 2,
    ok: true,
    bodies: 'stored',
    args: '{"command":"ls"}',
    result: 'a.ts',
    argsDropped: 0,
    resultDropped: 0,
    createdAt: 1,
    ...overrides,
  }
}

interface Stored {
  metrics: LlmCallMetric[]
  snapshots: AgentContextSnapshot[]
  searchQueries: AgentSearchQuery[]
  toolCalls: AgentToolCall[]
}

function makeApp(opts: { repositories?: boolean; throws?: boolean; stored?: Stored } = {}) {
  const stored: Stored = opts.stored ?? {
    metrics: [],
    snapshots: [],
    searchQueries: [],
    toolCalls: [],
  }
  const container = {
    repositories:
      opts.repositories === false
        ? undefined
        : {
            workspaceRepository: {
              accountOf: async (id: string) => ACCOUNT_BY_WORKSPACE[id] ?? null,
            },
            llmCallMetricRepository: {
              recordMany: async (rows: LlmCallMetric[]) => {
                if (opts.throws) throw new Error('telemetry db down')
                stored.metrics.push(...rows)
              },
            },
            agentContextSnapshotRepository: {
              recordMany: async (rows: AgentContextSnapshot[]) => stored.snapshots.push(...rows),
            },
            agentSearchQueryRepository: {
              recordMany: async (rows: AgentSearchQuery[]) => stored.searchQueries.push(...rows),
            },
            agentToolCallRepository: {
              recordMany: async (rows: AgentToolCall[]) => stored.toolCalls.push(...rows),
            },
          },
    config: { auth: { sessionSecret: SECRET } },
  } as unknown as ServerContainer
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/', telemetryIngestController())
  app.onError(handleError)
  return { app, stored }
}

async function machineToken(accountIds = [ACCOUNT]) {
  return (await mintMachineToken(SECRET, { userId: 'usr_1', accountIds })).token
}

function ingest(app: Hono<AppEnv>, token: string | undefined, body: unknown) {
  return app.fetch(
    new Request('http://x/internal/telemetry/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
}

describe('POST /internal/telemetry/ingest', () => {
  it('appends an in-scope run’s batch across every sink', async () => {
    const { app, stored } = makeApp()
    const res = await ingest(app, await machineToken(), {
      workspaceId: 'ws_1',
      executionId: 'exe_1',
      metrics: [metric({ id: 'm1' }), metric({ id: 'm2' })],
      snapshots: [snapshot({ id: 's1' })],
      searchQueries: [search({ id: 'q1' })],
      toolCalls: [toolCall({ id: 't1' })],
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as unknown).toEqual({
      ok: true,
      stored: { metrics: 2, snapshots: 1, searchQueries: 1, toolCalls: 1 },
    })
    expect(stored.metrics.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(stored.snapshots.map((s) => s.id)).toEqual(['s1'])
    expect(stored.searchQueries.map((q) => q.id)).toEqual(['q1'])
    expect(stored.toolCalls.map((t) => t.id)).toEqual(['t1'])
  })

  it('stamps the batch’s scope onto every row, discarding what the rows claim', async () => {
    // The property that carries the security weight: a node can address only workspaces its token
    // covers, and every row it uploads is filed under THAT workspace and THAT run. Without this a
    // node scoped to one workspace could stamp another workspace's id onto its rows and pollute a
    // board it can't reach — or attribute spend-shaped telemetry to someone else's run.
    const { app, stored } = makeApp()
    const res = await ingest(app, await machineToken(), {
      workspaceId: 'ws_1',
      executionId: 'exe_1',
      metrics: [metric({ id: 'm1', workspaceId: 'ws_other', executionId: 'exe_someone_else' })],
      snapshots: [snapshot({ id: 's1', workspaceId: 'ws_other', executionId: 'exe_x' })],
      searchQueries: [search({ id: 'q1', workspaceId: 'ws_other', executionId: 'exe_x' })],
    })
    expect(res.status).toBe(200)
    for (const row of [stored.metrics[0]!, stored.snapshots[0]!, stored.searchQueries[0]!]) {
      expect(row.workspaceId).toBe('ws_1')
      expect(row.executionId).toBe('exe_1')
    }
  })

  it('accepts an empty batch as a no-op ack', async () => {
    // The drain posts until a page comes back empty, so an empty batch must not be an error.
    const { app, stored } = makeApp()
    const res = await ingest(app, await machineToken(), {
      workspaceId: 'ws_1',
      executionId: 'exe_1',
    })
    expect(res.status).toBe(200)
    expect(stored.metrics).toHaveLength(0)
  })

  it('refuses a missing, wrong-audience or wrong-secret token with 403 before any other check', async () => {
    const { app, stored } = makeApp()
    const body = { workspaceId: 'ws_1', executionId: 'exe_1', metrics: [metric({ id: 'm1' })] }
    expect((await ingest(app, undefined, body)).status).toBe(403)

    // A valid SESSION token is not a machine token — the audience pin is what separates them.
    const session = await new HmacSigner(SECRET).sign({
      userId: 'usr_1',
      aud: TOKEN_AUDIENCE.session,
      exp: Date.now() + 60_000,
    })
    expect((await ingest(app, session, body)).status).toBe(403)

    const foreign = (
      await mintMachineToken('another-secret-0123456789', {
        userId: 'usr_1',
        accountIds: [ACCOUNT],
      })
    ).token
    expect((await ingest(app, foreign, body)).status).toBe(403)
    expect(stored.metrics).toHaveLength(0)
  })

  it('checks the token BEFORE the mothership probe, so availability is not probeable', async () => {
    const { app } = makeApp({ repositories: false })
    expect(
      (await ingest(app, undefined, { workspaceId: 'ws_1', executionId: 'exe_1' })).status,
    ).toBe(403)
    // With a token, the same facade reports it is not a mothership.
    expect(
      (await ingest(app, await machineToken(), { workspaceId: 'ws_1', executionId: 'exe_1' }))
        .status,
    ).toBe(503)
  })

  it('refuses an out-of-scope or unknown workspace with a uniform 404 and stores nothing', async () => {
    const { app, stored } = makeApp()
    const token = await machineToken()
    const rows = { metrics: [metric({ id: 'm1' })] }
    expect(
      (await ingest(app, token, { workspaceId: 'ws_other', executionId: 'exe_1', ...rows })).status,
    ).toBe(404)
    expect(
      (await ingest(app, token, { workspaceId: 'ws_nope', executionId: 'exe_1', ...rows })).status,
    ).toBe(404)
    expect(stored.metrics).toHaveLength(0)
  })

  it('refuses an oversized batch rather than truncating it', async () => {
    // Truncation would be the dangerous outcome: a 2xx tells the node the range is stored, so it
    // moves its high-water mark past rows the mothership silently dropped.
    const { app, stored } = makeApp()
    const res = await ingest(app, await machineToken(), {
      workspaceId: 'ws_1',
      executionId: 'exe_1',
      metrics: Array.from({ length: TELEMETRY_INGEST_LIMITS.metrics + 1 }, (_, i) =>
        metric({ id: `m${i}` }),
      ),
    })
    expect(res.status).toBe(413)
    expect(stored.metrics).toHaveLength(0)
  })

  it('refuses a batch whose ACTUAL bytes exceed the body backstop', async () => {
    // The other half of the size guard: `content-length` is absent on a chunked upload (and is in
    // any case the client's claim about itself), so the measured length stays the authority. A
    // `Request` sets no content-length of its own, so this reaches the check after the read.
    const { app, stored } = makeApp()
    const res = await ingest(app, await machineToken(), {
      workspaceId: 'ws_1',
      executionId: 'exe_1',
      snapshots: [snapshot({ id: 's1', systemPrompt: 'x'.repeat(9_000_000) })],
    })
    expect(res.status).toBe(413)
    expect(stored.snapshots).toHaveLength(0)
  })

  it('rejects the WHOLE batch when any row is out of contract', async () => {
    // Partial acceptance would lose rows silently: the node reads a 2xx as "this range is stored".
    const { app, stored } = makeApp()
    const res = await ingest(app, await machineToken(), {
      workspaceId: 'ws_1',
      executionId: 'exe_1',
      metrics: [metric({ id: 'm1' }), { id: 'm2', promptTokens: 'lots' }],
    })
    expect(res.status).toBe(422)
    expect(stored.metrics).toHaveLength(0)
  })

  it('reports a failed append as a 500 so the node retries the run', async () => {
    const { app } = makeApp({ throws: true })
    const res = await ingest(app, await machineToken(), {
      workspaceId: 'ws_1',
      executionId: 'exe_1',
      metrics: [metric({ id: 'm1' })],
    })
    expect(res.status).toBe(500)
  })

  it('round-trips through HttpMachineTelemetryClient', async () => {
    const { app, stored } = makeApp()
    const token = await machineToken()
    const client = new HttpMachineTelemetryClient({
      baseUrl: 'http://mothership.test/',
      token: () => token,
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
        app.fetch(new Request(String(input), init))) as typeof fetch,
    })
    const result = await client.ingest({
      workspaceId: 'ws_1',
      executionId: 'exe_1',
      metrics: [metric({ id: 'm1' })],
    })
    expect(result).toEqual({ metrics: 1, snapshots: 0, searchQueries: 0, toolCalls: 0 })
    expect(stored.metrics.map((m) => m.id)).toEqual(['m1'])
  })

  it('skips the upload but REJECTS when the node holds no machine token yet', async () => {
    // A node booted before the mothership login has nothing to sync to, so posting megabytes for a
    // guaranteed 403 is pure waste — but the skip must be a REJECTION, not an empty success. The
    // sweep advances a run's high-water mark on a resolved ingest, so a zeroed result here is
    // indistinguishable from "the run had no rows": it would mark the run uploaded and let the
    // local retention prune delete telemetry the mothership never received.
    let called = 0
    const client = new HttpMachineTelemetryClient({
      baseUrl: 'http://mothership.test',
      token: () => null,
      fetchImpl: async () => {
        called += 1
        return new Response('{}')
      },
    })
    await expect(
      client.ingest({ workspaceId: 'ws_1', executionId: 'exe_1' }),
    ).rejects.toBeInstanceOf(MachineTokenUnavailableError)
    expect(called).toBe(0)
  })

  it('refuses an oversized batch on the DECLARED length, before reading the body', async () => {
    // `c.req.text()` buffers the whole request, so a check that runs after it bounds the parsed
    // object graph but not the string it parses from. The header check is what keeps a compromised
    // node token from making the mothership hold an arbitrarily large body.
    //
    // The body here is a valid, in-scope, well under-cap batch — the ONLY thing that can produce a
    // 413 is the declared length, so this fails if the header check is dropped.
    const { app, stored } = makeApp()
    const req = new Request('http://x/internal/telemetry/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await machineToken()}`,
      },
      body: JSON.stringify({
        workspaceId: 'ws_1',
        executionId: 'exe_1',
        metrics: [metric({ id: 'm1' })],
      }),
    })
    req.headers.set('content-length', String(MAX_TELEMETRY_INGEST_CHARS + 1))
    const res = await app.fetch(req)
    expect(res.status).toBe(413)
    expect(stored.metrics).toHaveLength(0)
  })

  it('rejects on an HTTP failure so the sweep leaves the run’s high-water mark alone', async () => {
    const client = new HttpMachineTelemetryClient({
      baseUrl: 'http://mothership.test',
      token: 'tok',
      fetchImpl: async () => new Response('nope', { status: 502 }),
    })
    await expect(client.ingest({ workspaceId: 'ws_1', executionId: 'exe_1' })).rejects.toThrow(
      /502/,
    )
  })
})
