import type { KubernetesRunnerConfig, RunnerJobView } from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KubernetesRunnerTransport } from './KubernetesRunnerTransport.js'

const config: KubernetesRunnerConfig = {
  label: 'Test',
  apiServerUrl: 'https://k8s.example:6443',
  namespace: 'cat-factory',
  image: 'ghcr.io/acme/executor:1.0.0',
}

// runId '1' ⇒ pod name 'cf-run-1' (podName prefixes 'cf-run-').
const ref = { runId: '1', jobId: 'run-1-coder' }
const resolveSecret = (key: string) => (key === 'apiToken' ? 'sa-token' : undefined)

type Route = (method: string, url: string, init: RequestInit) => Response | undefined

/** Install a routing fetch stub; returns the recorded calls. */
function stubFetch(route: Route): { calls: Array<{ method: string; url: string }> } {
  const calls: Array<{ method: string; url: string }> = []
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ method, url })
    const res = route(method, url, init)
    return Promise.resolve(res ?? new Response('not routed', { status: 500 }))
  })
  return { calls }
}

// A fresh Response each call — a Response body can only be read once.
const runningReadyPod = () =>
  new Response(
    JSON.stringify({
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
    }),
    { status: 200 },
  )

afterEach(() => vi.unstubAllGlobals())

describe('KubernetesRunnerTransport.dispatch', () => {
  it('creates the per-run pod, waits for readiness, then POSTs the job via the proxy', async () => {
    const { calls } = stubFetch((method, url) => {
      if (method === 'POST' && url.endsWith('/pods')) return new Response('{}', { status: 201 })
      if (method === 'GET' && url.includes('/pods/cf-run-1') && !url.includes('/proxy')) {
        return runningReadyPod()
      }
      if (method === 'POST' && url.includes('/proxy/jobs')) {
        return new Response(JSON.stringify({ jobId: ref.jobId, state: 'running' }), { status: 202 })
      }
      return undefined
    })
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    await transport.dispatch(ref, { mode: 'coding' }, 'agent')

    expect(calls[0]).toMatchObject({ method: 'POST', url: expect.stringMatching(/\/pods$/) })
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('/pods/cf-run-1'))).toBe(true)
    // The pod-proxy name:port colon is sent LITERAL (kubectl/client-go do the same).
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('cf-run-1:8080/proxy/jobs'),
    })
  })

  it('treats a 409 AlreadyExists pod as an idempotent re-attach', async () => {
    stubFetch((method, url) => {
      if (method === 'POST' && url.endsWith('/pods')) return new Response('exists', { status: 409 })
      if (method === 'GET' && url.includes('/pods/cf-run-1') && !url.includes('/proxy')) {
        return runningReadyPod()
      }
      if (method === 'POST' && url.includes('/proxy/jobs'))
        return new Response('{}', { status: 202 })
      return undefined
    })
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    await expect(transport.dispatch(ref, {}, 'agent')).resolves.toBeUndefined()
  })
})

describe('KubernetesRunnerTransport.poll', () => {
  it('returns the harness job view verbatim through the proxy', async () => {
    const view: RunnerJobView = { state: 'done', result: { custom: { ok: true } } }
    stubFetch((method, url) =>
      method === 'GET' && url.includes('/proxy/jobs/')
        ? new Response(JSON.stringify(view), { status: 200 })
        : undefined,
    )
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    expect(await transport.poll(ref)).toEqual(view)
  })

  it('maps a 404 from the proxy to the eviction failure', async () => {
    stubFetch(() => new Response('not found', { status: 404 }))
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    const result = await transport.poll(ref)
    expect(result.state).toBe('failed')
    expect(result.error).toMatch(/evicted or crashed/)
  })
})

describe('KubernetesRunnerTransport.release', () => {
  it('deletes the run pod and tolerates a 404', async () => {
    const seen: string[] = []
    stubFetch((method, url) => {
      seen.push(`${method} ${url}`)
      return new Response('', { status: method === 'DELETE' ? 404 : 200 })
    })
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    await expect(transport.release(ref)).resolves.toBeUndefined()
    expect(seen.some((s) => s.startsWith('DELETE') && s.includes('/pods/cf-run-1'))).toBe(true)
  })

  it('throws on a non-404 delete failure so the leak is not swallowed', async () => {
    // A bare Pod is not GC'd, so a dropped delete leaks it — the failure must surface
    // (the LoggingRunnerTransport logs it) rather than report a false success.
    stubFetch((method) => new Response('forbidden', { status: method === 'DELETE' ? 403 : 200 }))
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    await expect(transport.release(ref)).rejects.toThrow(/403/)
  })
})

describe('KubernetesRunnerTransport.testConnection', () => {
  it('reports ok when the apiserver lists pods', async () => {
    stubFetch((method, url) =>
      method === 'GET' && url.includes('/pods?limit=1')
        ? new Response('{"items":[]}', { status: 200 })
        : undefined,
    )
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    const result = await transport.testConnection()
    expect(result.ok).toBe(true)
  })

  it('reports the failure when the apiserver rejects the token', async () => {
    stubFetch(() => new Response('Unauthorized', { status: 401 }))
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    const result = await transport.testConnection()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/401/)
  })
})
