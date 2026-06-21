import { afterEach, describe, expect, it, vi } from 'vitest'
import { type DockerExec, LocalDockerRunnerTransport } from './LocalDockerRunnerTransport.js'

// Unit coverage for the local Docker transport with the docker CLI + fetch injected,
// so it runs anywhere (no Docker daemon, no Postgres). It asserts the container
// lifecycle (run → port → health → dispatch), idempotent re-attach by label, the
// kind→route mapping, and the eviction mapping a vanished container produces.

/** A scripted docker CLI: records calls and returns canned stdout per subcommand. */
function fakeDocker(overrides: Partial<Record<string, string>> = {}) {
  const calls: string[][] = []
  const exec: DockerExec = (args) => {
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

describe('LocalDockerRunnerTransport', () => {
  it('starts a labelled container, waits for health, then POSTs the job to the kind route', async () => {
    const { exec, calls } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.endsWith('/run')) return jsonResponse({ jobId: 'job-1', state: 'running' }, 202)
      throw new Error(`unexpected fetch ${url}`)
    })
    const transport = new LocalDockerRunnerTransport({
      image: 'harness:test',
      sharedSecret: 'sek',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await transport.dispatch('job-1', { hello: 'world' }, 'run')

    const runCall = calls.find((c) => c[0] === 'run')!
    expect(runCall).toContain('--label')
    expect(runCall).toContain('cat-factory.jobId=job-1')
    expect(runCall.join(' ')).toContain('-p 127.0.0.1:0:8080')
    expect(runCall.join(' ')).toContain('HARNESS_SHARED_SECRET=sek')
    expect(runCall).toContain('harness:test')

    const post = fetchImpl.mock.calls.find(([u]) => String(u).endsWith('/run'))!
    expect(String(post[0])).toBe('http://127.0.0.1:49170/run')
    const init = post[1] as RequestInit
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-harness-secret']).toBe('sek')
    expect(init.body).toBe('{"hello":"world"}')
  })

  it('re-attaches to an existing container (idempotent dispatch) without a second docker run', async () => {
    // First dispatch starts the container; the second resolves it from the cache.
    const { exec, calls } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = new LocalDockerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await transport.dispatch('job-1', {}, 'merge')
    await transport.dispatch('job-1', {}, 'merge')

    expect(calls.filter((c) => c[0] === 'run')).toHaveLength(1)
    // The merge kind maps to the /merge route.
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).endsWith('/merge'))).toHaveLength(2)
  })

  it('maps each dispatch kind to its harness route', async () => {
    const { exec } = fakeDocker()
    const routes: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      routes.push(new URL(url).pathname)
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = new LocalDockerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch('a', {}, 'blueprint')
    await transport.dispatch('b', {}, 'ci-fix')
    await transport.dispatch('c', {}, 'resolve-conflicts')
    expect(routes).toEqual(['/blueprint', '/ci-fix', '/resolve-conflicts'])
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
    const transport = new LocalDockerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch('job-9', {}, 'run')
    const view = await transport.poll('job-9')
    expect(view.state).toBe('done')
    expect(view.result?.prUrl).toBe('https://x/pr/1')
  })

  it('reports an eviction when no container exists for the job', async () => {
    // ps returns nothing → the job has no container.
    const { exec } = fakeDocker({ ps: '' })
    const transport = new LocalDockerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: (() => {
        throw new Error('should not fetch')
      }) as unknown as typeof fetch,
    })
    const view = await transport.poll('ghost')
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
    const transport = new LocalDockerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch('job-x', {}, 'run')
    const view = await transport.poll('job-x')
    expect(view.state).toBe('failed')
    expect(view.error).toMatch(/container evicted or crashed/)
  })

  it('release force-removes the job container and is a no-op when absent', async () => {
    const { exec, calls } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = new LocalDockerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch('job-r', {}, 'run')
    await transport.release('job-r')
    expect(calls.some((c) => c[0] === 'rm' && c.includes('container-abc'))).toBe(true)

    // A second release (now uncached, ps empty) does not throw.
    const empty = fakeDocker({ ps: '' })
    const t2 = new LocalDockerRunnerTransport({ image: 'i', exec: empty.exec })
    await expect(t2.release('missing')).resolves.toBeUndefined()
  })

  it('maps a 404 job view (container up, job unknown/reaped) to an eviction', async () => {
    const { exec } = fakeDocker()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.includes('/jobs/')) return new Response('not found', { status: 404 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = new LocalDockerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch('job-404', {}, 'run')
    const view = await transport.poll('job-404')
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
    const transport = new LocalDockerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(transport.dispatch('job-500', {}, 'run')).rejects.toThrow(/HTTP 500/)
  })

  it('removes a lingering container for the same job id before starting a fresh one', async () => {
    // resolve() returns undefined (ps finds an id but `port` is unmapped → exited), so
    // dispatch must `rm -f` the stale container before `docker run`.
    let firstPortLookup = true
    const calls: string[][] = []
    const exec: DockerExec = (args) => {
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
    const transport = new LocalDockerRunnerTransport({
      image: 'harness:test',
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await transport.dispatch('job-stale', {}, 'run')
    // The stale container was force-removed, then a fresh one was started.
    expect(calls.some((c) => c[0] === 'rm' && c.includes('stale-container'))).toBe(true)
    expect(calls.some((c) => c[0] === 'run')).toBe(true)
  })

  it('reapExited force-removes exited managed containers and returns the count', async () => {
    const calls: string[][] = []
    const exec: DockerExec = (args) => {
      calls.push(args)
      if (args[0] === 'ps') return Promise.resolve({ stdout: 'c1\nc2\n', stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    }
    const transport = new LocalDockerRunnerTransport({ image: 'harness:test', exec })
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
    const transport = new LocalDockerRunnerTransport({ image: 'harness:test', exec })
    expect(await transport.reapExited()).toBe(0)
    expect(calls.some((c) => c[0] === 'rm')).toBe(false)
  })
})
