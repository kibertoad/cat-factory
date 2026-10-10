import { parseLocalSettings } from '@cat-factory/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ContainerExec,
  LocalContainerRunnerTransport,
} from './LocalContainerRunnerTransport.js'
import type { RunContainerSpec } from './runtimes/index.js'

/** Let a fire-and-forget reconcile (trim/pre-warm) settle before asserting. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

// Coverage for the WARM POOL path (pool size > 0): idle harness containers are kept
// ready and LEASED to a run, then RETURNED to the pool rather than torn down — with the
// run-spec carrying `persistentCheckout: true` so the harness reuses its per-repo checkout.
// The CLI + fetch are injected so it runs with no daemon. The pool-disabled path is the
// existing LocalContainerRunnerTransport.test.ts (every assertion there still holds).

/**
 * A scripted docker CLI that hands out a DISTINCT container id (and host port) per `run`,
 * so multiple pool members can be told apart by the URL the transport fetches. `inspect`
 * (isRunning) and `ps` (listPoolMembers) are overridable.
 */
function fakeDockerPool(opts: { poolMembers?: string[]; running?: () => boolean } = {}) {
  const calls: string[][] = []
  let n = 0
  const portOf = new Map<string, number>()
  const exec: ContainerExec = (args) => {
    calls.push(args)
    const sub = args[0]
    if (sub === 'run') {
      const id = `c${++n}`
      portOf.set(id, 50000 + n)
      return Promise.resolve({ stdout: `${id}\n`, stderr: '' })
    }
    if (sub === 'port') {
      const id = args[1]!
      return Promise.resolve({ stdout: `127.0.0.1:${portOf.get(id) ?? 49999}\n`, stderr: '' })
    }
    if (sub === 'ps')
      return Promise.resolve({ stdout: (opts.poolMembers ?? []).join('\n'), stderr: '' })
    if (sub === 'inspect') {
      return Promise.resolve({ stdout: `${opts.running ? opts.running() : true}\n`, stderr: '' })
    }
    if (sub === 'rm') return Promise.resolve({ stdout: '', stderr: '' })
    return Promise.resolve({ stdout: '', stderr: '' })
  }
  return { exec, calls, portFor: (id: string) => portOf.get(id) }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A fetch that answers /health + /jobs + /jobs/:id uniformly for every member port. */
function okFetch(jobView: unknown = { state: 'running' }) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/health')) return new Response('ok', { status: 200 })
    if (url.includes('/jobs/')) return jsonResponse(jobView)
    return jsonResponse({ state: 'running' }, 202)
  })
}

const repoSpec = (owner: string, name: string) => ({ repo: { owner, name }, mode: 'coding' })

// `sharedSecret` is a REQUIRED constructor argument (no random per-process fallback), so default
// it for these pool unit tests, which don't exercise the secret.
type MkOpts = Omit<
  ConstructorParameters<typeof LocalContainerRunnerTransport>[0],
  'sharedSecret'
> & { sharedSecret?: string }
function mkTransport(opts: MkOpts): LocalContainerRunnerTransport {
  return new LocalContainerRunnerTransport({ sharedSecret: 'sek', ...opts })
}

afterEach(() => vi.restoreAllMocks())

describe('LocalContainerRunnerTransport (warm pool)', () => {
  it('does not double-lease one idle member to two CONCURRENT runs', async () => {
    const { exec, calls } = fakeDockerPool()
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 4,
      exec,
      fetchImpl: okFetch() as unknown as typeof fetch,
    })
    // Warm exactly one idle member.
    await transport.dispatch({ runId: 'r0', jobId: 'j0' }, repoSpec('o', 'r'), 'agent')
    await transport.release({ runId: 'r0', jobId: 'j0' })
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(1)

    // Two leases raced concurrently: the member is CLAIMED synchronously before the health
    // probe awaits, so the second run can't grab the same idle member — it starts a fresh
    // container instead of two runs sharing one container + checkout. (Without the fix both
    // would reuse the single warm member and `run` would still be 1.)
    await Promise.all([
      transport.dispatch({ runId: 'r1', jobId: 'j1' }, repoSpec('o', 'r'), 'agent'),
      transport.dispatch({ runId: 'r2', jobId: 'j2' }, repoSpec('o', 'r'), 'agent'),
    ])
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(2)
  })

  it('leases a member once and reuses it for a later run (one docker run, persistentCheckout injected)', async () => {
    const { exec, calls } = fakeDockerPool()
    const fetchImpl = okFetch()
    const transport = mkTransport({
      image: 'harness:test',
      sharedSecret: 'sek',
      poolSize: 1,
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await transport.dispatch({ runId: 'run-a', jobId: 'j-a' }, repoSpec('o', 'r'), 'agent')
    await transport.release({ runId: 'run-a', jobId: 'j-a' })
    await transport.dispatch({ runId: 'run-b', jobId: 'j-b' }, repoSpec('o', 'r'), 'agent')

    // Only ONE container was started — the second run reused the returned member.
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(1)
    // Pool members are labelled `pool=1`, never by run id.
    const runCall = calls.find((c) => c[0] === 'run')!
    expect(runCall).toContain('cat-factory.pool=1')
    expect(runCall.some((a) => a.startsWith('cat-factory.runId='))).toBe(false)
    // Every dispatch tells the harness to reuse its per-repo checkout.
    const posts = fetchImpl.mock.calls.filter(([u]) => String(u).endsWith('/jobs'))
    expect(posts).toHaveLength(2)
    expect(
      posts.every(([, init]) => JSON.parse(String(init?.body)).persistentCheckout === true),
    ).toBe(true)
  })

  it('runInline leases a member, POSTs an inline job, returns the result, and keeps the member warm', async () => {
    const { exec, calls } = fakeDockerPool()
    // POST /jobs → 202; GET /jobs/:id → a finished inline result.
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.includes('/jobs/'))
        return jsonResponse({
          state: 'done',
          result: {
            text: 'REVIEW OK',
            usage: { inputTokens: 5, outputTokens: 2 },
            finishReason: 'stop',
          },
        })
      // POST /jobs — capture the body for assertions.
      void init
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 1,
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await transport.runInline({
      harness: 'claude-code',
      model: 'claude-opus-5',
      system: 'sys',
      prompt: 'go',
      subscriptionToken: 'oat-token',
    })
    expect(result.text).toBe('REVIEW OK')
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 })

    // The inline job POSTed the credential + kind, no repo checkout.
    const post = fetchImpl.mock.calls.find(([u]) => String(u).endsWith('/jobs'))!
    const body = JSON.parse(String(post[1]?.body))
    expect(body.kind).toBe('inline')
    expect(body.subscriptionToken).toBe('oat-token')
    expect(body.harness).toBe('claude-code')

    // The member is returned to the warm pool (not torn down), reusable by the next call.
    expect(calls.some((c) => c[0] === 'rm')).toBe(false)
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(1)
  })

  it('returns a member to the pool on release (no rm) instead of tearing it down', async () => {
    const { exec, calls } = fakeDockerPool()
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 2,
      exec,
      fetchImpl: okFetch() as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'r1', jobId: 'j1' }, repoSpec('o', 'r'), 'agent')
    await transport.release({ runId: 'r1', jobId: 'j1' })
    // The pooled member is kept warm — release does not remove it.
    expect(calls.some((c) => c[0] === 'rm')).toBe(false)
  })

  it('starts a transient over-capacity member for a concurrent lease and removes it on release', async () => {
    const { exec, calls } = fakeDockerPool()
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 1,
      exec,
      fetchImpl: okFetch() as unknown as typeof fetch,
    })
    // Two concurrent runs, pool cap of 1: the first leases the pooled member, the second
    // (over capacity) gets a transient member.
    await transport.dispatch({ runId: 'r1', jobId: 'j1' }, repoSpec('o', 'r'), 'agent')
    await transport.dispatch({ runId: 'r2', jobId: 'j2' }, repoSpec('o', 'r'), 'agent')
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(2)

    // Releasing the transient (second) member tears it down; releasing the pooled one keeps it.
    await transport.release({ runId: 'r2', jobId: 'j2' })
    expect(calls.some((c) => c[0] === 'rm')).toBe(true)
    const rmCountAfterTransient = calls.filter((c) => c[0] === 'rm').length
    await transport.release({ runId: 'r1', jobId: 'j1' })
    expect(calls.filter((c) => c[0] === 'rm').length).toBe(rmCountAfterTransient)
  })

  it('replaces an idle member that fails its health check on re-lease', async () => {
    const { exec, calls } = fakeDockerPool()
    let healthCalls = 0
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/health')) {
        healthCalls++
        // Call 1: first member's start probe (healthy). Call 2: its re-lease probe FAILS,
        // forcing a replacement. Call 3: the replacement's start probe (healthy).
        return new Response('x', { status: healthCalls === 2 ? 500 : 200 })
      }
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 1,
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'r1', jobId: 'j1' }, repoSpec('o', 'r'), 'agent')
    await transport.release({ runId: 'r1', jobId: 'j1' })
    await transport.dispatch({ runId: 'r2', jobId: 'j2' }, repoSpec('o', 'r'), 'agent')

    // The unhealthy idle member was removed and a fresh one started.
    expect(calls.some((c) => c[0] === 'rm')).toBe(true)
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(2)
  })

  it('drops a member that dies mid-run, reporting an eviction', async () => {
    let alive = true
    const { exec, calls } = fakeDockerPool({ running: () => alive })
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.includes('/jobs/')) throw new Error('ECONNREFUSED')
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 1,
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'r1', jobId: 'j1' }, repoSpec('o', 'r'), 'agent')
    alive = false
    const view = await transport.poll({ runId: 'r1', jobId: 'j1' })
    expect(view.state).toBe('failed')
    expect(view.evicted).toBe('crash')
    expect(view.error).toMatch(/container evicted or crashed/)

    // The dead member was dropped — a subsequent dispatch starts a fresh container.
    await transport.dispatch({ runId: 'r2', jobId: 'j2' }, repoSpec('o', 'r'), 'agent')
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(2)
  })

  it('drains pool orphans from a previous process and pre-warms at boot', async () => {
    const { exec, calls } = fakeDockerPool({ poolMembers: ['orphan-1', 'orphan-2'] })
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 2,
      poolMinWarm: 2,
      exec,
      fetchImpl: okFetch() as unknown as typeof fetch,
    })
    await transport.reapExited()
    // Both previous-process orphans were force-removed...
    expect(calls.some((c) => c[0] === 'rm' && c.includes('orphan-1'))).toBe(true)
    expect(calls.some((c) => c[0] === 'rm' && c.includes('orphan-2'))).toBe(true)
    // ...and the minimum warm members were pre-started.
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(2)
  })

  it('clamps the pre-warm count to poolSize (never warms beyond the kept idle set)', async () => {
    // minWarm > poolSize with a larger poolMax used to pre-warm 5 only for trimIdle to reap
    // 3 on the first release — silently violating the warm floor. minWarm is now clamped to
    // poolSize, so exactly poolSize members are pre-warmed.
    const { exec, calls } = fakeDockerPool()
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 2,
      poolMax: 10,
      poolMinWarm: 5,
      exec,
      fetchImpl: okFetch() as unknown as typeof fetch,
    })
    await transport.reapExited()
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(2)
  })

  it('applySettings resizes the warm pool live, trimming idle members beyond the new size', async () => {
    const { exec, calls } = fakeDockerPool()
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 3,
      poolMinWarm: 3,
      exec,
      fetchImpl: okFetch() as unknown as typeof fetch,
    })
    await transport.reapExited() // pre-warm 3 idle members
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(3)

    // Shrink to 1 via the settings panel: the two excess idle members are reaped LIVE — no
    // restart — so the warm set converges on the new size.
    transport.applySettings(parseLocalSettings({ pool: { size: 1 } }))
    await flush()
    expect(calls.filter((c) => c[0] === 'rm')).toHaveLength(2)
  })

  it('keeps an in-flight per-run run on its own container after pooling is enabled live', async () => {
    // Pooling starts OFF (per-run containers). A run is dispatched, then the operator turns
    // pooling ON mid-flight. The in-flight run must keep polling its per-run container, not
    // the (empty) pool — otherwise it would be spuriously evicted.
    const { exec } = fakeDockerPool()
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 0,
      exec,
      fetchImpl: okFetch() as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'r1', jobId: 'j1' }, repoSpec('o', 'r'), 'agent')
    transport.applySettings(parseLocalSettings({ pool: { size: 2 } }))
    await flush()
    const view = await transport.poll({ runId: 'r1', jobId: 'j1' })
    expect(view.state).toBe('running')
  })

  it('falls back to the per-run path when the runtime does not support pooling', async () => {
    // A non-pooling adapter (e.g. Apple `container`) ignores the configured pool size: the run is
    // labelled by its id and release tears the container down, exactly as without a pool.
    const { exec } = fakeDockerPool()
    const adapter = {
      id: 'apple' as const,
      binary: 'container',
      hostAlias: '192.168.64.1',
      capabilities: { localDind: false, pooling: false },
      publishesToLocalhost: false,
      honoursHostBridges: true,
      run: vi.fn(async (_exec: ContainerExec, _spec: RunContainerSpec) => 'c-apple'),
      find: vi.fn(async () => undefined),
      endpoint: vi.fn(async () => ({ host: '127.0.0.1', port: 51111 })),
      isRunning: vi.fn(async () => true),
      exitState: vi.fn(async () => undefined),
      logs: vi.fn(async () => ''),
      remove: vi.fn(async () => {}),
      removeRun: vi.fn(async () => {}),
      reapExited: vi.fn(async () => 0),
      listPoolMembers: vi.fn(async () => []),
      listRunContainers: vi.fn(async () => []),
    }
    const fetchImpl = okFetch()
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 4,
      adapter,
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'run-x', jobId: 'j-x' }, repoSpec('o', 'r'), 'agent')
    await transport.release({ runId: 'run-x', jobId: 'j-x' })
    // Per-run path: the container is created with `pool` unset, and release removes it.
    expect(adapter.run).toHaveBeenCalledTimes(1)
    expect(adapter.run.mock.calls[0]![1].pool).toBeUndefined()
    expect(adapter.remove).toHaveBeenCalled()
    // No persistentCheckout injected on the per-run path.
    const post = fetchImpl.mock.calls.find(([u]) => String(u).endsWith('/jobs'))!
    expect(JSON.parse(String((post[1] as RequestInit).body)).persistentCheckout).toBeUndefined()
  })
})

describe('stopJob on a pooled member', () => {
  /**
   * A fetch that serves the pool normally but answers `DELETE /jobs/:id` from `stopAnswer`:
   * the shape of a member whose harness will, or will not, confirm the abort.
   */
  function fetchWithStop(stopAnswer: () => Response) {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'DELETE') return stopAnswer()
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.includes('/jobs/')) return jsonResponse({ state: 'running' })
      return jsonResponse({ state: 'running' }, 202)
    })
  }

  it('aborts the job at the harness and keeps the member warm', async () => {
    // The graceful path. Once the harness confirms the job is terminal the member really is idle,
    // so returning it to the pool is right and the next run gets a warm container.
    const { exec, calls } = fakeDockerPool()
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 2,
      exec,
      fetchImpl: fetchWithStop(() =>
        jsonResponse({ jobId: 'j1', state: 'failed' }),
      ) as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'r1', jobId: 'j1' }, repoSpec('o', 'r'), 'agent')

    expect(await transport.stopJob({ runId: 'r1', jobId: 'j1' })).toBe('stopped')
    expect(calls.filter((c) => c[0] === 'rm')).toHaveLength(0)
  })

  it('DESTROYS the member when the abort cannot be confirmed, instead of re-pooling it', async () => {
    // The bug this exists for. `release` hands a member back to the warm pool, and `harnessHealthy`
    // answers 200 for one that is busy, so a refused run whose job could not be stopped would put
    // a container with a LIVE agent and a live checkout back on the idle list for the next run to
    // lease. Two runs, one container, one checkout: exactly what `acquireMember`'s synchronous
    // claim exists to prevent. Removing it stops the job and takes it off the pool in one act.
    const { exec, calls } = fakeDockerPool()
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 2,
      exec,
      fetchImpl: fetchWithStop(
        () => new Response('no such route', { status: 404 }),
      ) as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'r1', jobId: 'j1' }, repoSpec('o', 'r'), 'agent')
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(1)

    expect(await transport.stopJob({ runId: 'r1', jobId: 'j1' })).toBe('stopped')
    expect(calls.filter((c) => c[0] === 'rm')).toHaveLength(1)

    // And it is really gone from the pool: the next run cold-starts rather than leasing it.
    await transport.dispatch({ runId: 'r2', jobId: 'j2' }, repoSpec('o', 'r'), 'agent')
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(2)
  })

  it('escalates when the harness answers but the job is STILL running', async () => {
    // A signalled abort is not a stopped agent, which is the whole reason the harness waits for
    // the job to settle before answering.
    const { exec, calls } = fakeDockerPool()
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 2,
      exec,
      fetchImpl: fetchWithStop(() =>
        jsonResponse({ jobId: 'j1', state: 'running' }),
      ) as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'r1', jobId: 'j1' }, repoSpec('o', 'r'), 'agent')

    expect(await transport.stopJob({ runId: 'r1', jobId: 'j1' })).toBe('stopped')
    expect(calls.filter((c) => c[0] === 'rm')).toHaveLength(1)
  })

  it('reports `stopped` for a run with nothing serving it', async () => {
    // Idempotent: there is no job left to stop, which IS the stopped state.
    const { exec } = fakeDockerPool()
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 2,
      exec,
      fetchImpl: okFetch() as unknown as typeof fetch,
    })
    expect(await transport.stopJob({ runId: 'never-dispatched', jobId: 'j' })).toBe('stopped')
  })
})

describe('post-mortem on a pooled member', () => {
  const LOG_TAIL = 'harness: heap out of memory while running the coder step'

  /**
   * A pooling adapter whose exit state and log tail are scripted, so the two eviction branches
   * can be told apart by whether the tail reached the run's failure detail.
   */
  function poolingAdapter(running: () => boolean) {
    let n = 0
    return {
      id: 'docker' as const,
      binary: 'docker',
      hostAlias: 'host.docker.internal',
      capabilities: { localDind: true, pooling: true },
      publishesToLocalhost: true,
      honoursHostBridges: true,
      run: vi.fn(async () => `pool-${++n}`),
      find: vi.fn(async () => undefined),
      endpoint: vi.fn(async () => ({ host: '127.0.0.1', port: 51234 })),
      isRunning: vi.fn(async () => running()),
      exitState: vi.fn(async () => ({
        description: 'exit code 137, OOM-killed by the container runtime',
        code: 137,
      })),
      logs: vi.fn(async () => LOG_TAIL),
      remove: vi.fn(async () => {}),
      removeRun: vi.fn(async () => {}),
      reapExited: vi.fn(async () => 0),
      listPoolMembers: vi.fn(async () => []),
      listRunContainers: vi.fn(async () => []),
    }
  }

  it("carries a confirmed-dead member's exit state and log tail onto the run", async () => {
    // The member stopped answering AND the runtime confirms it is gone, so it died while leased
    // to this run: its last output is this run's last words, and the only record of WHY.
    let alive = true
    const adapter = poolingAdapter(() => alive)
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 1,
      adapter,
      exec: fakeDockerPool().exec,
      fetchImpl: vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/health')) return new Response('ok', { status: 200 })
        if (url.includes('/jobs/')) throw new Error('ECONNREFUSED')
        return jsonResponse({ state: 'running' }, 202)
      }) as unknown as typeof fetch,
    })

    await transport.dispatch({ runId: 'r1', jobId: 'j1' }, repoSpec('o', 'r'), 'agent')
    alive = false
    const view = await transport.poll({ runId: 'r1', jobId: 'j1' })

    expect(view.evicted).toBe('crash')
    expect(view.detail).toContain('OOM-killed')
    expect(view.detail).toContain(LOG_TAIL)
  })

  it("refuses to attach a LIVE member's output to this run, and says why", async () => {
    // The member answered the poll with a 404: its harness restarted or reaped the job, so the
    // member is alive and already serving somebody else. Its stdout is that run's, possibly from
    // another repo, and a tail lifted off it would be indistinguishable from a genuine one on
    // this run's failure. The per-run path cannot reach this case (one container, one run).
    const adapter = poolingAdapter(() => true)
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 1,
      adapter,
      exec: fakeDockerPool().exec,
      fetchImpl: vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/health')) return new Response('ok', { status: 200 })
        if (url.includes('/jobs/')) return new Response('no such job', { status: 404 })
        return jsonResponse({ state: 'running' }, 202)
      }) as unknown as typeof fetch,
    })

    await transport.dispatch({ runId: 'r1', jobId: 'j1' }, repoSpec('o', 'r'), 'agent')
    const view = await transport.poll({ runId: 'r1', jobId: 'j1' })

    expect(view.evicted).toBe('crash')
    // The failure states what happened instead of borrowing another run's evidence...
    expect(view.detail).toContain('no longer knows this job')
    expect(view.detail).not.toContain(LOG_TAIL)
    // ...and the tail is never even read, so there is nothing to leak into it.
    expect(adapter.logs).not.toHaveBeenCalled()
  })
})

describe('warm pool and the ephemeral-environment host bridge', () => {
  const ENV_URL = 'http://cf-acc-pr8.127.0.0.1.nip.io'
  const BRIDGE = '--add-host=cf-acc-pr8.127.0.0.1.nip.io:host-gateway'
  // The environments ride the dispatch OPTIONS, never the job body. See the sibling suite in
  // `LocalContainerRunnerTransport.test.ts` for why reading them off the body could not work.
  const withEnvs = (...urls: string[]) => ({ environments: urls.map((url) => ({ url })) })

  it('serves a bridged job PER RUN and hands the leased member back', async () => {
    // Two independent reasons a pool member cannot serve this job, and the second is the one that
    // would corrupt a neighbour: a member is started before any job exists so it cannot carry a
    // per-job name, AND it is re-leased across runs, so an /etc/hosts entry for one run's per-PR
    // environment would sit in the container the NEXT run leases.
    const { exec, calls } = fakeDockerPool()
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 2,
      exec,
      fetchImpl: okFetch() as unknown as typeof fetch,
    })
    const ref = { runId: 'r1', jobId: 'j1' }

    // Step one has no environment, so it leases from the pool as usual.
    await transport.dispatch(ref, repoSpec('o', 'r'), 'agent')
    const afterLease = calls.filter((c) => c[0] === 'run')
    expect(afterLease).toHaveLength(1)
    expect(afterLease[0]).not.toContain(BRIDGE)

    // The tester step carries the provisioned URL: a fresh per-run container, carrying the bridge.
    await transport.dispatch(
      { ...ref, jobId: 'j2' },
      repoSpec('o', 'r'),
      'agent',
      withEnvs(ENV_URL),
    )
    const runs = calls.filter((c) => c[0] === 'run')
    expect(runs).toHaveLength(2)
    expect(runs[1]).toContain(BRIDGE)
    // The member went BACK to the pool rather than staying leased to a run that has moved off it:
    // a lease nothing will ever release is a pool slot lost for the process's lifetime. Asserted
    // through the pool's own behaviour rather than a test-only accessor: a fresh run leases the
    // released member, so no third container is started.
    await transport.dispatch({ runId: 'r-next', jobId: 'j1' }, repoSpec('o', 'r'), 'agent')
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(2)
  })

  it('still pools a job whose environment URL is remote', async () => {
    // The bridge guard must key off whether a bridge is NEEDED, not off the presence of a URL,
    // or every deployment with a real environment loses the warm pool.
    const { exec, calls } = fakeDockerPool()
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 2,
      exec,
      fetchImpl: okFetch() as unknown as typeof fetch,
    })
    const ref = { runId: 'r2', jobId: 'j1' }
    await transport.dispatch(ref, repoSpec('o', 'r'), 'agent')
    await transport.dispatch(
      { ...ref, jobId: 'j2' },
      repoSpec('o', 'r'),
      'agent',
      withEnvs('https://pr8.staging.example.com'),
    )
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(1)
  })

  it('still pools a job whose environment URL is localhost, which no bridge would fix', async () => {
    // A compose environment publishes `http://localhost:<port>`. Grading that as needing a bridge
    // cost every such run its warm-pool member AND a container replacement, buying an /etc/hosts
    // entry the container would not honour. The environment is unreachable either way; paying for
    // it is the part that was wrong.
    const { exec, calls } = fakeDockerPool()
    const transport = mkTransport({
      image: 'harness:test',
      poolSize: 2,
      exec,
      fetchImpl: okFetch() as unknown as typeof fetch,
    })
    const ref = { runId: 'r3', jobId: 'j1' }
    await transport.dispatch(ref, repoSpec('o', 'r'), 'agent')
    await transport.dispatch(
      { ...ref, jobId: 'j2' },
      repoSpec('o', 'r'),
      'agent',
      withEnvs('http://localhost:32768'),
    )
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(1)
  })
})
