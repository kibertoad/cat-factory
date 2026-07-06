import type {
  PreflightRef,
  PreflightResult,
  SharedStack,
  SharedStackRepository,
  Workspace,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { ConflictError } from '@cat-factory/kernel'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComposeExecResult, ComposeRuntime } from '../compose/compose-environment.logic.js'
import { SharedStackService } from './SharedStackService.js'

// In-memory shared-stack repository + a workspace-guard stub + a scriptable fake ComposeRuntime,
// so the lifecycle (create → ensureUp → idempotent no-op / concurrent-coalesce → teardown → the
// failure-surfacing + host-command gate + delete-guard) is fully unit-testable with no daemon.

const WS = 'ws-1'

function makeRepo(): SharedStackRepository {
  const rows = new Map<string, SharedStack>()
  const key = (ws: string, id: string) => `${ws}:${id}`
  return {
    async get(ws, id) {
      return rows.get(key(ws, id)) ?? null
    },
    async list(ws) {
      return [...rows.values()]
        .filter((s) => s.workspaceId === ws)
        .sort((a, b) => a.createdAt - b.createdAt)
    },
    async upsert(ws, stack) {
      rows.set(key(ws, stack.id), stack)
    },
    async remove(ws, id) {
      rows.delete(key(ws, id))
    },
  }
}

const workspaceRepository = {
  async get(id: string) {
    return { id, name: 'WS' } as unknown as Workspace
  },
} as unknown as WorkspaceRepository

const ok: ComposeExecResult = { code: 0, stdout: '', stderr: '' }

/** A fake ComposeRuntime that records compose argv + checkout targets and returns scripted results. */
function makeRuntime(overrides: Partial<ComposeRuntime> = {}) {
  const calls: string[][] = []
  const networks: string[] = []
  const checkouts: { cloneUrl: string; ref: string; token?: string }[] = []
  const runtime: ComposeRuntime = {
    async compose(args) {
      calls.push(args)
      // A `compose-healthy` gate polls `ps -a --format json`; a healthy running service ⇒ ready.
      if (args.includes('ps')) return { code: 0, stdout: '[{"State":"running"}]', stderr: '' }
      return ok
    },
    async writeProjectFile() {
      return '/scratch/file'
    },
    async checkout(_project, target) {
      checkouts.push(target)
      return { dir: '/scratch/checkout' }
    },
    async copyCheckoutFile() {},
    async ensureNetwork(name) {
      networks.push(name)
      return ok
    },
    ...overrides,
  }
  return { runtime, calls, networks, checkouts }
}

function makeService(
  repo: SharedStackRepository,
  runtime?: ComposeRuntime,
  opts: {
    cloneToken?: string
    runPreflights?: (refs: PreflightRef[]) => Promise<PreflightResult[]>
  } = {},
): SharedStackService {
  let n = 0
  return new SharedStackService({
    sharedStackRepository: repo,
    workspaceRepository,
    idGenerator: { next: (prefix: string) => `${prefix}_${++n}` },
    clock: { now: () => 1_700_000_000_000 },
    ...(runtime ? { composeRuntime: runtime } : {}),
    ...(opts.cloneToken ? { cloneToken: opts.cloneToken } : {}),
    ...(opts.runPreflights ? { runPreflights: opts.runPreflights } : {}),
  })
}

const baseInput = {
  name: 'acme-shared-services',
  cloneUrl: 'https://github.com/acme/acme-shared-services.git',
  composeFiles: ['docker-compose.yml'],
  composeProfiles: [] as string[],
  envFiles: [] as { template: string; target: string }[],
  managedNetworks: [] as string[],
  setupSteps: [] as SharedStack['setupSteps'],
  prerequisites: [] as PreflightRef[],
  allowHostCommands: false,
}

describe('SharedStackService', () => {
  let repo: SharedStackRepository
  beforeEach(() => {
    repo = makeRepo()
  })

  it('creates a stopped stack and lists it', async () => {
    const svc = makeService(repo)
    const created = await svc.create(WS, baseInput)
    expect(created.status).toBe('stopped')
    expect(created.id).toBe('ss_1')
    expect(await svc.list(WS)).toEqual([created])
  })

  it('ensureUp clones, creates managed networks, ups, runs steps + gate → running', async () => {
    const svc0 = makeService(repo)
    const created = await svc0.create(WS, {
      ...baseInput,
      managedNetworks: ['acme-net'],
      setupSteps: [
        { kind: 'compose-exec', name: 'users sync', service: 'mysql', command: ['sync'] },
      ],
      healthGate: { kind: 'compose-exec', service: 'app', command: ['health'] },
    })
    const { runtime, calls, networks } = makeRuntime()
    const svc = makeService(repo, runtime)
    const up = await svc.ensureUp(WS, created.id)

    expect(up.status).toBe('running')
    expect(up.lastError).toBeNull()
    expect(networks).toEqual(['acme-net'])
    // `up -d` ran, plus the setup step exec + the health-gate exec.
    expect(calls.some((c) => c.includes('up') && c.includes('-d'))).toBe(true)
    expect(calls.filter((c) => c.includes('exec')).length).toBeGreaterThanOrEqual(2)
  })

  it('ensureUp is idempotent — a live running stack is a no-op (liveness probe only, no second up)', async () => {
    const created = await makeService(repo).create(WS, baseInput)
    const { runtime, calls } = makeRuntime()
    const svc = makeService(repo, runtime)
    await svc.ensureUp(WS, created.id)
    calls.length = 0
    const again = await svc.ensureUp(WS, created.id)
    expect(again.status).toBe('running')
    // The only compose call on the idempotent path is the `ps` liveness probe — never a second `up`.
    expect(calls.some((c) => c.includes('ps'))).toBe(true)
    expect(calls.every((c) => !c.includes('up'))).toBe(true)
  })

  it('re-provisions a stored-running stack whose containers are gone (stale running, not a no-op)', async () => {
    // A `compose-exec` gate so a re-provision converges fast (no `ps` health poll to wait on).
    const created = await makeService(repo).create(WS, {
      ...baseInput,
      healthGate: { kind: 'compose-exec', service: 'app', command: ['health'] },
    })
    // First bring-up succeeds → status running.
    await makeService(repo, makeRuntime().runtime).ensureUp(WS, created.id)
    // Now the daemon reports the project as absent (host reboot / prune): the `ps` liveness probe
    // yields no rows, so the stored `running` must NOT be trusted as a no-op.
    let upArgs: string[] | null = null
    const { runtime } = makeRuntime({
      async compose(args) {
        if (args.includes('up')) upArgs = args
        if (args.includes('ps')) return { code: 0, stdout: '[]', stderr: '' }
        return ok
      },
    })
    const again = await makeService(repo, runtime).ensureUp(WS, created.id)
    // The stale `running` was reconciled away — the stack was cloned + re-`up -d`ed to running.
    expect(upArgs).not.toBeNull()
    expect(upArgs!).toContain('-d')
    expect(again.status).toBe('running')
  })

  it('threads the clone token into checkout when configured (private stack repo)', async () => {
    const created = await makeService(repo).create(WS, baseInput)
    const { runtime, checkouts } = makeRuntime()
    await makeService(repo, runtime, { cloneToken: 'ghp_secret' }).ensureUp(WS, created.id)
    expect(checkouts).toHaveLength(1)
    expect(checkouts[0]?.token).toBe('ghp_secret')
  })

  it('omits the token when none is configured (public clone, unauthenticated)', async () => {
    const created = await makeService(repo).create(WS, baseInput)
    const { runtime, checkouts } = makeRuntime()
    await makeService(repo, runtime).ensureUp(WS, created.id)
    expect(checkouts[0]?.token).toBeUndefined()
  })

  it('coalesces concurrent ensureUp onto one bring-up', async () => {
    const created = await makeService(repo).create(WS, baseInput)
    let ups = 0
    const { runtime } = makeRuntime({
      async compose(args) {
        if (args.includes('up')) {
          ups += 1
          await new Promise((r) => setTimeout(r, 10))
        }
        if (args.includes('ps')) return { code: 0, stdout: '[{"State":"running"}]', stderr: '' }
        return ok
      },
    })
    const svc = makeService(repo, runtime)
    const [a, b] = await Promise.all([svc.ensureUp(WS, created.id), svc.ensureUp(WS, created.id)])
    expect(ups).toBe(1)
    expect(a.status).toBe('running')
    expect(b).toEqual(a)
  })

  it('surfaces a failing setup step as failed + lastError, no health gate reached', async () => {
    const created = await makeService(repo).create(WS, {
      ...baseInput,
      setupSteps: [{ kind: 'compose-exec', name: 'seed', service: 'mysql', command: ['seed'] }],
    })
    const gate = vi.fn()
    const { runtime } = makeRuntime({
      async compose(args) {
        if (args.includes('exec')) return { code: 1, stdout: '', stderr: 'boom' }
        if (args.includes('ps')) gate()
        return ok
      },
    })
    const result = await makeService(repo, runtime).ensureUp(WS, created.id)
    expect(result.status).toBe('failed')
    expect(result.lastError).toContain("Setup step 'seed' failed")
    expect(gate).not.toHaveBeenCalled()
  })

  it('refuses a host-command step unless opted in', async () => {
    const created = await makeService(repo).create(WS, {
      ...baseInput,
      allowHostCommands: false,
      setupSteps: [{ kind: 'host-command', name: 'sysctl', command: ['sysctl', '-w', 'x=1'] }],
    })
    const { runtime } = makeRuntime()
    const result = await makeService(repo, runtime).ensureUp(WS, created.id)
    expect(result.status).toBe('failed')
    expect(result.lastError).toContain('host-command')
  })

  it('runs declared preflights BEFORE clone and fails fast on a blocking failure (no up)', async () => {
    const created = await makeService(repo).create(WS, {
      ...baseInput,
      prerequisites: [{ check: 'mkcert-ca' }],
    })
    const { runtime, calls, checkouts } = makeRuntime()
    const runPreflights = vi.fn(
      async (refs: PreflightRef[]): Promise<PreflightResult[]> =>
        refs.map((r) => ({
          check: r.check,
          title: 'mkcert local CA installed',
          status: 'fail',
          required: true,
          detail: 'CA not in trust store',
          remediation: 'Run `mkcert -install`.',
        })),
    )
    const result = await makeService(repo, runtime, { runPreflights }).ensureUp(WS, created.id)
    expect(result.status).toBe('failed')
    expect(result.lastError).toContain('Preflight check(s) failed')
    expect(result.lastError).toContain('mkcert -install')
    // The gate ran before any clone / compose work.
    expect(runPreflights).toHaveBeenCalledOnce()
    expect(checkouts).toHaveLength(0)
    expect(calls.every((c) => !c.includes('up'))).toBe(true)
  })

  it('proceeds past a passing (and a non-required warn) preflight to running', async () => {
    const created = await makeService(repo).create(WS, {
      ...baseInput,
      prerequisites: [{ check: 'mkcert-ca' }, { check: 'registry-auth', required: false }],
      healthGate: { kind: 'compose-exec', service: 'app', command: ['health'] },
    })
    const runPreflights = vi.fn(
      async (refs: PreflightRef[]): Promise<PreflightResult[]> =>
        refs.map((r) => ({
          check: r.check,
          title: r.check,
          // A non-required check downgrades to an advisory `warn`, which must NOT block.
          status: r.required === false ? 'warn' : 'pass',
          required: r.required ?? true,
        })),
    )
    const { runtime } = makeRuntime()
    const up = await makeService(repo, runtime, { runPreflights }).ensureUp(WS, created.id)
    expect(up.status).toBe('running')
    expect(up.lastError).toBeNull()
  })

  it('fails loudly when a stack declares preflights but no host-probe runner is wired', async () => {
    const created = await makeService(repo).create(WS, {
      ...baseInput,
      prerequisites: [{ check: 'docker-daemon' }],
    })
    // Runtime present (so bring-up would otherwise proceed) but NO runPreflights seam.
    const { runtime } = makeRuntime()
    const result = await makeService(repo, runtime).ensureUp(WS, created.id)
    expect(result.status).toBe('failed')
    expect(result.lastError).toContain('preflight')
  })

  it('skips the preflight gate entirely when no prerequisites are declared', async () => {
    const created = await makeService(repo).create(WS, baseInput) // prerequisites: []
    const runPreflights = vi.fn(async (): Promise<PreflightResult[]> => [])
    const { runtime } = makeRuntime()
    const up = await makeService(repo, runtime, { runPreflights }).ensureUp(WS, created.id)
    expect(up.status).toBe('running')
    expect(runPreflights).not.toHaveBeenCalled()
  })

  it('ensureUp/teardown refuse without a Docker runtime', async () => {
    const created = await makeService(repo).create(WS, baseInput)
    const svc = makeService(repo) // no runtime
    await expect(svc.ensureUp(WS, created.id)).rejects.toThrow(/local Docker runtime/)
    await expect(svc.teardown(WS, created.id)).rejects.toThrow(/local Docker runtime/)
  })

  it('teardown brings the stack down and marks it stopped', async () => {
    const created = await makeService(repo).create(WS, baseInput)
    const { runtime, calls } = makeRuntime()
    const svc = makeService(repo, runtime)
    await svc.ensureUp(WS, created.id)
    const down = await svc.teardown(WS, created.id)
    expect(down.status).toBe('stopped')
    expect(down.lastError).toBeNull()
    expect(calls.some((c) => c.includes('down') && c.includes('-v'))).toBe(true)
  })

  it('ensureRefsUp brings each stack up in order and returns the deduped managed networks', async () => {
    const bootstrap = makeService(repo)
    const a = await bootstrap.create(WS, { ...baseInput, name: 'a', managedNetworks: ['acme-net'] })
    const b = await bootstrap.create(WS, {
      ...baseInput,
      name: 'b',
      managedNetworks: ['acme-net', 'bus-net'], // acme-net repeats → deduped
    })
    const { runtime } = makeRuntime()
    const svc = makeService(repo, runtime)
    const result = await svc.ensureRefsUp(WS, [a.id, b.id])
    expect(result).toEqual({ ok: true, networks: ['acme-net', 'bus-net'] })
    // Both stacks are now running.
    expect((await svc.get(WS, a.id)).status).toBe('running')
    expect((await svc.get(WS, b.id)).status).toBe('running')
  })

  it('ensureRefsUp reports a blocking error for an unknown ref (never throws)', async () => {
    const svc = makeService(repo, makeRuntime().runtime)
    const result = await svc.ensureRefsUp(WS, ['ss_missing'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('ss_missing')
  })

  it('ensureRefsUp surfaces a stack whose bring-up failed', async () => {
    const created = await makeService(repo).create(WS, {
      ...baseInput,
      setupSteps: [{ kind: 'compose-exec', name: 'seed', service: 'db', command: ['seed'] }],
    })
    const { runtime } = makeRuntime({
      async compose(args) {
        if (args.includes('exec')) return { code: 1, stdout: '', stderr: 'boom' }
        return ok
      },
    })
    const result = await makeService(repo, runtime).ensureRefsUp(WS, [created.id])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('is not running')
      expect(result.error).toContain('seed')
    }
  })

  it('ensureRefsUp reports an error (never throws) without a Docker runtime', async () => {
    const created = await makeService(repo).create(WS, baseInput)
    const result = await makeService(repo).ensureRefsUp(WS, [created.id]) // no runtime
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/local Docker runtime/)
  })

  it('refuses to delete or reconfigure a running stack', async () => {
    const created = await makeService(repo).create(WS, baseInput)
    const { runtime } = makeRuntime()
    const svc = makeService(repo, runtime)
    await svc.ensureUp(WS, created.id)
    await expect(svc.remove(WS, created.id)).rejects.toBeInstanceOf(ConflictError)
    await expect(svc.update(WS, created.id, { name: 'x' })).rejects.toBeInstanceOf(ConflictError)
    // After teardown, both are allowed again.
    await svc.teardown(WS, created.id)
    await expect(svc.update(WS, created.id, { name: 'renamed' })).resolves.toMatchObject({
      name: 'renamed',
    })
    await expect(svc.remove(WS, created.id)).resolves.toBeUndefined()
  })
})
