import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { LlmCallMetric } from '@cat-factory/kernel'
import { HmacSigner, TOKEN_AUDIENCE } from '../src/auth/signing.js'
import { mintMachineToken } from '../src/auth/machineToken.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { telemetryReadController } from '../src/modules/telemetry/TelemetryReadController.js'
import {
  HttpMachineTelemetryReadClient,
  MAX_TELEMETRY_READ_CHARS,
  MAX_TELEMETRY_READ_ROW_CHARS,
  MachineTokenUnavailableForReadError,
  TELEMETRY_READ_METHODS,
  TELEMETRY_READ_PAGE_SIZES,
  TELEMETRY_READ_TOO_LARGE_CODE,
} from '../src/telemetry/machineTelemetryRead.js'
import { MAX_AGENT_CONTEXT_TOTAL_CHARS, MAX_BODY_CHARS } from '@cat-factory/orchestration'

// The mothership-mode telemetry READ-THROUGH endpoint (`POST /internal/telemetry/read`, PR 5's
// last piece): a machine-authed mothership-mode node serving a run whose LOCAL telemetry it has
// none of — pruned, or driven by another node entirely — from the mothership's copy.
//
// Verify the machine-token audience pin (missing / wrong-audience / wrong-secret, checked before
// anything else), the workspace → account scope binding (uniform 404, no existence leak), the
// property carrying the security weight — the scope-bound workspace is STAMPED as the call's
// first argument, so a node cannot read a workspace it did not address — the closed method table
// (unknown pairs and prototype members refused), the declared bounds (refused, never clamped),
// the byte backstop, the 503 on a facade that is not a mothership, and the client round-trip.

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
    ...overrides,
  }
}

/** Every call the fake registry received, so a test can assert what the controller passed on. */
interface Seen {
  calls: { repo: string; method: string; args: unknown[] }[]
}

function makeApp(
  opts: {
    repositories?: boolean
    throws?: boolean
    /** Override what `llmCallMetricRepository.listRunPage` answers. */
    runPage?: LlmCallMetric[]
    /** Drop a method from the registry, to exercise the "table names it, facade doesn't" 503. */
    without?: string
  } = {},
) {
  const seen: Seen = { calls: [] }
  const record = (repo: string, method: string, args: unknown[]) => {
    seen.calls.push({ repo, method, args })
  }
  const metricRepo: Record<string, unknown> = {
    listRunPage: async (...args: unknown[]) => {
      record('llmCallMetricRepository', 'listRunPage', args)
      if (opts.throws) throw new Error('telemetry db down')
      return opts.runPage ?? [metric({ id: 'm1' })]
    },
    listPage: async (...args: unknown[]) => {
      record('llmCallMetricRepository', 'listPage', args)
      return []
    },
    get: async (...args: unknown[]) => {
      record('llmCallMetricRepository', 'get', args)
      return null
    },
    summarizeByExecution: async (...args: unknown[]) => {
      record('llmCallMetricRepository', 'summarizeByExecution', args)
      return []
    },
  }
  if (opts.without) delete metricRepo[opts.without]
  const container = {
    repositories:
      opts.repositories === false
        ? undefined
        : {
            workspaceRepository: {
              accountOf: async (id: string) => ACCOUNT_BY_WORKSPACE[id] ?? null,
            },
            llmCallMetricRepository: metricRepo,
            agentContextSnapshotRepository: {
              countByExecution: async (...args: unknown[]) => {
                record('agentContextSnapshotRepository', 'countByExecution', args)
                return 3
              },
            },
            agentSearchQueryRepository: {
              listPage: async (...args: unknown[]) => {
                record('agentSearchQueryRepository', 'listPage', args)
                return []
              },
            },
          },
    config: { auth: { sessionSecret: SECRET } },
  } as unknown as ServerContainer
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/', telemetryReadController())
  app.onError(handleError)
  return { app, seen }
}

async function machineToken(accountIds = [ACCOUNT]) {
  return (await mintMachineToken(SECRET, { userId: 'usr_1', accountIds })).token
}

function read(app: Hono<AppEnv>, token: string | undefined, body: unknown) {
  return app.fetch(
    new Request('http://x/internal/telemetry/read', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
}

const RUN_PAGE = {
  workspaceId: 'ws_1',
  repo: 'llmCallMetricRepository',
  method: 'listRunPage',
  args: [{ executionId: 'exe_1', limit: 50 }],
}

describe('POST /internal/telemetry/read', () => {
  it('serves an in-scope bounded read and returns the rows verbatim', async () => {
    const { app, seen } = makeApp()
    const res = await read(app, await machineToken(), RUN_PAGE)
    expect(res.status).toBe(200)
    expect((await res.json()) as unknown).toEqual({ ok: true, value: [metric({ id: 'm1' })] })
    expect(seen.calls).toHaveLength(1)
  })

  it('STAMPS the scope-bound workspace as the call’s first argument', async () => {
    // The property carrying the security weight. `args` is everything AFTER the workspace, so a
    // node has no way to name one — the id the controller resolved and scope-checked is the id
    // the repository is called with. Without it a node could pass a foreign workspace positionally
    // while addressing an in-scope one in the envelope, and read another tenant's prompts.
    const { app, seen } = makeApp()
    const res = await read(app, await machineToken(), {
      ...RUN_PAGE,
      // A node trying exactly that: an in-scope envelope, a foreign id smuggled into args.
      args: ['ws_other', { executionId: 'exe_1', limit: 50 }],
    })
    // Refused on the SHAPE check — the smuggled positional pushed the query out of arg 0 and past
    // the method's declared arity — but the point is that the call never reaches the repository
    // with a foreign workspace whichever check catches it first.
    expect(res.status).toBe(422)
    expect(seen.calls).toHaveLength(0)

    const ok = await read(app, await machineToken(), RUN_PAGE)
    expect(ok.status).toBe(200)
    expect(seen.calls[0]!.args[0]).toBe('ws_1')
  })

  it('refuses a missing, wrong-audience or wrong-secret token with 403 before any other check', async () => {
    const { app, seen } = makeApp()
    expect((await read(app, undefined, RUN_PAGE)).status).toBe(403)

    // A valid SESSION token is not a machine token — the audience pin is what separates them.
    const session = await new HmacSigner(SECRET).sign({
      userId: 'usr_1',
      aud: TOKEN_AUDIENCE.session,
      exp: Date.now() + 60_000,
    })
    expect((await read(app, session, RUN_PAGE)).status).toBe(403)

    const foreign = (
      await mintMachineToken('another-secret-0123456789', {
        userId: 'usr_1',
        accountIds: [ACCOUNT],
      })
    ).token
    expect((await read(app, foreign, RUN_PAGE)).status).toBe(403)
    // Nothing was read on any of the three.
    expect(seen.calls).toHaveLength(0)
  })

  it('refuses an out-of-scope or unknown workspace with the SAME 404', async () => {
    // Uniform, so a node cannot use the endpoint to learn which workspace ids exist.
    const { app, seen } = makeApp()
    const token = await machineToken()
    expect((await read(app, token, { ...RUN_PAGE, workspaceId: 'ws_other' })).status).toBe(404)
    expect((await read(app, token, { ...RUN_PAGE, workspaceId: 'ws_nope' })).status).toBe(404)
    expect(seen.calls).toHaveLength(0)
    // A token scoped to the OTHER account reads it fine — the refusal is the scope, not the row.
    expect(
      (
        await read(app, await machineToken([OTHER_ACCOUNT]), {
          ...RUN_PAGE,
          workspaceId: 'ws_other',
        })
      ).status,
    ).toBe(200)
  })

  it('serves only the closed method table, including against prototype members', async () => {
    const { app, seen } = makeApp()
    const token = await machineToken()
    // A read method that exists on the repository but is NOT in the table: `latestChainTip` is
    // the capture hot path and has no business being remotely callable.
    expect(
      (await read(app, token, { ...RUN_PAGE, method: 'latestChainTip', args: ['exe_1', 'coder'] }))
        .status,
    ).toBe(422)
    // `listByExecution` is deliberately absent: it takes no cursor, so it is the un-resumable
    // bulk read the bucket forbids.
    expect(TELEMETRY_READ_METHODS.llmCallMetricRepository).not.toHaveProperty('listByExecution')
    expect(
      (await read(app, token, { ...RUN_PAGE, method: 'listByExecution', args: ['exe_1'] })).status,
    ).toBe(422)
    // A repository outside the table entirely.
    expect(
      (await read(app, token, { ...RUN_PAGE, repo: 'blockRepository', method: 'get', args: ['b'] }))
        .status,
    ).toBe(422)
    // Own-property lookup: an inherited member names nothing on either level.
    expect((await read(app, token, { ...RUN_PAGE, repo: '__proto__' })).status).toBe(422)
    expect((await read(app, token, { ...RUN_PAGE, method: 'constructor', args: [] })).status).toBe(
      422,
    )
    expect(seen.calls).toHaveLength(0)
  })

  it('refuses an over-cap or unstated limit rather than clamping it', async () => {
    // Refused, never clamped: a node that asked for 500 rows and silently got 100 would take its
    // next cursor from a page it believes was complete, losing everything in between.
    const { app, seen } = makeApp()
    const token = await machineToken()
    const over = await read(app, token, {
      ...RUN_PAGE,
      args: [{ executionId: 'exe_1', limit: 5000 }],
    })
    expect(over.status).toBe(413)
    // An unstated limit computes no size at all, so it is refused too rather than defaulted.
    expect((await read(app, token, { ...RUN_PAGE, args: [{ executionId: 'exe_1' }] })).status).toBe(
      413,
    )
    // The snapshot page's cap is much smaller — one row is routinely megabytes.
    expect(TELEMETRY_READ_METHODS.agentContextSnapshotRepository.listRunPage.maxLimit).toBe(3)
    // And the drain asks for one at a time, since there is no batching win in a sink whose rows
    // are megabytes apiece.
    expect(TELEMETRY_READ_PAGE_SIZES.snapshots).toBe(1)
    expect(seen.calls).toHaveLength(0)
    // A read with no row cap to check (an aggregate, a count) needs no limit.
    expect(
      (
        await read(app, token, {
          ...RUN_PAGE,
          method: 'summarizeByExecution',
          args: ['exe_1'],
        })
      ).status,
    ).toBe(200)
  })

  it('refuses an over-budget body slice on the reads that take one', async () => {
    const { app } = makeApp()
    const token = await machineToken()
    expect(
      (
        await read(app, token, {
          ...RUN_PAGE,
          method: 'listPage',
          args: [{ executionId: 'exe_1', limit: 10, bodyChars: 50_000_000 }],
        })
      ).status,
    ).toBe(413)
    // The point read carries its window as the SECOND positional after the stamped workspace.
    expect(
      (
        await read(app, token, {
          ...RUN_PAGE,
          method: 'get',
          args: ['call_1', { chars: 50_000_000 }],
        })
      ).status,
    ).toBe(413)
    // Within budget it goes through.
    expect(
      (
        await read(app, token, {
          ...RUN_PAGE,
          method: 'get',
          args: ['call_1', { chars: 4_000 }],
        })
      ).status,
    ).toBe(200)
    // REQUIRED, not merely capped: an omitted window means "the whole bodies" to the port, which
    // is the unstated size this surface exists to refuse — the same reason an unstated `limit` is.
    // The read-through fills in the declared ceiling rather than sending nothing.
    expect((await read(app, token, { ...RUN_PAGE, method: 'get', args: ['call_1'] })).status).toBe(
      413,
    )
  })

  it('refuses a malformed query as a CALLER error rather than letting it fault the store', async () => {
    // Without a shape check these reach the repository and surface as a 500 — `execution_id =
    // undefined` reads as a store fault, when it is the caller that is wrong. Every read on the
    // table is run-scoped, which is what makes each one's size knowable in the first place.
    const { app, seen } = makeApp()
    const token = await machineToken()
    for (const args of [
      [{ limit: 10 }], // no run named
      [{ executionId: '', limit: 10 }], // empty is not a run either
      [{ executionId: 42, limit: 10 }],
      ['exe_1'], // a page's argument is a query object, not an id
      [[{ executionId: 'exe_1', limit: 10 }]],
    ]) {
      expect((await read(app, token, { ...RUN_PAGE, args })).status).toBe(422)
    }
    // The id-shaped reads are held to their own shape.
    expect(
      (await read(app, token, { ...RUN_PAGE, method: 'summarizeByExecution', args: [{}] })).status,
    ).toBe(422)
    // Arity is part of the shape: the args are SPREAD into the call, so a caller may not slip a
    // positional past the ones its method declares.
    expect(
      (
        await read(app, token, {
          ...RUN_PAGE,
          method: 'summarizeByExecution',
          args: ['exe_1', { sneak: true }],
        })
      ).status,
    ).toBe(422)
    expect(seen.calls).toHaveLength(0)
  })

  it('refuses a response over the byte backstop under its OWN code, so the drain can retry smaller', async () => {
    // The row caps bound COUNT; this bounds the axis one pathological row moves. A shortened page
    // would be one the node treats as complete — so it is refused, and refused under a code the
    // client can act on. The two 413s are NOT interchangeable: an over-cap `limit` is an ask the
    // caller may not make (retrying would only fail more slowly), while an over-large RESPONSE is
    // a legal ask the same cursor satisfies in smaller pages.
    const huge = metric({ id: 'm_huge', promptText: 'x'.repeat(MAX_TELEMETRY_READ_CHARS + 1_000) })
    const { app } = makeApp({ runPage: [huge] })
    const res = await read(app, await machineToken(), RUN_PAGE)
    expect(res.status).toBe(413)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: TELEMETRY_READ_TOO_LARGE_CODE },
    })
  })

  it('sizes the byte backstop above the largest single row either sink can capture', async () => {
    // The inequality that makes the drain's halving TERMINATE, stated once here so raising a
    // capture ceiling fails a test rather than a developer's panel.
    //
    // It is not decorative. The backstop shipped as a picked 8,000,000, which is NARROWER than one
    // maximal snapshot worst-case escaped (4 MiB x 2 = 8,388,608): a run with large injected
    // context files would have had every page refused, down to a page of one, and the drain — which
    // treated a refusal as fatal — would have failed that run's panel permanently. Deriving the
    // bound from the capture ceilings is what removes that class of run.
    expect(MAX_TELEMETRY_READ_ROW_CHARS).toBeGreaterThanOrEqual(MAX_AGENT_CONTEXT_TOTAL_CHARS)
    expect(MAX_TELEMETRY_READ_ROW_CHARS).toBeGreaterThanOrEqual(MAX_BODY_CHARS * 3)
    expect(MAX_TELEMETRY_READ_CHARS).toBeGreaterThan(MAX_TELEMETRY_READ_ROW_CHARS)
  })

  it('gives each read a round-trip budget matched to what it moves', async () => {
    // Not one global timeout: the `(agentKind, phase)` aggregate is folded onto every step
    // settlement by `RunStateMachine.attachStepMetrics`, which AWAITS it on the emit path — so an
    // unreachable mothership must cost that emit seconds, not the half-minute a megabyte-scale
    // snapshot page is rightly allowed.
    const { llmCallMetricRepository: m, agentContextSnapshotRepository: s } = TELEMETRY_READ_METHODS
    expect(m.summarizeByExecution.timeoutMs).toBeLessThanOrEqual(5_000)
    expect(s.countByExecution.timeoutMs).toBeLessThanOrEqual(5_000)
    expect(s.listRunPage.timeoutMs).toBeGreaterThan(m.summarizeByExecution.timeoutMs)
  })

  it('answers 503 on a facade that is not a mothership, and on an unwired method', async () => {
    const notMothership = makeApp({ repositories: false })
    expect((await read(notMothership.app, await machineToken(), RUN_PAGE)).status).toBe(503)
    // The table names it but this mothership's registry doesn't serve it — a wiring gap, reported
    // as one rather than as the caller error `unknown_method` would suggest.
    const partial = makeApp({ without: 'listRunPage' })
    expect((await read(partial.app, await machineToken(), RUN_PAGE)).status).toBe(503)
  })

  it('answers 500 when the store fails, never an empty result', async () => {
    // An empty result would render to the reader as "this run captured nothing" — the exact false
    // zero the read-through exists to remove.
    const { app } = makeApp({ throws: true })
    const res = await read(app, await machineToken(), RUN_PAGE)
    expect(res.status).toBe(500)
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: false })
  })

  it('rejects a malformed body with 422 rather than reading anything', async () => {
    const { app, seen } = makeApp()
    const token = await machineToken()
    expect((await read(app, token, { workspaceId: 'ws_1', repo: 'x' })).status).toBe(422)
    expect((await read(app, token, { ...RUN_PAGE, args: 'not-an-array' as unknown })).status).toBe(
      422,
    )
    expect(seen.calls).toHaveLength(0)
  })
})

describe('HttpMachineTelemetryReadClient', () => {
  it('posts the request with the node’s machine token and returns the value', async () => {
    const seen: { url: string; body: unknown; auth: string | null }[] = []
    const client = new HttpMachineTelemetryReadClient({
      baseUrl: 'https://m.test/',
      token: 'tok_1',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({
          url,
          body: JSON.parse(String(init.body)) as unknown,
          auth: new Headers(init.headers).get('authorization'),
        })
        return new Response(JSON.stringify({ ok: true, value: [{ id: 'm1' }] }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    const value = await client.read({
      workspaceId: 'ws_1',
      repo: 'llmCallMetricRepository',
      method: 'listRunPage',
      args: [{ executionId: 'exe_1', limit: 50 }],
    })
    expect(value).toEqual([{ id: 'm1' }])
    // The trailing slash on the base URL is normalised away, so the node never posts to `//`.
    expect(seen[0]!.url).toBe('https://m.test/internal/telemetry/read')
    expect(seen[0]!.auth).toBe('Bearer tok_1')
  })

  it('THROWS on a refusal, an HTTP failure and a missing token — never an empty result', async () => {
    // The contract the whole feature rests on: the caller fell back here because its local store
    // was empty, so resolving empty would restate the defect being fixed.
    const refusing = new HttpMachineTelemetryReadClient({
      baseUrl: 'https://m.test',
      token: 'tok_1',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ ok: false, error: { code: 'not_found', message: 'Not found' } }),
          {
            status: 404,
          },
        )) as unknown as typeof fetch,
    })
    await expect(
      refusing.read({
        workspaceId: 'ws_1',
        repo: 'llmCallMetricRepository',
        method: 'get',
        args: [],
      }),
    ).rejects.toThrow(/not_found/)

    const broken = new HttpMachineTelemetryReadClient({
      baseUrl: 'https://m.test',
      token: 'tok_1',
      fetchImpl: (async () =>
        new Response('<html>bad gateway', { status: 502 })) as unknown as typeof fetch,
    })
    await expect(
      broken.read({
        workspaceId: 'ws_1',
        repo: 'llmCallMetricRepository',
        method: 'get',
        args: [],
      }),
    ).rejects.toThrow(/HTTP 502/)

    // A node that has not completed the mothership login yet: distinct error, same disposition.
    const unconnected = new HttpMachineTelemetryReadClient({
      baseUrl: 'https://m.test',
      token: () => null,
      fetchImpl: (async () => {
        throw new Error('must not be called')
      }) as unknown as typeof fetch,
    })
    await expect(
      unconnected.read({
        workspaceId: 'ws_1',
        repo: 'llmCallMetricRepository',
        method: 'get',
        args: [],
      }),
    ).rejects.toBeInstanceOf(MachineTokenUnavailableForReadError)
  })
})
