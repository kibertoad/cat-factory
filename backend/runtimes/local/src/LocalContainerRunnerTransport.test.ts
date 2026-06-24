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
    const transport = new LocalContainerRunnerTransport({
      image: 'harness:test',
      sharedSecret: 'sek',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await transport.dispatch({ runId: 'job-1', jobId: 'job-1' }, { hello: 'world' }, 'run')

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
    expect(init.body).toBe('{"hello":"world","kind":"run"}')
  })

  it('re-attaches to an existing container (idempotent dispatch) without a second docker run', async () => {
    // First dispatch starts the container; the second resolves it from the cache.
    const { exec, calls } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = new LocalContainerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await transport.dispatch({ runId: 'job-1', jobId: 'job-1' }, {}, 'merge')
    await transport.dispatch({ runId: 'job-1', jobId: 'job-1' }, {}, 'merge')

    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(1)
    // Both dispatches POST to /jobs, each carrying the merge kind in the body.
    const posts = fetchImpl.mock.calls.filter(([u]) => String(u).endsWith('/jobs'))
    expect(posts).toHaveLength(2)
    expect(posts.every(([, init]) => JSON.parse(String(init?.body)).kind === 'merge')).toBe(true)
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
    const transport = new LocalContainerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await transport.dispatch({ runId: 'run-1', jobId: 'run-1-spec' }, {}, 'spec')
    await transport.dispatch({ runId: 'run-1', jobId: 'run-1-architect' }, {}, 'explore')
    // The second step re-attaches to the run's container — only one `docker run`.
    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(1)
    expect(calls.find((c) => c[0] === 'run')!).toContain('cat-factory.runId=run-1')

    await transport.poll({ runId: 'run-1', jobId: 'run-1-architect' })
    expect(jobPaths).toContain('/jobs/run-1-architect')
  })

  it('sends every dispatch kind to /jobs with the kind in the body', async () => {
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
    const transport = new LocalContainerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'a', jobId: 'a' }, {}, 'blueprint')
    await transport.dispatch({ runId: 'b', jobId: 'b' }, {}, 'ci-fix')
    await transport.dispatch({ runId: 'c', jobId: 'c' }, {}, 'resolve-conflicts')
    expect(posted).toEqual([
      { path: '/jobs', kind: 'blueprint' },
      { path: '/jobs', kind: 'ci-fix' },
      { path: '/jobs', kind: 'resolve-conflicts' },
    ])
  })

  it('runs the tester job privileged (Docker-in-Docker) but no other kind', async () => {
    const { exec, calls } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = new LocalContainerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 't', jobId: 't' }, {}, 'test')
    await transport.dispatch({ runId: 'r', jobId: 'r' }, {}, 'run')
    const testRun = calls.find((c) => c[0] === 'run' && c.includes('cat-factory.runId=t'))!
    const codeRun = calls.find((c) => c[0] === 'run' && c.includes('cat-factory.runId=r'))!
    expect(testRun).toContain('--privileged')
    expect(codeRun).not.toContain('--privileged')
  })

  it('omits --privileged for the tester when privilegedTestJobs is disabled', async () => {
    const { exec, calls } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = new LocalContainerRunnerTransport({
      image: 'harness:test',
      privilegedTestJobs: false,
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 't', jobId: 't' }, {}, 'test')
    expect(calls.find((c) => c[0] === 'run')!).not.toContain('--privileged')
  })

  it('sizes the job container from the dispatch instanceSize', async () => {
    const { exec, calls } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = new LocalContainerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'big', jobId: 'big' }, {}, 'run', { instanceSize: 'large' })
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
    const transport = new LocalContainerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'job-9', jobId: 'job-9' }, {}, 'run')
    const view = await transport.poll({ runId: 'job-9', jobId: 'job-9' })
    expect(view.state).toBe('done')
    expect(view.result?.prUrl).toBe('https://x/pr/1')
  })

  it('reports an eviction when no container exists for the job', async () => {
    // ps returns nothing → the job has no container.
    const { exec } = fakeDocker({ ps: '' })
    const transport = new LocalContainerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: (() => {
        throw new Error('should not fetch')
      }) as unknown as typeof fetch,
    })
    const view = await transport.poll({ runId: 'ghost', jobId: 'ghost' })
    expect(view.state).toBe('failed')
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
    const transport = new LocalContainerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'job-x', jobId: 'job-x' }, {}, 'run')
    const view = await transport.poll({ runId: 'job-x', jobId: 'job-x' })
    expect(view.state).toBe('failed')
    expect(view.error).toMatch(/container evicted or crashed/)
  })

  it('release force-removes the job container and is a no-op when absent', async () => {
    const { exec, calls } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = new LocalContainerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'job-r', jobId: 'job-r' }, {}, 'run')
    await transport.release({ runId: 'job-r', jobId: 'job-r' })
    expect(calls.some((c) => c[0] === 'rm' && c.includes('container-abc'))).toBe(true)

    // A second release (now uncached, ps empty) does not throw.
    const empty = fakeDocker({ ps: '' })
    const t2 = new LocalContainerRunnerTransport({ image: 'i', exec: empty.exec })
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
    const transport = new LocalContainerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'job-404', jobId: 'job-404' }, {}, 'run')
    const view = await transport.poll({ runId: 'job-404', jobId: 'job-404' })
    expect(view.state).toBe('failed')
    expect(view.error).toMatch(/container evicted or crashed/)
  })

  it('throws (does not evict) when dispatch gets a non-OK HTTP response', async () => {
    const { exec } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      return new Response('boom', { status: 500 })
    })
    const transport = new LocalContainerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(
      transport.dispatch({ runId: 'job-500', jobId: 'job-500' }, {}, 'run'),
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
    const transport = new LocalContainerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch({ runId: 'job-stale', jobId: 'job-stale' }, {}, 'run')
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
    const transport = new LocalContainerRunnerTransport({ image: 'harness:test', exec })
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
    const transport = new LocalContainerRunnerTransport({ image: 'harness:test', exec })
    expect(await transport.reapExited()).toBe(0)
    expect(calls.some((c) => c[0] === 'rm')).toBe(false)
  })
})
