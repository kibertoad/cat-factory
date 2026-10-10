import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ContainerExec,
  LocalContainerRunnerTransport,
} from './LocalContainerRunnerTransport.js'
import { HARNESS_PORT } from './runtimes/containerRuntime.js'

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

describe('LocalContainerRunnerTransport — dispatch', () => {
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
    expect(runCall.join(' ')).toContain(`-p 127.0.0.1:0:${HARNESS_PORT}`)
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
})

describe('LocalContainerRunnerTransport — poll, eviction and release', () => {
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

  it('reports a container that exited 0 mid-job as a shutdown, not an eviction', async () => {
    // The incident this exists for: an agent smoke-testing the service it had just built ran a
    // pattern kill for `node dist/server.js` and matched the harness's own PID 1. The container
    // exited 0, which the engine could only read as "it vanished", so it spent its eviction
    // budget re-running an agent that killed its container every time. A clean exit with a job
    // still in flight means something STOPPED the harness, and that survives a fresh container.
    const exec: ContainerExec = (args) => {
      if (args[0] === 'run') return Promise.resolve({ stdout: 'container-sd\n', stderr: '' })
      if (args[0] === 'port') return Promise.resolve({ stdout: '127.0.0.1:49171\n', stderr: '' })
      if (args[0] === 'inspect') {
        return Promise.resolve({
          stdout: args.includes('{{.State.Running}}') ? 'false\n' : 'false 0 false\n',
          stderr: '',
        })
      }
      if (args[0] === 'logs') {
        return Promise.resolve({ stdout: '{"signal":"SIGTERM","msg":"shutting down"}', stderr: '' })
      }
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
    await transport.dispatch({ runId: 'job-sd', jobId: 'job-sd' }, {}, 'agent')
    const view = await transport.poll({ runId: 'job-sd', jobId: 'job-sd' })
    expect(view.state).toBe('failed')
    expect(view.harnessShutdown).toBe(true)
    // No eviction verdict at all: that field is what funds the fresh-container recovery, and the
    // wording must not carry the sentinel the dispatch-time check matches either.
    expect(view.evicted).toBeUndefined()
    expect(view.error).not.toMatch(/evicted or crashed/)
    // The post-mortem still rides along: it is what names WHO shut it down.
    expect(view.detail).toMatch(/shutting down/)
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
})

describe('LocalContainerRunnerTransport — reaping and start-up failures', () => {
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

describe('LocalContainerRunnerTransport — image variants', () => {
  /** A docker fake plus a fetch that answers health + /jobs, the shape every dispatch needs. */
  function dispatchable() {
    const { exec, calls } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.endsWith('/jobs')) return jsonResponse({ jobId: 'job-1', state: 'running' }, 202)
      throw new Error(`unexpected fetch ${url}`)
    })
    return { exec, calls, fetchImpl: fetchImpl as unknown as typeof fetch }
  }

  it('runs a ui job on the UI image, in its own container beside the run’s ordinary one', async () => {
    const { exec, calls, fetchImpl } = dispatchable()
    const transport = mkTransport({
      image: 'harness:test',
      imageUi: 'harness-ui:test',
      exec,
      fetchImpl,
    })

    await transport.dispatch({ runId: 'run-1', jobId: 'coder' }, {}, 'agent')
    await transport.dispatch({ runId: 'run-1', jobId: 'tester', image: 'ui' }, {}, 'agent')

    // TWO containers for one run: a per-run container cannot change image mid-run, so the
    // browser step gets its own, addressed by the variant-qualified key.
    const runs = calls.filter((c) => c[0] === 'run')
    expect(runs).toHaveLength(2)
    expect(runs[0]).toContain('harness:test')
    expect(runs[0]).toContain('cat-factory.runId=run-1')
    expect(runs[1]).toContain('harness-ui:test')
    expect(runs[1]).toContain('cat-factory.runId=ui:run-1')
  })

  it('re-attaches a second ui step to the SAME ui container rather than starting another', async () => {
    const { exec, calls, fetchImpl } = dispatchable()
    const transport = mkTransport({
      image: 'harness:test',
      imageUi: 'harness-ui:test',
      exec,
      fetchImpl,
    })

    await transport.dispatch({ runId: 'run-1', jobId: 'tester', image: 'ui' }, {}, 'agent')
    await transport.dispatch({ runId: 'run-1', jobId: 'tester-retry', image: 'ui' }, {}, 'agent')

    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(1)
  })

  // The whole point of the variant. Serving this job the default image gives the browser-driven
  // tester no browser, and it finds out only after the checkout, the install and the model's
  // first turns, then reports an `abort` that reads like an app which would not start.
  it('refuses a ui job when no UI image is configured, starting nothing', async () => {
    const { exec, calls, fetchImpl } = dispatchable()
    const transport = mkTransport({ image: 'harness:test', exec, fetchImpl })

    await expect(
      transport.dispatch({ runId: 'run-1', jobId: 'tester', image: 'ui' }, {}, 'agent'),
    ).rejects.toThrow(/LOCAL_HARNESS_IMAGE_UI/)

    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(0)
    // Nor did it clear the way for one: a refusal must not remove a container either.
    expect(calls.filter((c) => c[0] === 'rm')).toHaveLength(0)
  })

  it("runs a DEPLOYMENT's own variant on the image its map names", async () => {
    const { exec, calls, fetchImpl } = dispatchable()
    const transport = mkTransport({
      image: 'harness:test',
      imageVariants: { 'pixel-tools': 'ghcr.io/acme/pixel:2' },
      exec,
      fetchImpl,
    })

    await transport.dispatch(
      { runId: 'run-1', jobId: 'snapper', image: 'pixel-tools' },
      {},
      'agent',
    )

    const runs = calls.filter((c) => c[0] === 'run')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toContain('ghcr.io/acme/pixel:2')
    // Its own container for the run, keyed by the variant exactly as `ui` is: the routing is the
    // platform's, and only the image behind the name is the deployment's.
    expect(runs[0]).toContain('cat-factory.runId=pixel-tools:run-1')
  })

  it('refuses an unmapped deployment variant, naming the variable and starting nothing', async () => {
    // The refusal matters MORE here than for `ui`: the platform knows what its own UI image is
    // for and could describe what a run loses, and it knows nothing about what `pixel-tools`
    // carried, so a fallback would produce a job silently missing it.
    const { exec, calls, fetchImpl } = dispatchable()
    const transport = mkTransport({ image: 'harness:test', exec, fetchImpl })

    await expect(
      transport.dispatch({ runId: 'run-1', jobId: 'snapper', image: 'pixel-tools' }, {}, 'agent'),
    ).rejects.toThrow(/LOCAL_HARNESS_IMAGE_VARIANTS/)
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(0)
  })

  it('refuses a deploy job on the agent path, naming the registration rather than running it', async () => {
    // The agent runner path does not serve `deploy` — those go through the provisioning
    // adapter's own transport — so a `deploy` ref arriving here is a mistake in a kind's
    // registration. Falling through to the default image would start an AGENT-image container
    // with no `kubectl` in it and no diagnosis at all, which is the opposite of what the
    // Worker's `agentContainerNamespace` answers for the same input.
    const { exec, calls, fetchImpl } = dispatchable()
    const transport = mkTransport({
      image: 'harness:test',
      imageUi: 'harness-ui:test',
      exec,
      fetchImpl,
    })

    await expect(
      transport.dispatch({ runId: 'run-1', jobId: 'deployer', image: 'deploy' }, {}, 'agent'),
    ).rejects.toThrow(/agent runner path does not serve/)

    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(0)
  })

  it('evicts the CACHE ENTRY of the container it destroyed when a ui job stop escalates', async () => {
    // `stopJob`'s fallback destroys the container it resolved, and for a `ui` ref that is NOT
    // keyed by the run id. Deleting the run's entry instead left the ui entry pointing at a
    // removed container — which `resolve()` hands straight back, since it never probes liveness
    // — and evicted the ordinary container's handle for nothing.
    const { exec, calls, fetchImpl } = dispatchable()
    const transport = mkTransport({
      image: 'harness:test',
      imageUi: 'harness-ui:test',
      exec,
      fetchImpl,
    })
    await transport.dispatch({ runId: 'run-1', jobId: 'coder' }, {}, 'agent')
    await transport.dispatch({ runId: 'run-1', jobId: 'tester', image: 'ui' }, {}, 'agent')

    // The graceful abort fails (the fake answers no DELETE), so the stop escalates to destroying
    // the container — and still reports the stop it made true.
    expect(await transport.stopJob({ runId: 'run-1', jobId: 'tester', image: 'ui' })).toBe(
      'stopped',
    )

    // The ordinary container's handle survives: a later step re-attaches with no `docker run`.
    calls.length = 0
    await transport.dispatch({ runId: 'run-1', jobId: 'reviewer' }, {}, 'agent')
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(0)

    // The destroyed ui container's handle is gone: the next ui step starts a fresh one rather
    // than fetching a container that no longer exists.
    calls.length = 0
    await transport.dispatch({ runId: 'run-1', jobId: 'tester-2', image: 'ui' }, {}, 'agent')
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(1)
  })

  it('releases the ui container for the ui ref and the ordinary one for the plain ref', async () => {
    const { exec, calls, fetchImpl } = dispatchable()
    const transport = mkTransport({
      image: 'harness:test',
      imageUi: 'harness-ui:test',
      exec,
      fetchImpl,
    })
    await transport.dispatch({ runId: 'run-1', jobId: 'coder' }, {}, 'agent')
    await transport.dispatch({ runId: 'run-1', jobId: 'tester', image: 'ui' }, {}, 'agent')
    calls.length = 0

    await transport.release({ runId: 'run-1', jobId: 'tester', image: 'ui' })

    // A release is per CONTAINER, and a run whose browser step finished still has agent steps to
    // run. Asserted by what each ref does next rather than by the `rm` count: the fake hands
    // back one container id, so counting removals cannot tell the two apart. The ordinary ref
    // re-attaches (no new container); the released ui ref has to start one.
    calls.length = 0
    await transport.dispatch({ runId: 'run-1', jobId: 'reviewer' }, {}, 'agent')
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(0)

    await transport.dispatch({ runId: 'run-1', jobId: 'tester-2', image: 'ui' }, {}, 'agent')
    const restarted = calls.filter((c) => c[0] === 'run')
    expect(restarted).toHaveLength(1)
    expect(restarted[0]).toContain('harness-ui:test')
  })
})

describe('LocalContainerRunnerTransport: ephemeral-environment host bridge', () => {
  // A containerized tester reading a loopback environment URL resolves it to its OWN empty network
  // namespace, so the request never leaves the container. Measured, not assumed: curl in a plain
  // container returns code 000 against `cf-acc-pr8.127.0.0.1.nip.io`, and 404 from the ingress
  // controller with `--add-host=cf-acc-pr8.127.0.0.1.nip.io:host-gateway`. The run that motivated
  // this spent fourteen minutes on the former and reported the environment as dead.
  const ENV_URL = 'http://cf-acc-pr8.127.0.0.1.nip.io'
  const BRIDGE = '--add-host=cf-acc-pr8.127.0.0.1.nip.io:host-gateway'
  const PEER_URL = 'http://email-pr8.127.0.0.1.nip.io'
  const PEER_BRIDGE = '--add-host=email-pr8.127.0.0.1.nip.io:host-gateway'

  // The environments ride the DISPATCH OPTIONS, never the job body. The body is an untyped bag
  // whose URLs sit three levels down under a wire shape the harness owns, and the first cut of
  // this feature read `spec.environmentUrl` — a path the engine has never emitted (it emits
  // `body.infra.environmentUrl`), so the bridge could not fire in production while tests that
  // hand-wrote the spec passed. `containerAgentJobBody.spec.ts` pins the engine's half.
  const withEnvs = (...urls: string[]) => ({ environments: urls.map((url) => ({ url })) })

  function harnessFetch() {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.endsWith('/jobs')) return jsonResponse({ jobId: 'j', state: 'running' }, 202)
      throw new Error(`unexpected fetch ${url}`)
    })
  }

  const runArgs = (calls: string[][]) => calls.filter((args) => args[0] === 'run')

  const mk = () => {
    const { exec, calls } = fakeDocker()
    const transport = mkTransport({
      image: 'harness:test',
      exec,
      fetchImpl: harnessFetch() as unknown as typeof fetch,
    })
    return { transport, calls }
  }

  it('adds the bridge for a loopback environment URL', async () => {
    const { transport, calls } = mk()
    await transport.dispatch({ runId: 'r1', jobId: 'j1' }, {}, 'agent', withEnvs(ENV_URL))
    expect(runArgs(calls)[0]).toContain(BRIDGE)
  })

  it('bridges a live PEER environment as well as the job own one', async () => {
    // A cross-service integration test reaches the peer over the same unreachable name and fails
    // the same way. Bridging only the run's own environment left that case broken while the
    // feature looked complete.
    const { transport, calls } = mk()
    await transport.dispatch({ runId: 'r6', jobId: 'j1' }, {}, 'agent', withEnvs(ENV_URL, PEER_URL))
    expect(runArgs(calls)[0]).toContain(BRIDGE)
    expect(runArgs(calls)[0]).toContain(PEER_BRIDGE)
  })

  it('adds NO bridge for a remote environment URL', async () => {
    // The harmful direction, pinned: re-pointing a real host at the host gateway would break an
    // environment the container could already reach.
    const { transport, calls } = mk()
    await transport.dispatch(
      { runId: 'r2', jobId: 'j1' },
      {},
      'agent',
      withEnvs('https://pr8.staging.example.com'),
    )
    expect(runArgs(calls)[0]?.some((arg) => arg.startsWith('--add-host=pr8.staging'))).toBe(false)
  })

  it('adds NO bridge for a localhost environment URL, which no hosts entry can re-point', async () => {
    // A compose environment publishes `http://localhost:<port>`, so this is the ordinary case
    // rather than a corner. The container will not honour an appended `localhost` entry, and the
    // frontend flow serves WireMock and the built app on localhost INSIDE the container, so a
    // bridge that DID take would break what the job is there to drive.
    const { transport, calls } = mk()
    await transport.dispatch(
      { runId: 'r7', jobId: 'j1' },
      {},
      'agent',
      withEnvs('http://localhost:32768'),
    )
    // Asserted against `localhost` rather than any `--add-host`: the runtime already adds its own
    // host-gateway alias, which is the very entry a job reaches the host through.
    expect(runArgs(calls)[0]?.some((arg) => arg.startsWith('--add-host=localhost'))).toBe(false)
  })

  it('REPLACES a run container that predates the environment, so the tester can reach it', async () => {
    // The ordering this exists for, and it is not an edge case: `dispatchPerRun` starts ONE
    // container for the whole run at its first step, and the environment does not exist until the
    // `deployer` step. So the container every tester re-attaches to was necessarily built before
    // there was a host to bridge, and /etc/hosts is fixed at create time. Without the replacement
    // the bridge would be computed correctly and never applied to the container that needs it.
    const { transport, calls } = mk()
    const ref = { runId: 'r3', jobId: 'j1' }
    // Step one: no environment yet, so no bridge.
    await transport.dispatch(ref, {}, 'agent')
    expect(runArgs(calls)).toHaveLength(1)
    expect(runArgs(calls)[0]).not.toContain(BRIDGE)

    // The tester step, now carrying the provisioned URL.
    await transport.dispatch({ ...ref, jobId: 'j2' }, {}, 'agent', withEnvs(ENV_URL))
    const runs = runArgs(calls)
    expect(runs).toHaveLength(2)
    expect(runs[1]).toContain(BRIDGE)
    // Removing whatever the old key still points at is `dispatchPerRun`'s pre-existing recreate
    // path (the same one that clears a dead container), so it is not re-asserted here: the scripted
    // CLI reports no container for the label, which is what a lookup would find rather than
    // anything this test established.
  })

  it('does NOT replace the container again once it carries the bridge', async () => {
    // Re-polls and later steps on the same URL must re-attach. A replacement per dispatch would
    // re-clone the checkout on every step, which is a worse bug than the one being fixed.
    const { transport, calls } = mk()
    const ref = { runId: 'r4', jobId: 'j1' }
    await transport.dispatch(ref, {}, 'agent', withEnvs(ENV_URL))
    await transport.dispatch({ ...ref, jobId: 'j2' }, {}, 'agent', withEnvs(ENV_URL))
    expect(runArgs(calls)).toHaveLength(1)
  })

  it('does NOT replace the container when the same bridges arrive in another order', async () => {
    // The engine lists a run's peers in whatever order it resolved them, and a set that reordered
    // between two steps would read as a different set and cost the run a re-clone for nothing.
    const { transport, calls } = mk()
    const ref = { runId: 'r8', jobId: 'j1' }
    await transport.dispatch(ref, {}, 'agent', withEnvs(ENV_URL, PEER_URL))
    await transport.dispatch({ ...ref, jobId: 'j2' }, {}, 'agent', withEnvs(PEER_URL, ENV_URL))
    expect(runArgs(calls)).toHaveLength(1)
  })

  it('maps a remote name onto the address PROVED to carry for it', async () => {
    // The Kargo shape: the per-environment DNS record lives in an internal view, so the name
    // resolves nowhere while the balancer fronting it routes on the Host header perfectly well.
    // The hosts entry keeps the name, which is what makes the ingress routing keep working.
    const { transport, calls } = mk()
    await transport.dispatch({ runId: 'r9', jobId: 'j1' }, {}, 'agent', {
      environments: [{ url: 'https://pr-14.test.example.cloud', address: '10.4.19.22' }],
    })
    expect(runArgs(calls)[0]).toContain('--add-host=pr-14.test.example.cloud:10.4.19.22')
  })

  it('REPLACES a container whose bridge points at a stale address', async () => {
    // Same host, different target, which is a different container: the entry is fixed at create
    // time, so a run whose environment moved balancers would otherwise stay wedged against an
    // address nothing answers on, with nothing left to notice it.
    const { transport, calls } = mk()
    const ref = { runId: 'r10', jobId: 'j1' }
    await transport.dispatch(ref, {}, 'agent', {
      environments: [{ url: 'https://pr-14.test.example.cloud', address: '10.4.19.22' }],
    })
    await transport.dispatch({ ...ref, jobId: 'j2' }, {}, 'agent', {
      environments: [{ url: 'https://pr-14.test.example.cloud', address: '10.4.19.23' }],
    })
    const runs = runArgs(calls)
    expect(runs).toHaveLength(2)
    expect(runs[1]).toContain('--add-host=pr-14.test.example.cloud:10.4.19.23')
  })

  it('leaves a bridged container alone for a later step that needs no bridge', async () => {
    // A superset is fine: the entry is inert for a job that never resolves that name, so there is
    // nothing to gain by tearing the container down to remove it.
    const { transport, calls } = mk()
    const ref = { runId: 'r5', jobId: 'j1' }
    await transport.dispatch(ref, {}, 'agent', withEnvs(ENV_URL))
    await transport.dispatch({ ...ref, jobId: 'j2' }, {}, 'agent')
    expect(runArgs(calls)).toHaveLength(1)
  })
})
