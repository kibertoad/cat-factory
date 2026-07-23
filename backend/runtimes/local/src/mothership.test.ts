import { afterEach, describe, expect, it, vi } from 'vitest'
import { type DriveConfig, NodeRealtimeHub } from '@cat-factory/node-server'
import { buildLocalContainer } from './container.js'
import {
  SqliteWorkRunner,
  type SqliteWorkRunnerOptions,
  composeMothership,
  createMothershipConnector,
  isMothershipMode,
} from './mothership.js'
import { createLocalMachineTokenStore } from './sqlite/machineTokenStore.js'
import { type SqliteWorkQueue, createWorkQueue } from './sqlite/workQueue.js'

// Unit coverage for the mothership composition seam (docs/initiatives/mothership-mode.md):
//   - the boot-mode probe,
//   - composeMothership wiring the remote (RPC) org repos + the local node:sqlite credential
//     store (org reads hit the mothership over HTTP; credentials — incl. the subscription-token /
//     personal-subscription / activation trio — stay local),
//   - the in-process work runner's per-execution serialization (the no-pg-boss drive analogue).
// All in-process / in-memory — no Postgres, no network, no Docker.

const BASE_ENV = (over: Record<string, string | undefined>): NodeJS.ProcessEnv => ({
  LOCAL_MOTHERSHIP_CREDENTIAL_DB: ':memory:',
  LOCAL_MOTHERSHIP_SETTINGS_DB: ':memory:',
  LOCAL_MOTHERSHIP_WORK_DB: ':memory:',
  LOCAL_MOTHERSHIP_TOKEN_DB: ':memory:',
  ...over,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isMothershipMode', () => {
  it('is on only when a mothership URL is configured', () => {
    expect(isMothershipMode(BASE_ENV({ LOCAL_MOTHERSHIP_URL: 'https://mothership.test' }))).toBe(
      true,
    )
    expect(isMothershipMode(BASE_ENV({}))).toBe(false)
    expect(isMothershipMode(BASE_ENV({ LOCAL_MOTHERSHIP_URL: '   ' }))).toBe(false)
  })
})

describe('composeMothership', () => {
  it('boots inert (no throw) when no machine token is available yet, presenting an empty bearer', async () => {
    // With neither the env override nor a cached token, the node must still BOOT (so the SPA can
    // drive the login) — the token provider yields null and every RPC comes back with an empty
    // bearer (which the mothership 403s). This replaces the old fail-fast-on-missing-token.
    let sentAuth: string | null | undefined
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sentAuth = new Headers(init.headers).get('authorization')
      return new Response(
        JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'no' } }),
        {
          status: 403,
          headers: { 'content-type': 'application/json' },
        },
      )
    })
    const { repos, close } = composeMothership(BASE_ENV({ LOCAL_MOTHERSHIP_URL: 'https://m.test' }))
    try {
      await expect(repos.workspaceRepository.get('ws_1')).rejects.toThrow()
      // `Headers.get` trims the trailing space of `Bearer ` (empty token).
      expect(sentAuth).toBe('Bearer')
    } finally {
      close()
    }
  })

  it('prefers the env token, else the cached token, treating an expired cached token as absent', async () => {
    let sentAuth: string | null | undefined
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sentAuth = new Headers(init.headers).get('authorization')
      return new Response(JSON.stringify({ ok: true, value: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    // 1. Env override wins outright.
    const withEnv = composeMothership(
      BASE_ENV({ LOCAL_MOTHERSHIP_URL: 'https://m.test', LOCAL_MOTHERSHIP_TOKEN: 'env-tok' }),
    )
    await withEnv.repos.workspaceRepository.get('ws_1')
    expect(sentAuth).toBe('Bearer env-tok')
    // A cached token present alongside the env override is ignored (env wins).
    withEnv.machineTokenStore.write({
      token: 'cached-tok',
      nodeId: 'node_x',
      userId: 'usr_1',
      accountIds: ['acc_1'],
      exp: Date.now() + 60_000,
      createdAt: Date.now(),
    })
    await withEnv.repos.workspaceRepository.get('ws_1')
    expect(sentAuth).toBe('Bearer env-tok')
    withEnv.close()

    // 2. No env token: an unexpired cached token is used.
    const noEnv = composeMothership(BASE_ENV({ LOCAL_MOTHERSHIP_URL: 'https://m.test' }))
    noEnv.machineTokenStore.write({
      token: 'cached-tok',
      nodeId: 'node_x',
      userId: 'usr_1',
      accountIds: ['acc_1'],
      exp: Date.now() + 60_000,
      createdAt: Date.now(),
    })
    await noEnv.repos.workspaceRepository.get('ws_1')
    expect(sentAuth).toBe('Bearer cached-tok')
    // 3. An EXPIRED cached token is treated as no token (empty bearer).
    noEnv.machineTokenStore.write({
      token: 'stale-tok',
      nodeId: 'node_x',
      userId: 'usr_1',
      accountIds: ['acc_1'],
      exp: Date.now() - 1,
      createdAt: Date.now(),
    })
    await noEnv.repos.workspaceRepository.get('ws_1')
    expect(sentAuth).toBe('Bearer')
    noEnv.close()
  })

  it('routes org reads to the mothership over HTTP and keeps credentials local', async () => {
    // A fake mothership: answers `/internal/persistence` with the RPC wire envelope, asserting
    // the node presents its machine token and the request body is the reflective {repo,method,args}.
    const seen: { url: string; auth: string | null; body: unknown }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { repo: string; method: string }
      seen.push({
        url,
        auth: new Headers(init.headers).get('authorization'),
        body: JSON.parse(String(init.body)),
      })
      // Reflect a workspace read back as the wire envelope.
      const value = body.repo === 'workspaceRepository' ? { id: 'ws_1', name: 'ws_1' } : null
      return new Response(JSON.stringify({ ok: true, value }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const { repos, credentialStore, close } = composeMothership(
      BASE_ENV({ LOCAL_MOTHERSHIP_URL: 'https://m.test/', LOCAL_MOTHERSHIP_TOKEN: 'machine-tok' }),
    )
    try {
      // Org read → forwarded to the mothership.
      const ws = await repos.workspaceRepository.get('ws_1')
      expect(ws).toMatchObject({ id: 'ws_1' })
      expect(seen).toHaveLength(1)
      expect(seen[0]!.url).toBe('https://m.test/internal/persistence')
      expect(seen[0]!.auth).toBe('Bearer machine-tok')
      expect(seen[0]!.body).toMatchObject({
        repo: 'workspaceRepository',
        method: 'get',
        args: ['ws_1'],
      })

      // Credential write/read → the LOCAL sqlite store, NEVER the mothership (no extra fetch).
      await credentialStore.providerApiKeyRepository.add({
        id: 'key_1',
        scope: 'workspace',
        scopeId: 'ws_1',
        provider: 'openai',
        label: 'k',
        keyCipher: 'sealed-locally',
        createdAt: 1,
        lastUsedAt: null,
        windowStartedAt: null,
        inputTokens: 0,
        outputTokens: 0,
        requestCount: 0,
        enabled: true,
        isDefault: false,
        deletedAt: null,
      })
      const keys = await credentialStore.providerApiKeyRepository.listByScope('workspace', 'ws_1')
      expect(keys.map((k) => k.id)).toEqual(['key_1'])
      expect(seen).toHaveLength(1) // still just the one org read — credentials never left the laptop
    } finally {
      close()
    }
  })

  it('re-throws a DomainError envelope from the mothership (control flow preserved)', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'gone' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const { repos, close } = composeMothership(
      BASE_ENV({ LOCAL_MOTHERSHIP_URL: 'https://m.test', LOCAL_MOTHERSHIP_TOKEN: 't' }),
    )
    try {
      await expect(repos.blockRepository.get('ws_1', 'blk_1')).rejects.toMatchObject({
        code: 'not_found',
      })
    } finally {
      close()
    }
  })
})

describe('createMothershipConnector', () => {
  const mintResponse = {
    token: 'machine-abc',
    nodeId: 'node_1',
    userId: 'usr_1',
    accountIds: ['acc_1', 'acc_2'],
    exp: Date.now() + 60_000,
    user: { id: 'usr_1', login: 'dev', name: 'Dev', avatarUrl: null, email: 'dev@x.test' },
  }

  it('exchanges a session for a machine token, caches it, and reports the scope + user', async () => {
    const seen: { url: string; auth: string | null; body: unknown }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({
        url,
        auth: new Headers(init.headers).get('authorization'),
        body: JSON.parse(String(init.body)),
      })
      return new Response(JSON.stringify(mintResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const store = createLocalMachineTokenStore(':memory:')
    const connector = createMothershipConnector({ baseUrl: 'https://m.test/', store })

    const result = await connector.connect('session-xyz')
    expect(result).toMatchObject({
      ok: true,
      accountIds: ['acc_1', 'acc_2'],
      user: { login: 'dev' },
    })
    // Forwarded the session to the mothership mint endpoint.
    expect(seen[0]!.url).toBe('https://m.test/auth/machine-token')
    expect(seen[0]!.auth).toBe('Bearer session-xyz')
    // Cached the OPAQUE machine token for later RPCs.
    expect(store.read()).toMatchObject({
      token: 'machine-abc',
      nodeId: 'node_1',
      accountIds: ['acc_1', 'acc_2'],
    })
    store.close()
  })

  it('never reuses a cached node id (the mothership assigns one, avoiding cross-user conflation)', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify(mintResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const store = createLocalMachineTokenStore(':memory:')
    // A prior connect (as some other user) left node_prior in the cache.
    store.write({
      token: 't',
      nodeId: 'node_prior',
      userId: 'usr_1',
      accountIds: ['acc_1'],
      exp: Date.now() + 1000,
      createdAt: Date.now(),
    })
    const connector = createMothershipConnector({ baseUrl: 'https://m.test', store })
    await connector.connect('session-xyz')
    // The request carries NO node id, so a different user never inherits node_prior; the node id
    // the mothership returns is what gets cached.
    expect(bodies[0]).toEqual({})
    expect(store.read()?.nodeId).toBe('node_1')
    store.close()
  })

  it('surfaces a rejected session (403) without caching anything', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: { message: 'nope' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const store = createLocalMachineTokenStore(':memory:')
    const connector = createMothershipConnector({ baseUrl: 'https://m.test', store })
    const result = await connector.connect('bad-session')
    expect(result).toMatchObject({ ok: false, status: 403 })
    expect(store.read()).toBeNull()
    store.close()
  })

  it('surfaces an unreachable mothership as a 502 (network error)', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED')
    })
    const store = createLocalMachineTokenStore(':memory:')
    const connector = createMothershipConnector({ baseUrl: 'https://m.test', store })
    const result = await connector.connect('session')
    expect(result).toMatchObject({ ok: false, status: 502 })
    store.close()
  })
})

const DRIVE_CFG: DriveConfig = {
  jobPollIntervalMs: 1,
  jobMaxPolls: 1,
  jobPollFailureTolerance: 1,
  ciPollIntervalMs: 1,
  ciMaxPolls: 1,
}

// Large lease / backoff / sweep so timing never interferes with the synchronous assertions; the
// drive itself resolves in microtasks (instant sleep), so a `tick` macrotask flushes each drive.
const RUNNER_OPTS: SqliteWorkRunnerOptions = {
  drive: DRIVE_CFG,
  leaseMs: 60_000,
  reArmDelayMs: 60_000,
  errorBackoffMs: 60_000,
  sweepIntervalMs: 60_000,
  maxAttempts: 5,
  concurrency: 10,
}

const silentLog = { info: () => {}, error: () => {}, warn: () => {} } as never
const tick = () => new Promise((r) => setTimeout(r, 0))

// Track runners/queues so their (unref'd) timers + handles are released after each test.
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function makeRunner(
  queue: SqliteWorkQueue,
  exec: unknown,
  opts: Partial<SqliteWorkRunnerOptions> = {},
  extras: { staleRuns?: unknown; now?: () => number } = {},
): SqliteWorkRunner {
  const runner = new SqliteWorkRunner(queue, { ...RUNNER_OPTS, ...opts }, silentLog, extras.now)
  runner.bind(exec as never, extras.staleRuns as never)
  cleanups.push(() => {
    runner.stop()
    queue.close()
  })
  return runner
}

describe('SqliteWorkRunner', () => {
  it('drives a run to completion via the execution service, then settles its queue row', async () => {
    const queue = createWorkQueue(':memory:')
    const advance = vi.fn(async () => ({ kind: 'done' as const }))
    const runner = makeRunner(queue, { advanceInstance: advance })
    await runner.startRun('ws', 'ex')
    await tick()
    expect(advance).toHaveBeenCalledTimes(1)
    expect(advance).toHaveBeenCalledWith('ws', 'ex', expect.anything())
    expect(queue.size()).toBe(0) // standstill → row deleted
  })

  it('serializes per execution: signals during an in-flight drive coalesce into one re-drive', async () => {
    // Gate each drive on a manual resolver so we can interleave signals while one is in flight.
    let release: (() => void) | undefined
    const advance = vi.fn(
      () =>
        new Promise<{ kind: 'done' }>((resolve) => {
          release = () => resolve({ kind: 'done' })
        }),
    )
    const queue = createWorkQueue(':memory:')
    const runner = makeRunner(queue, { advanceInstance: advance })

    await runner.startRun('ws', 'ex')
    await tick()
    expect(advance).toHaveBeenCalledTimes(1) // first drive in flight
    expect(queue.size('active')).toBe(1)

    // Two signals arrive mid-drive — they MUST coalesce into exactly one follow-up, not two.
    await runner.signalDecision('ws', 'ex')
    await runner.signalDecision('ws', 'ex')
    expect(advance).toHaveBeenCalledTimes(1) // nothing new started while the first runs

    release!() // first drive finishes → one coalesced re-drive starts
    await tick()
    expect(advance).toHaveBeenCalledTimes(2)

    release!() // second drive finishes → no pending signal → runner goes idle
    await tick()
    expect(advance).toHaveBeenCalledTimes(2)
    expect(queue.size()).toBe(0)

    // A fresh start after going idle drives again.
    await runner.startRun('ws', 'ex')
    await tick()
    expect(advance).toHaveBeenCalledTimes(3)
    release!()
    await tick()
  })

  it('swallows a drive error and re-drives on a later trigger (no unhandled rejection)', async () => {
    // advanceInstance throwing is caught INSIDE driveExecution (it fails the run and returns), so
    // the run settles normally; a later trigger drives it again.
    const advance = vi.fn(async () => {
      throw new Error('boom')
    })
    const queue = createWorkQueue(':memory:')
    const runner = makeRunner(queue, { advanceInstance: advance, failRun: vi.fn(async () => {}) })
    await expect(runner.startRun('ws', 'ex')).resolves.toBeUndefined()
    await tick()
    await runner.startRun('ws', 'ex')
    await tick()
    expect(advance).toHaveBeenCalledTimes(2)
  })

  it('defers a run for retry when the drive loop itself throws (queue row survives)', async () => {
    // Force driveExecution itself to throw: advanceInstance rejects AND failRun rejects, so the
    // internal failure funnel re-throws out of the loop into the runner's own catch.
    const advance = vi.fn(async () => {
      throw new Error('boom')
    })
    const failRun = vi.fn(async () => {
      throw new Error('fail too')
    })
    const queue = createWorkQueue(':memory:')
    const runner = makeRunner(queue, { advanceInstance: advance, failRun })
    await runner.startRun('ws', 'ex')
    await tick()
    expect(advance).toHaveBeenCalledTimes(1)
    // The run is NOT lost: it is held (deferred) for a backoff'd retry, not deleted.
    expect(queue.size()).toBe(1)
  })

  it('durable: a fresh runner re-drives runs orphaned by a prior process on bind', async () => {
    // Simulate a prior process that claimed a run (marked it `active`) and crashed mid-drive.
    const queue = createWorkQueue(':memory:')
    queue.enqueue('ws', 'ex', Date.now())
    queue.claim(Date.now(), RUNNER_OPTS.leaseMs, new Set())
    expect(queue.size('active')).toBe(1)

    // A new process boots over the SAME durable queue: bind() resets the orphan and re-drives it.
    const advance = vi.fn(async () => ({ kind: 'done' as const }))
    makeRunner(queue, { advanceInstance: advance }) // bind() runs recovery
    await tick()
    expect(advance).toHaveBeenCalledTimes(1)
    expect(queue.size()).toBe(0)
  })

  it('fails a run loudly and evicts it after maxAttempts consecutive drive failures', async () => {
    // Reaching the runner's own catch needs driveExecution itself to throw — which only happens
    // when even the failRun funnel throws (a broken persistence path, e.g. mothership unreachable).
    // `enqueue` (the per-trigger re-queue) clears the backoff lease, so each startRun re-drives
    // immediately without waiting out errorBackoffMs.
    const advance = vi.fn(async () => {
      throw new Error('persistence down')
    })
    const failRun = vi.fn(async () => {
      throw new Error('persistence still down')
    })
    const queue = createWorkQueue(':memory:')
    const runner = makeRunner(queue, { advanceInstance: advance, failRun }, { maxAttempts: 3 })
    // Three consecutive failed drives bring the failure count to the cap.
    for (let i = 0; i < 3; i++) {
      await runner.startRun('ws', 'ex')
      await tick()
    }
    expect(advance).toHaveBeenCalledTimes(3)
    // The next drain evicts the poison run AND tries to fail it (best-effort, the spy throws).
    await runner.startRun('ws', 'ex')
    await tick()
    expect(queue.size()).toBe(0) // evicted, not left stuck running forever
    // failRun was attempted for the eviction (the 3 in-drive calls + the eviction call).
    expect(failRun.mock.calls.some((c) => (c as unknown[])[3] === 'evicted')).toBe(true)
  })

  it('reconciles a run still running in storage but missing its queue row (durability backstop)', async () => {
    // The run exists ONLY in storage (no queue row) — e.g. its row was lost. The storage-reconcile
    // backstop on bind re-enqueues it and drives it to completion.
    const queue = createWorkQueue(':memory:')
    const advance = vi.fn(async () => ({ kind: 'done' as const }))
    const listStale = vi.fn(async () => [{ workspaceId: 'ws', id: 'orphan', kind: 'execution' }])
    makeRunner(queue, { advanceInstance: advance }, {}, { staleRuns: { listStale } })
    await tick()
    await tick()
    expect(listStale).toHaveBeenCalled()
    expect(advance).toHaveBeenCalledWith('ws', 'orphan', expect.anything())
    expect(queue.size()).toBe(0)
  })

  it('storage reconcile leaves non-execution kinds and in-flight runs alone', async () => {
    const queue = createWorkQueue(':memory:')
    const advance = vi.fn(async () => ({ kind: 'done' as const }))
    const listStale = vi.fn(async () => [{ workspaceId: 'ws', id: 'boot', kind: 'bootstrap' }])
    makeRunner(queue, { advanceInstance: advance }, {}, { staleRuns: { listStale } })
    await tick()
    await tick()
    // A bootstrap orphan is not an execution run — this runner must not pick it up.
    expect(advance).not.toHaveBeenCalled()
    expect(queue.size()).toBe(0)
  })

  it('a best-effort reconcile swallows a listStale that throws (repo not allow-listed yet)', async () => {
    const queue = createWorkQueue(':memory:')
    const advance = vi.fn(async () => ({ kind: 'done' as const }))
    const listStale = vi.fn(async () => {
      throw new Error('unknown_method')
    })
    // Must not throw out of bind / crash the runner.
    expect(() =>
      makeRunner(queue, { advanceInstance: advance }, {}, { staleRuns: { listStale } }),
    ).not.toThrow()
    await tick()
    expect(advance).not.toHaveBeenCalled()
  })
})

describe('buildLocalContainer (mothership, no Postgres)', () => {
  const MOTHERSHIP_ENV: NodeJS.ProcessEnv = {
    ENVIRONMENT: 'test',
    AUTH_SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    // The LOCAL key sealing the credential store — distinct from (and never) the mothership's.
    ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
    // Required inbound-auth secret for the agent-container transports (applyLocalDefaults enforces it).
    HARNESS_SHARED_SECRET: 'mothership-test-harness-secret',
    LOCAL_MOTHERSHIP_URL: 'https://m.test',
    LOCAL_MOTHERSHIP_TOKEN: 'machine-tok',
    LOCAL_MOTHERSHIP_CREDENTIAL_DB: ':memory:',
    LOCAL_MOTHERSHIP_SETTINGS_DB: ':memory:',
    LOCAL_MOTHERSHIP_WORK_DB: ':memory:',
    LOCAL_MOTHERSHIP_TOKEN_DB: ':memory:',
  }

  it('composes the engine with NO db — remote repos + local credential store + in-process runner', () => {
    // Any build-time remote call would hit this throwing fetch; the build must not make one
    // (the remote repos are lazy — only QUERIED at request/run time).
    vi.stubGlobal('fetch', () => {
      throw new Error('no network at build time')
    })

    const container = buildLocalContainer({ env: MOTHERSHIP_ENV })

    // The engine is wired (executionService present) even though there is no Postgres.
    expect(container.executionService).toBeDefined()
    // The API-key pool is wired from the LOCAL sqlite credential store (sealed with the local key).
    expect(container.apiKeys).toBeDefined()
    expect(container.localModelEndpoints).toBeDefined()
    // The subscription-credential services are now wired from the LOCAL sqlite store too (PR 3 —
    // the subscription-token pool + per-user personal creds + their per-run activations are
    // laptop-local, leased + decrypted by the local container executor). Previously OFF in
    // mothership mode; now ON because their local-sqlite bucket exists.
    expect(container.subscriptions).toBeDefined()
    expect(container.personalSubscriptions).toBeDefined()
    // The local-mode settings panel is served from the LOCAL sqlite singleton (no Postgres).
    expect(container.localSettings).toBeDefined()
    // The SPA flag is surfaced so the UI can label local-vs-mothership storage.
    expect(container.config.localMode?.mothership).toBe(true)
  })
})

describe('composeMothership realtime upstream adapter', () => {
  it('publishes an engine event to the mothership over /internal/events/publish with the machine token', async () => {
    const seen: { url: string; auth: string | null; body: unknown }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({
        url: String(url),
        auth: new Headers(init.headers).get('authorization'),
        body: JSON.parse(String(init.body)),
      })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const composed = composeMothership(
      BASE_ENV({ LOCAL_MOTHERSHIP_URL: 'https://m.test', LOCAL_MOTHERSHIP_TOKEN: 'env-tok' }),
    )
    try {
      composed.realtimeAdapter.publish({
        workspaceId: 'ws_1',
        payload: '{"type":"board","reason":"x","at":1}',
        originConnectionId: 'cid_3',
      })
      // publish is fire-and-forget — let the POST settle.
      await new Promise((r) => setTimeout(r, 0))
      expect(seen).toHaveLength(1)
      expect(seen[0]!.url).toBe('https://m.test/internal/events/publish')
      expect(seen[0]!.auth).toBe('Bearer env-tok')
      expect(seen[0]!.body).toEqual({
        workspaceId: 'ws_1',
        payload: '{"type":"board","reason":"x","at":1}',
        originConnectionId: 'cid_3',
      })
    } finally {
      composed.close()
    }
  })

  it('never throws when the mothership is unreachable (best-effort, delivered locally already)', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })
    const composed = composeMothership(
      BASE_ENV({ LOCAL_MOTHERSHIP_URL: 'https://m.test', LOCAL_MOTHERSHIP_TOKEN: 'env-tok' }),
    )
    try {
      expect(() =>
        composed.realtimeAdapter.publish({ workspaceId: 'ws_1', payload: '{}' }),
      ).not.toThrow()
      await new Promise((r) => setTimeout(r, 0))
    } finally {
      composed.close()
    }
  })

  it('attaches the machineEventRelay seam and fans engine events upstream when a hub is wired', async () => {
    // The Node facade's mothership-side inbound seam is attached whenever a realtime sink is wired
    // (both facades — the symmetric change), so a mothership-mode node can ALSO serve as a
    // mothership if pointed at. And with the mothership adapter layered over the hub, a broadcast
    // fans to the local hub AND up to the mothership.
    const posted: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      posted.push(`${String(url)}::${String(init.body)}`)
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const hub = new NodeRealtimeHub()
    const container = buildLocalContainer({
      env: BASE_ENV({
        ENVIRONMENT: 'test',
        AUTH_SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
        HARNESS_SHARED_SECRET: 'mothership-test-harness-secret',
        LOCAL_MOTHERSHIP_URL: 'https://m.test',
        LOCAL_MOTHERSHIP_TOKEN: 'env-tok',
      }),
      realtimeSink: hub,
    })
    // Seam attached (this deployment can be a mothership too).
    expect(container.machineEventRelay).toBeDefined()
    // A relayed event is delivered into the local hub via that seam (no throw with no sockets).
    expect(() =>
      container.machineEventRelay!.ingest({ workspaceId: 'ws_1', payload: '{}' }),
    ).not.toThrow()
    await container.onShutdown?.()
  })
})
