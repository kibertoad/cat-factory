import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalProcessRunnerTransport, resolveHarnessEntry } from './LocalProcessRunnerTransport.js'

// Coverage for the NATIVE local transport (LOCAL_NATIVE_AGENTS): it runs the harness as a
// host process and drives it over HTTP. spawn + fetch + the port picker are injected so it
// runs with no real process. The harness's ambient-auth + CLI behaviour is the harness's
// own concern (covered there); here we assert the process lifecycle + HTTP plumbing.

/** A fake child process: an EventEmitter with a kill() that emits `exit`. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { kill: () => void }
  child.kill = vi.fn(() => child.emit('exit', 0))
  return child
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => vi.restoreAllMocks())

describe('LocalProcessRunnerTransport', () => {
  it('spawns the harness once, waits for health, then POSTs jobs (process reused across runs)', async () => {
    const child = fakeChild()
    const spawnImpl = vi.fn((_cmd: string, _args: readonly string[], _opts: unknown) => child)
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ jobId: 'j', state: 'running' }, 202)
    })
    const transport = new LocalProcessRunnerTransport({
      harnessEntry: '/path/server.js',
      sharedSecret: 'sek',
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pickPort: async () => 54321,
    })

    await transport.dispatch({ runId: 'r1', jobId: 'j1' }, { hello: 'world' }, 'agent')
    await transport.dispatch({ runId: 'r2', jobId: 'j2' }, {}, 'agent')

    // One long-lived process, reused for both runs.
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    const [node, args, opts] = spawnImpl.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ]
    expect(node).toBe(process.execPath)
    expect(args).toEqual(['/path/server.js'])
    expect(opts.env.PORT).toBe('54321')
    expect(opts.env.HARNESS_SHARED_SECRET).toBe('sek')
    // Jobs POST to the picked port with the kind in the body.
    const posts = fetchImpl.mock.calls.filter(([u]) => String(u).endsWith('/jobs'))
    expect(posts).toHaveLength(2)
    expect(String(posts[0]![0])).toBe('http://127.0.0.1:54321/jobs')
    expect(JSON.parse(String((posts[0]![1] as RequestInit).body)).kind).toBe('agent')
  })

  it('polls a job through the harness port', async () => {
    const child = fakeChild()
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.includes('/jobs/'))
        return jsonResponse({ state: 'done', result: { prUrl: 'https://x/1' } })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = new LocalProcessRunnerTransport({
      harnessEntry: '/h.js',
      spawnImpl: (() => child) as unknown as typeof import('node:child_process').spawn,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pickPort: async () => 6000,
    })
    await transport.dispatch({ runId: 'r', jobId: 'j' }, {}, 'agent')
    const view = await transport.poll({ runId: 'r', jobId: 'j' })
    expect(view.state).toBe('done')
    expect(view.result?.prUrl).toBe('https://x/1')
  })

  it('reports an eviction when the harness process has exited', async () => {
    const child = fakeChild()
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = new LocalProcessRunnerTransport({
      harnessEntry: '/h.js',
      spawnImpl: (() => child) as unknown as typeof import('node:child_process').spawn,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pickPort: async () => 6001,
    })
    await transport.dispatch({ runId: 'r', jobId: 'j' }, {}, 'agent')
    child.emit('exit', 1) // the harness process crashed
    const view = await transport.poll({ runId: 'r', jobId: 'j' })
    expect(view.state).toBe('failed')
    expect(view.error).toMatch(/container evicted or crashed/)
  })

  it('forwards the harness/ambientAuth fields the executor set (no injection, no rewrite)', async () => {
    const child = fakeChild()
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      if (String(input).endsWith('/health')) return new Response('ok', { status: 200 })
      return jsonResponse({ state: 'running' }, 202)
    })
    const transport = new LocalProcessRunnerTransport({
      harnessEntry: '/h.js',
      spawnImpl: (() => child) as unknown as typeof import('node:child_process').spawn,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pickPort: async () => 6002,
    })
    await transport.dispatch(
      { runId: 'r', jobId: 'j' },
      { harness: 'claude-code', ambientAuth: true, mode: 'coding' },
      'agent',
    )
    const post = fetchImpl.mock.calls.find(([u]) => String(u).endsWith('/jobs'))!
    const body = JSON.parse(String((post[1] as RequestInit).body))
    expect(body.harness).toBe('claude-code')
    expect(body.ambientAuth).toBe(true)
  })
})

describe('resolveHarnessEntry', () => {
  it('uses an explicit LOCAL_HARNESS_ENTRY verbatim (trimmed)', () => {
    expect(resolveHarnessEntry({ LOCAL_HARNESS_ENTRY: '  /custom/server.js  ' })).toBe(
      '/custom/server.js',
    )
  })

  it('falls back to the bundled @cat-factory/executor-harness server entry when unset', () => {
    // No env override → resolves the package that ships as a dependency of local-server, so a
    // fresh install runs native mode with no configuration (mirrors LOCAL_HARNESS_IMAGE).
    const entry = resolveHarnessEntry({})
    expect(entry).toMatch(/executor-harness[\\/].*server\.js$/)
  })
})
