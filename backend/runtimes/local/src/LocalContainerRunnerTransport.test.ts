import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ContainerExec,
  LocalContainerRunnerTransport,
} from './LocalContainerRunnerTransport.js'

// Unit coverage for the local container transport with the CLI + fetch injected, so it
// runs anywhere (no daemon, no Postgres). With no adapter supplied it defaults to the
// Docker-CLI adapter, so these assert the docker-family lifecycle (run → port → health →
// dispatch), idempotent re-attach by label, that every dispatch posts to /jobs with the
// kind in the body, and the eviction mapping a vanished container produces. The Apple
// adapter is covered separately.

/** A scripted docker CLI: records calls and returns canned stdout per subcommand. */
function fakeDocker(overrides: Partial<Record<string, string>> = {}) {
  const calls: string[][] = []
  const exec: ContainerExec = (args) => {
    calls.push(args)
    const sub = args[0]
    if (sub === 'run') return Promise.resolve({ stdout: 'container-abc\n', stderr: '' })
    if (sub === 'port') {
      return Promise.resolve({ stdout: overrides.port ?? '127.0.0.1:49170\n', stderr: '' })
    }
    if (sub === 'ps') return Promise.resolve({ stdout: overrides.ps ?? '', stderr: '' })
    if (sub === 'inspect') {
      return Promise.resolve({ stdout: overrides.inspect ?? 'true\n', stderr: '' })
    }
    if (sub === 'rm') return Promise.resolve({ stdout: 'container-abc\n', stderr: '' })
    return Promise.resolve({ stdout: '', stderr: '' })
  }
  return { exec, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// `sharedSecret` is now a REQUIRED constructor argument (the transport never invents a random
// per-process value — that broke re-attach across restarts). These unit tests don't exercise the
// secret, so default it here and let a case override via `opts`.
type MkOpts = Omit<
  ConstructorParameters<typeof LocalContainerRunnerTransport>[0],
  'sharedSecret'
> & { sharedSecret?: string }
function mkTransport(opts: MkOpts): LocalContainerRunnerTransport {
  return new LocalContainerRunnerTransport({ sharedSecret: 'sek', ...opts })
}

afterEach(() => vi.restoreAllMocks())

describe('LocalContainerRunnerTransport', () => {
  it('starts a labelled container, waits for health, then POSTs the job to /jobs', async () => {
    const { exec, calls } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.endsWith('/jobs')) return jsonResponse({ jobId: 'job-1', state: 'running' }, 202)
      throw new Error(`unexpected fetch ${url}`)
    })
    const transport = mkTransport({
      image: 'harness:test',
      sharedSecret: 'sek',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await transport.dispatch({ runId: 'job-1', jobId: 'job-1' }, { hello: 'world' }, 'agent')

    const runCall = calls.find((c) => c[0] === 'run')!
    expect(runCall).toContain('--label')
    expect(runCall).toContain('cat-factory.runId=job-1')
    expect(runCall.join(' ')).toContain('-p 127.0.0.1:0:8080')
    expect(runCall.join(' ')).toContain('HARNESS_SHARED_SECRET=sek')
    expect(runCall).toContain('harness:test')

    const post = fetchImpl.mock.calls.find(([u]) => String(u).endsWith('/jobs'))!
    expect(String(post[0])).toBe('http://127.0.0.1:49170/jobs')
    const init = post[1] as RequestInit
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-harness-secret']).toBe('sek')
    // The kind travels in the body alongside the job spec.
    expect(init.body).toBe('{"hello":"world","kind":"agent"}')
  })

  it('re-attaches to an existing container (idempotent dispatch) without a second docker run', async () => {
    // First dispatch starts the container; the second resolves it from the cache.
    const { exec, calls } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await transport.dispatch({ runId: 'job-1', jobId: 'job-1' }, {}, 'agent')
    await transport.dispatch({ runId: 'job-1', jobId: 'job-1' }, {}, 'agent')

    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(1)
    // Both dispatches POST to /jobs, each carrying the `agent` kind in the body.
    const posts = fetchImpl.mock.calls.filter(([u]) => String(u).endsWith('/jobs'))
    expect(posts).toHaveLength(2)
    expect(posts.every(([, init]) => JSON.parse(String(init?.body)).kind === 'agent')).toBe(true)
  })

  it('shares one per-run container across steps, keyed by run id and polled by job id', async () => {
    // Two steps of ONE run: same run id (so they share a single container — only one
    // `docker run`), but distinct per-step job ids so the harness never aliases one
    // step's result for another. The poll addresses the run's container yet reads the
    // per-step job by its own id.
    const { exec, calls } = fakeDocker()
    const jobPaths: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.includes('/jobs/')) {
        jobPaths.push(new URL(url).pathname)
        return jsonResponse({ state: 'running' }, 200)
      }
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await transport.dispatch({ runId: 'run-1', jobId: 'run-1-spec' }, {}, 'agent')
    await transport.dispatch({ runId: 'run-1', jobId: 'run-1-architect' }, {}, 'agent')
    // The second step re-attaches to the run's container — only one `docker run`.
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(1)
    expect(calls.find((c) => c[0] === 'run')!).toContain('cat-factory.runId=run-1')

    await transport.poll({ runId: 'run-1', jobId: 'run-1-architect' })
    expect(jobPaths).toContain('/jobs/run-1-architect')
  })

  it('posts the single manifest-driven `agent` kind to /jobs in the body', async () => {
    const { exec } = fakeDocker()
    const posted: { path: string; kind: unknown }[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      posted.push({
        path: new URL(url).pathname,
        kind: JSON.parse(String(init?.body)).kind,
      })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    // Every built-in agent now dispatches the single `agent` kind (the body's `mode` +
    // data select the flow), so each POST carries `kind:'agent'`.
    await transport.dispatch({ runId: 'a', jobId: 'a' }, {}, 'agent')
    await transport.dispatch({ runId: 'b', jobId: 'b' }, {}, 'agent')
    expect(posted).toEqual([
      { path: '/jobs', kind: 'agent' },
      { path: '/jobs', kind: 'agent' },
    ])
  })

  it('runs the per-run container privileged (Docker-in-Docker) when DinD test jobs are enabled', async () => {
    // The container is per-RUN and shared across steps; a run may include a Tester step
    // that stands its infra up via Docker-in-Docker, so the whole run's container runs
    // privileged whenever `privilegedTestJobs` is on (the default).
    const { exec, calls } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 't', jobId: 't' }, {}, 'agent')
    expect(calls.find((c) => c[0] === 'run')!).toContain('--privileged')
  })

  it('omits --privileged when privilegedTestJobs is disabled (no local DinD)', async () => {
    const { exec, calls } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      privilegedTestJobs: false,
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 't', jobId: 't' }, {}, 'agent')
    expect(calls.find((c) => c[0] === 'run')!).not.toContain('--privileged')
  })

  it('sizes the job container from the dispatch instanceSize', async () => {
    const { exec, calls } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'big', jobId: 'big' }, {}, 'agent', { instanceSize: 'large' })
    const run = calls.find((c) => c[0] === 'run')!
    expect(run.join(' ')).toContain('--memory 4g')
    expect(run.join(' ')).toContain('--cpus 4')
  })

  it('polls the job view through the mapped port', async () => {
    const { exec } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.includes('/jobs/')) {
        return jsonResponse({ state: 'done', result: { prUrl: 'https://x/pr/1' } })
      }
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'job-9', jobId: 'job-9' }, {}, 'agent')
    const view = await transport.poll({ runId: 'job-9', jobId: 'job-9' })
    expect(view.state).toBe('done')
    expect(view.result?.prUrl).toBe('https://x/pr/1')
  })

  it('forwards the harness liveness heartbeat verbatim on a running poll', async () => {
    // Runtime symmetry with the Cloudflare container transport: local casts the harness JobView
    // verbatim, so the harness `heartbeatAt` must ride through to `RunnerJobView.heartbeatAt` (which
    // the executor lifts onto `lastActivityAt`) — otherwise a live-but-quiet local run looks wedged.
    const { exec } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.includes('/jobs/')) {
        return jsonResponse({ state: 'running', heartbeatAt: 1_700_000_123_456 }, 200)
      }
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'job-hb', jobId: 'job-hb' }, {}, 'agent')
    const view = await transport.poll({ runId: 'job-hb', jobId: 'job-hb' })
    expect(view.state).toBe('running')
    expect(view.heartbeatAt).toBe(1_700_000_123_456)
  })

  it('reports an eviction when no container exists for the job', async () => {
    // ps returns nothing → the job has no container.
    const { exec } = fakeDocker({ ps: '' })
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      fetchImpl: (() => {
        throw new Error('should not fetch')
      }) as unknown as typeof fetch,
    })
    const view = await transport.poll({ runId: 'ghost', jobId: 'ghost' })
    expect(view.state).toBe('failed')
    expect(view.evicted).toBe('crash')
    expect(view.error).toMatch(/container evicted or crashed/)
  })

  it('reports an eviction when the container has exited and the harness is unreachable', async () => {
    const { exec } = fakeDocker({ inspect: 'false\n' })
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.includes('/jobs/')) throw new Error('ECONNREFUSED')
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'job-x', jobId: 'job-x' }, {}, 'agent')
    const view = await transport.poll({ runId: 'job-x', jobId: 'job-x' })
    expect(view.state).toBe('failed')
    expect(view.evicted).toBe('crash')
    expect(view.error).toMatch(/container evicted or crashed/)
  })

  it('carries the dead container exit state + logs as the eviction detail', async () => {
    // The container is reclaimed the moment the run settles, so this poll is the last chance to
    // read WHY the harness process went away. Without it an eviction is a dead end: the run
    // records "container evicted or crashed" and the evidence is deleted seconds later.
    const exec: ContainerExec = (args) => {
      if (args[0] === 'run') return Promise.resolve({ stdout: 'container-pm\n', stderr: '' })
      if (args[0] === 'port') return Promise.resolve({ stdout: '127.0.0.1:49170\n', stderr: '' })
      if (args[0] === 'inspect') {
        // `isRunning` reads `{{.State.Running}}`; `exitState` reads running+code+OOM.
        return Promise.resolve({
          stdout: args.includes('{{.State.Running}}') ? 'false\n' : 'false 137 true\n',
          stderr: '',
        })
      }
      if (args[0] === 'logs') return Promise.resolve({ stdout: 'agent: out of memory', stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    }
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.includes('/jobs/')) throw new Error('ECONNREFUSED')
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'job-pm', jobId: 'job-pm' }, {}, 'agent')
    const view = await transport.poll({ runId: 'job-pm', jobId: 'job-pm' })
    expect(view.state).toBe('failed')
    expect(view.evicted).toBe('crash')
    // The eviction classification is unchanged (it drives the fresh-container recovery); the
    // post-mortem rides `detail`, which the engine records as the failure detail.
    expect(view.error).toMatch(/container evicted or crashed/)
    expect(view.detail).toMatch(/exit code 137/)
    expect(view.detail).toMatch(/OOM-killed/)
    expect(view.detail).toMatch(/agent: out of memory/)
  })

  it('recreates the container when a stale one makes `docker port` exit non-zero', async () => {
    // The real regression: `docker port` FAILS (exit 1, "no public port … published") for an
    // exited container, and `find()` returns exited containers by design. That throw used to
    // escape `resolve()`, skipping the remove-and-recreate below and surfacing the CLI's
    // message as the run's cause of death.
    let staleLookupDone = false
    const calls: string[][] = []
    const exec: ContainerExec = (args) => {
      calls.push(args)
      const sub = args[0]
      if (sub === 'run') return Promise.resolve({ stdout: 'fresh-container\n', stderr: '' })
      if (sub === 'ps') return Promise.resolve({ stdout: 'stale-container\n', stderr: '' })
      if (sub === 'port') {
        if (!staleLookupDone) {
          staleLookupDone = true
          return Promise.reject(
            new Error("no public port '8080/tcp' published for stale-container"),
          )
        }
        return Promise.resolve({ stdout: '127.0.0.1:49180\n', stderr: '' })
      }
      // The stale container is gone; `endpoint` consults liveness to tell a dead container
      // (not ready) apart from a daemon fault against a live one (a real error).
      if (sub === 'inspect') return Promise.resolve({ stdout: 'false\n', stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    }
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'job-dead', jobId: 'job-dead' }, {}, 'agent')
    expect(calls.some((c) => c[0] === 'rm' && c.includes('stale-container'))).toBe(true)
    expect(calls.some((c) => c[0] === 'run')).toBe(true)
  })

  it('still reports a port lookup that fails against a RUNNING container', async () => {
    // The other half of the contract: only a DEAD container maps to "not ready". A fault
    // against a live one is a genuine problem, and swallowing it would replace the real cause
    // with a bare start timeout.
    const exec: ContainerExec = (args) => {
      if (args[0] === 'run') return Promise.resolve({ stdout: 'live-container\n', stderr: '' })
      if (args[0] === 'port') return Promise.reject(new Error('docker daemon connection reset'))
      if (args[0] === 'inspect') return Promise.resolve({ stdout: 'true\n', stderr: '' })
      if (args[0] === 'logs') return Promise.resolve({ stdout: 'still booting', stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    }
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      readyTimeoutMs: 20,
      fetchImpl: vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch,
    })
    await expect(transport.dispatch({ runId: 'live', jobId: 'live' }, {}, 'agent')).rejects.toThrow(
      /did not expose its endpoint before the start timeout[\s\S]*connection reset/,
    )
  })

  it('release force-removes the job container and is a no-op when absent', async () => {
    const { exec, calls } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'job-r', jobId: 'job-r' }, {}, 'agent')
    await transport.release({ runId: 'job-r', jobId: 'job-r' })
    expect(calls.some((c) => c[0] === 'rm' && c.includes('container-abc'))).toBe(true)

    // A second release (now uncached, ps empty) does not throw.
    const empty = fakeDocker({ ps: '' })
    const t2 = mkTransport({ image: 'i', exec: empty.exec })
    await expect(t2.release({ runId: 'missing', jobId: 'missing' })).resolves.toBeUndefined()
  })

  it('maps a 404 job view (container up, job unknown/reaped) to an eviction', async () => {
    const { exec } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.includes('/jobs/')) return new Response('not found', { status: 404 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'job-404', jobId: 'job-404' }, {}, 'agent')
    const view = await transport.poll({ runId: 'job-404', jobId: 'job-404' })
    expect(view.state).toBe('failed')
    expect(view.evicted).toBe('crash')
    expect(view.error).toMatch(/container evicted or crashed/)
  })

  it('throws (does not evict) when dispatch gets a non-OK HTTP response', async () => {
    const { exec } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      return new Response('boom', { status: 500 })
    })
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(
      transport.dispatch({ runId: 'job-500', jobId: 'job-500' }, {}, 'agent'),
    ).rejects.toThrow(/HTTP 500/)
  })

  it('removes a lingering container for the same job id before starting a fresh one', async () => {
    // resolve() returns undefined (ps finds an id but `port` is unmapped → exited), so
    // dispatch must `rm -f` the stale container before `docker run`.
    let firstPortLookup = true
    const calls: string[][] = []
    const exec: ContainerExec = (args) => {
      calls.push(args)
      const sub = args[0]
      if (sub === 'run') return Promise.resolve({ stdout: 'fresh-container\n', stderr: '' })
      if (sub === 'ps') return Promise.resolve({ stdout: 'stale-container\n', stderr: '' })
      if (sub === 'port') {
        // First lookup (resolve of the stale container) is unmapped; later lookups
        // (the fresh container's waitForPort) succeed.
        if (firstPortLookup) {
          firstPortLookup = false
          return Promise.resolve({ stdout: '\n', stderr: '' })
        }
        return Promise.resolve({ stdout: '127.0.0.1:49180\n', stderr: '' })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'job-stale', jobId: 'job-stale' }, {}, 'agent')
    // The stale container was force-removed, then a fresh one was started.
    expect(calls.some((c) => c[0] === 'rm' && c.includes('stale-container'))).toBe(true)
    expect(calls.some((c) => c[0] === 'run')).toBe(true)
  })

  it('reapExited force-removes exited managed containers and returns the count', async () => {
    const calls: string[][] = []
    const exec: ContainerExec = (args) => {
      calls.push(args)
      if (args[0] === 'ps') return Promise.resolve({ stdout: 'c1\nc2\n', stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    }
    const transport = mkTransport({ image: 'harness:test', exec })
    const reaped = await transport.reapExited()
    expect(reaped).toBe(2)
    const psCall = calls.find((c) => c[0] === 'ps')!
    expect(psCall).toContain('status=exited')
    expect(psCall.join(' ')).toContain('label=cat-factory.managed=local-docker')
    const rmCall = calls.find((c) => c[0] === 'rm')!
    expect(rmCall).toEqual(['rm', '-f', 'c1', 'c2'])
  })

  it('reapExited is a no-op (count 0) when no exited containers exist', async () => {
    const { exec, calls } = fakeDocker({ ps: '' })
    const transport = mkTransport({ image: 'harness:test', exec })
    expect(await transport.reapExited()).toBe(0)
    expect(calls.some((c) => c[0] === 'rm')).toBe(false)
  })

  it('fails fast (no ready-timeout wait) with the container logs when it exits before exposing its endpoint', async () => {
    // Docker broke mid-boot: the container exited immediately, so `port` never maps and
    // `inspect` reports not-running. The transport must surface the container's own logs at
    // once rather than spinning for the full (here deliberately huge) ready timeout.
    const exec: ContainerExec = (args) => {
      const sub = args[0]
      if (sub === 'run') return Promise.resolve({ stdout: 'dead-container\n', stderr: '' })
      if (sub === 'ps') return Promise.resolve({ stdout: '', stderr: '' })
      if (sub === 'port') return Promise.resolve({ stdout: '\n', stderr: '' })
      if (sub === 'inspect') return Promise.resolve({ stdout: 'false\n', stderr: '' })
      if (sub === 'logs') return Promise.resolve({ stdout: 'boom: missing env VAR\n', stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    }
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      // Huge so the assertion proves fail-fast, not just a short timeout elapsing.
      readyTimeoutMs: 60_000,
      fetchImpl: (() => {
        throw new Error('should not fetch before the endpoint is ready')
      }) as unknown as typeof fetch,
    })
    await expect(transport.dispatch({ runId: 'dead', jobId: 'dead' }, {}, 'agent')).rejects.toThrow(
      /exited before exposing its endpoint[\s\S]*boom: missing env VAR/,
    )
    // Classified as a `dispatch` (container-failed-to-start) failure, NOT an eviction.
    await expect(
      transport.dispatch({ runId: 'dead2', jobId: 'dead2' }, {}, 'agent'),
    ).rejects.not.toThrow(/evicted or crashed/)
  })

  it('fails fast with the container logs when it dies before the harness becomes healthy', async () => {
    // The endpoint maps (so waitForEndpoint passes) but the container then dies, so the
    // harness `/health` will never answer — surface the logs instead of waiting it out.
    const exec: ContainerExec = (args) => {
      const sub = args[0]
      if (sub === 'run') return Promise.resolve({ stdout: 'crash-container\n', stderr: '' })
      if (sub === 'ps') return Promise.resolve({ stdout: '', stderr: '' })
      if (sub === 'port') return Promise.resolve({ stdout: '127.0.0.1:49190\n', stderr: '' })
      if (sub === 'inspect') return Promise.resolve({ stdout: 'false\n', stderr: '' })
      if (sub === 'logs') return Promise.resolve({ stdout: 'panic: harness crashed\n', stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    }
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      readyTimeoutMs: 60_000,
      // The harness never comes up: /health stays non-OK, so the loop consults the runtime,
      // finds the container dead, and fails fast (rather than waiting out the ready timeout).
      fetchImpl: (async () => new Response('down', { status: 503 })) as unknown as typeof fetch,
    })
    await expect(
      transport.dispatch({ runId: 'crash', jobId: 'crash' }, {}, 'agent'),
    ).rejects.toThrow(/exited before the harness became healthy[\s\S]*panic: harness crashed/)
  })

  it('surfaces the last endpoint error + logs when the running container never exposes its endpoint', async () => {
    // The container stays up but `port` keeps failing (a daemon hiccup), so the endpoint
    // wait legitimately times out — the error must still carry the root cause, not a bare
    // "timed out" with nothing to act on.
    const exec: ContainerExec = (args) => {
      const sub = args[0]
      if (sub === 'run') return Promise.resolve({ stdout: 'slow-container\n', stderr: '' })
      if (sub === 'ps') return Promise.resolve({ stdout: '', stderr: '' })
      if (sub === 'port') return Promise.reject(new Error('docker port: connection reset'))
      if (sub === 'inspect') return Promise.resolve({ stdout: 'true\n', stderr: '' })
      if (sub === 'logs') return Promise.resolve({ stdout: 'still booting\n', stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    }
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      readyTimeoutMs: 40,
      fetchImpl: (() => {
        throw new Error('should not fetch')
      }) as unknown as typeof fetch,
    })
    await expect(transport.dispatch({ runId: 'slow', jobId: 'slow' }, {}, 'agent')).rejects.toThrow(
      /did not expose its endpoint before the start timeout[\s\S]*connection reset/,
    )
  })

  it('forwards the checkout-reuse settings into the container as -e env', async () => {
    // The DB-stored checkout config (workspace root + clean-keep list) is consumed INSIDE
    // the harness container, so the transport passes it as `-e HARNESS_*` on `docker run`.
    const { exec, calls } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = mkTransport({
      image: 'harness:test',
      env: { HARNESS_WORKSPACE_ROOT: '/ws', HARNESS_CLEAN_KEEP: 'node_modules,.venv' },
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'r1', jobId: 'j1' }, {}, 'agent')
    const runCall = calls.find((c) => c[0] === 'run')!.join(' ')
    expect(runCall).toContain('HARNESS_WORKSPACE_ROOT=/ws')
    expect(runCall).toContain('HARNESS_CLEAN_KEEP=node_modules,.venv')
  })
})
