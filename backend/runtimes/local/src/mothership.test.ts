import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriveConfig } from '@cat-factory/node-server'
import { buildLocalContainer } from './container.js'
import { InProcessWorkRunner, composeMothership, isMothershipMode } from './mothership.js'

// Unit coverage for the mothership composition seam (docs/initiatives/mothership-mode.md):
//   - the boot-mode probe,
//   - composeMothership wiring the remote (RPC) org repos + the local node:sqlite credential
//     store (org reads hit the mothership over HTTP; credentials stay local),
//   - the in-process work runner's per-execution serialization (the no-pg-boss drive analogue).
// All in-process / in-memory — no Postgres, no network, no Docker.

const BASE_ENV = (over: Record<string, string | undefined>): NodeJS.ProcessEnv => ({
  LOCAL_MOTHERSHIP_CREDENTIAL_DB: ':memory:',
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
  it('fails fast when the machine token is missing', () => {
    expect(() => composeMothership(BASE_ENV({ LOCAL_MOTHERSHIP_URL: 'https://m.test' }))).toThrow(
      /LOCAL_MOTHERSHIP_TOKEN/,
    )
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

const DRIVE_CFG: DriveConfig = {
  jobPollIntervalMs: 1,
  jobMaxPolls: 1,
  jobPollFailureTolerance: 1,
  ciPollIntervalMs: 1,
  ciMaxPolls: 1,
}

const silentLog = { info: () => {}, error: () => {}, warn: () => {} } as never
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('InProcessWorkRunner', () => {
  it('drives a run to completion via the execution service', async () => {
    const advance = vi.fn(async () => ({ kind: 'done' as const }))
    const runner = new InProcessWorkRunner(DRIVE_CFG, silentLog)
    runner.bind({ advanceInstance: advance } as never)
    await runner.startRun('ws', 'ex')
    await tick()
    expect(advance).toHaveBeenCalledTimes(1)
    expect(advance).toHaveBeenCalledWith('ws', 'ex', expect.anything())
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
    const runner = new InProcessWorkRunner(DRIVE_CFG, silentLog)
    runner.bind({ advanceInstance: advance } as never)

    await runner.startRun('ws', 'ex')
    await tick()
    expect(advance).toHaveBeenCalledTimes(1) // first drive in flight

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

    // A fresh start after going idle drives again.
    await runner.startRun('ws', 'ex')
    await tick()
    expect(advance).toHaveBeenCalledTimes(3)
    release!()
    await tick()
  })

  it('swallows a drive error (logged, never an unhandled rejection)', async () => {
    const advance = vi.fn(async () => {
      throw new Error('boom')
    })
    const runner = new InProcessWorkRunner(DRIVE_CFG, silentLog)
    runner.bind({ advanceInstance: advance, failRun: vi.fn(async () => {}) } as never)
    await expect(runner.startRun('ws', 'ex')).resolves.toBeUndefined()
    await tick()
    // The runner cleared its in-flight slot, so a later start drives again.
    await runner.startRun('ws', 'ex')
    await tick()
    expect(advance).toHaveBeenCalledTimes(2)
  })
})

describe('buildLocalContainer (mothership, no Postgres)', () => {
  const MOTHERSHIP_ENV: NodeJS.ProcessEnv = {
    ENVIRONMENT: 'test',
    AUTH_SESSION_SECRET: 'test-session-secret',
    // The LOCAL key sealing the credential store — distinct from (and never) the mothership's.
    ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
    LOCAL_MOTHERSHIP_URL: 'https://m.test',
    LOCAL_MOTHERSHIP_TOKEN: 'machine-tok',
    LOCAL_MOTHERSHIP_CREDENTIAL_DB: ':memory:',
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
    // The per-user Postgres-only services are OFF in mothership mode (no db; PR 3 makes them local).
    expect(container.subscriptions).toBeUndefined()
    expect(container.personalSubscriptions).toBeUndefined()
    // The SPA flag is surfaced so the UI can label local-vs-mothership storage.
    expect(container.config.localMode?.mothership).toBe(true)
  })
})
