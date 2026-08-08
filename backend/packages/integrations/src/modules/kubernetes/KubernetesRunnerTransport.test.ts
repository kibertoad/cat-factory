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

  it('fails fast with the root cause (NOT a recoverable eviction) on an unpullable image', async () => {
    // The pod is created but the image can't be pulled, so it sits in ImagePullBackOff.
    // The transport must surface that reason at once and classify it as a hard `dispatch`
    // failure (no "evicted or crashed" marker) rather than poll for 120s and then re-drive
    // the same doomed pod forever.
    stubFetch((method, url) => {
      if (method === 'POST' && url.endsWith('/pods')) return new Response('{}', { status: 201 })
      if (method === 'GET' && url.includes('/pods/cf-run-1') && !url.includes('/proxy')) {
        return new Response(
          JSON.stringify({
            status: {
              phase: 'Pending',
              containerStatuses: [
                {
                  name: 'executor',
                  state: {
                    waiting: {
                      reason: 'ImagePullBackOff',
                      message: 'Back-off pulling image "ghcr.io/acme/executor:1.0.0"',
                    },
                  },
                },
              ],
            },
          }),
          { status: 200 },
        )
      }
      return undefined
    })
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    const err: Error = await transport.dispatch(ref, {}, 'agent').then(
      () => {
        throw new Error('dispatch unexpectedly resolved')
      },
      (e) => e as Error,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/failed to start: ImagePullBackOff: Back-off pulling image/)
    // NOT tagged recoverable — a bad image never self-heals, so it must hard-fail.
    expect(err.message).not.toMatch(/evicted or crashed/)
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

  it('maps a 404 from the proxy to the eviction failure (structured field + string fallback)', async () => {
    stubFetch(() => new Response('not found', { status: 404 }))
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    const result = await transport.poll(ref)
    expect(result.state).toBe('failed')
    // The structured verdict is the primary signal; the string suffix stays as the fallback.
    expect(result.evicted).toBe('crash')
    expect(result.error).toMatch(/evicted or crashed/)
  })

  it("reads the dead pod's termination state onto the eviction detail", async () => {
    // Finding D1: the pod OBJECT outlives its workload (`restartPolicy: Never`), so the kubelet's
    // account of the death is sitting one GET away and was never read. An OOM kill is otherwise
    // indistinguishable from an unexplained vanishing.
    stubFetch((method, url) => {
      if (url.includes('/proxy/')) return new Response('not found', { status: 404 })
      if (method === 'GET' && url.includes('/pods/cf-run-1')) {
        return new Response(
          JSON.stringify({
            status: {
              phase: 'Failed',
              containerStatuses: [
                {
                  name: 'executor',
                  state: { terminated: { reason: 'OOMKilled', exitCode: 137 } },
                },
              ],
            },
          }),
          { status: 200 },
        )
      }
      return undefined
    })
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    const result = await transport.poll(ref)

    // The verdict is untouched: a post-mortem explains a failure, it never reclassifies one.
    expect(result.evicted).toBe('crash')
    expect(result.detail).toContain('OOMKilled')
    expect(result.detail).toContain('exit code 137')
  })

  it('distinguishes a pod that is GONE from one that cannot be read', async () => {
    // Three outcomes, three investigations. A vanished pod was deleted or GC'd by something
    // outside the run; an apiserver that will not answer means nobody looked at all. Reporting
    // either as an absent detail makes an unreachable control plane read like a clean death.
    stubFetch((method, url) =>
      url.includes('/proxy/')
        ? new Response('not found', { status: 404 })
        : new Response('forbidden', { status: 403 }),
    )
    const transport = new KubernetesRunnerTransport(config, resolveSecret)

    expect((await transport.poll(ref)).detail).toContain('apiserver answered HTTP 403')
  })

  it('never lets the post-mortem read fail the poll', async () => {
    // A run that lost its container must still be FAILED, cause or no cause: this is a
    // best-effort diagnostic hanging off a terminal verdict, and the whole eviction-recovery
    // path depends on the verdict arriving.
    stubFetch((method, url) => {
      if (url.includes('/proxy/')) return new Response('not found', { status: 404 })
      throw new Error('apiserver connection reset')
    })
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    const result = await transport.poll(ref)

    expect(result.evicted).toBe('crash')
    expect(result.detail).toContain('connection reset')
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

describe('KubernetesRunnerTransport and the harness capability handshake', () => {
  /** Route a ready pod plus a harness acceptance carrying `capabilities`. */
  const readyPodServing = (acceptance: unknown): Route => {
    return (method, url) => {
      if (method === 'POST' && url.endsWith('/pods')) return new Response('{}', { status: 201 })
      if (method === 'GET' && url.includes('/pods/cf-run-1') && !url.includes('/proxy')) {
        return runningReadyPod()
      }
      if (method === 'POST' && url.includes('/proxy/jobs')) {
        return new Response(JSON.stringify(acceptance), { status: 202 })
      }
      return undefined
    }
  }

  it('forwards the ack, because it POSTs to the harness itself', async () => {
    // Unlike a manifest-driven pool, this transport talks to the harness through the apiserver
    // pod-proxy, so the acceptance body it reads IS the handshake. Dropping it would leave every
    // k8s/EKS deployment permanently `unknown`: warned on each capability dispatch against an
    // image that is current, and unable to ever refuse a genuinely blind one.
    stubFetch(readyPodServing({ jobId: ref.jobId, state: 'running', capabilities: ['mcpServers'] }))
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    expect(await transport.dispatch(ref, { mode: 'coding' }, 'agent')).toEqual({
      capabilities: ['mcpServers'],
    })
  })

  it('reports no handshake for an image that sent none, never an empty one', async () => {
    // `undefined` and `[]` are opposite verdicts downstream: the first proceeds with a warning,
    // the second REFUSES the run. An older image reports nothing and must get the first.
    stubFetch(readyPodServing({ jobId: ref.jobId, state: 'running' }))
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    expect(await transport.dispatch(ref, { mode: 'coding' }, 'agent')).toBeUndefined()
  })

  it('stops one job at the harness, and confirms it', async () => {
    const { calls } = stubFetch((method, url) => {
      if (method === 'DELETE' && url.includes(`/proxy/jobs/${ref.jobId}`)) {
        return new Response(JSON.stringify({ jobId: ref.jobId, state: 'failed' }), { status: 200 })
      }
      return undefined
    })
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    expect(await transport.stopJob(ref)).toBe('stopped')
    // The graceful path only: the pod is NOT deleted when the harness confirmed the abort, so the
    // run's remaining steps keep their warm pod.
    expect(calls.some((c) => c.method === 'DELETE' && !c.url.includes('/proxy'))).toBe(false)
  })

  it('escalates to deleting the pod when the harness cannot confirm the abort', async () => {
    // Confirming beats preserving the pod here: the only caller has already failed the run, and
    // the alternative is telling a human the agent is stopped when it may not be. A bare Pod is
    // not garbage-collected either, so giving up would leak it as well as the agent.
    const { calls } = stubFetch((method, url) => {
      if (method === 'DELETE' && url.includes('/proxy/jobs')) {
        return new Response('no such route', { status: 404 })
      }
      if (method === 'DELETE' && url.includes('/pods/cf-run-1')) {
        return new Response('{}', { status: 200 })
      }
      return undefined
    })
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    expect(await transport.stopJob(ref)).toBe('stopped')
    expect(calls.some((c) => c.method === 'DELETE' && !c.url.includes('/proxy'))).toBe(true)
  })

  it('escalates when the harness answers but the job is STILL running', async () => {
    // A signalled abort is not a stopped agent; the whole point of waiting is to tell them apart.
    const { calls } = stubFetch((method, url) => {
      if (method === 'DELETE' && url.includes('/proxy/jobs')) {
        return new Response(JSON.stringify({ jobId: ref.jobId, state: 'running' }), { status: 200 })
      }
      if (method === 'DELETE' && url.includes('/pods/cf-run-1')) {
        return new Response('{}', { status: 200 })
      }
      return undefined
    })
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    expect(await transport.stopJob(ref)).toBe('stopped')
    expect(calls.some((c) => c.method === 'DELETE' && !c.url.includes('/proxy'))).toBe(true)
  })
})
