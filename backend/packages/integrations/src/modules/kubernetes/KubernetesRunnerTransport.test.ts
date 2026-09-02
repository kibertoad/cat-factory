import type { KubernetesRunnerConfig, RunnerJobView } from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_PORT } from './kubernetes.logic.js'
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

/**
 * Install a routing fetch stub; returns the recorded calls. A route that THROWS stands for a
 * transport failure (nothing answered), handed back as a rejection exactly as `fetch` does, so a
 * test about the failure path uses this one recorder too rather than a second hand-rolled stub.
 */
function stubFetch(route: Route): { calls: Array<{ method: string; url: string }> } {
  const calls: Array<{ method: string; url: string }> = []
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ method, url })
    try {
      const res = route(method, url, init)
      return Promise.resolve(res ?? new Response('not routed', { status: 500 }))
    } catch (err) {
      return Promise.reject(err)
    }
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
      url: expect.stringContaining(`cf-run-1:${DEFAULT_HARNESS_PORT}/proxy/jobs`),
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

  it('reports a pod whose workload exited 0 as a harness shutdown, not an eviction', async () => {
    // The parity that matters for a self-hosted deployment: the same agent cleanup command that
    // pattern-killed the harness in a Cloudflare container kills it in a runner pod, and the pod
    // reports the exit code that tells the two apart. Read as an eviction, the engine spends its
    // crash budget re-running the agent into the same wall and blames infrastructure.
    stubFetch((method, url) => {
      if (url.includes('/proxy/')) return new Response('not found', { status: 404 })
      if (method === 'GET' && url.includes('/pods/cf-run-1')) {
        return new Response(
          JSON.stringify({
            status: {
              phase: 'Succeeded',
              containerStatuses: [
                { name: 'executor', state: { terminated: { reason: 'Completed', exitCode: 0 } } },
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

    expect(result.state).toBe('failed')
    expect(result.harnessShutdown).toBe(true)
    // Never both: the engine's recovery is keyed on `evicted`, and a retry here walks back into
    // whatever stopped the harness.
    expect(result.evicted).toBeUndefined()
    expect(result.error).not.toMatch(/evicted or crashed/)
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

describe('KubernetesRunnerTransport pod replacement', () => {
  // A run's pod is created by its FIRST step, and the environment it must reach does not exist
  // until the `deployer` several steps later, so a pod that predates a needed host alias is the
  // ordinary case rather than an edge. `hostAliases` is fixed at creation, so the pod is replaced.
  const withEnvironment = {
    environments: [{ url: 'https://pr-14.test.example.cloud', address: '10.4.19.22' }],
  }

  /** A live pod that is READY and carries no host aliases: the state a replacement is needed in. */
  const readyPodWithoutAliases = () =>
    new Response(
      JSON.stringify({
        spec: {},
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
      }),
      { status: 200 },
    )

  it('deletes and recreates a pod created without a host alias the job now needs', async () => {
    let created = 0
    const { calls } = stubFetch((method, url) => {
      if (method === 'POST' && url.endsWith('/pods')) {
        created += 1
        // The first create 409s (the run's pod is already up from an earlier step); the recreate
        // after the delete succeeds.
        return created === 1
          ? new Response('AlreadyExists', { status: 409 })
          : new Response('{}', { status: 201 })
      }
      if (method === 'GET' && url.includes('/pods/cf-run-1') && !url.includes('/proxy')) {
        return readyPodWithoutAliases()
      }
      if (method === 'DELETE' && url.includes('/pods/cf-run-1')) {
        return new Response('', { status: 200 })
      }
      if (method === 'POST' && url.includes('/proxy/jobs')) {
        return new Response(JSON.stringify({ jobId: ref.jobId, state: 'running' }), { status: 202 })
      }
      return undefined
    })
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    await transport.dispatch(ref, { mode: 'coding' }, 'agent', withEnvironment)

    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/pods/cf-run-1'))).toBe(true)
    expect(created).toBe(2)
  })

  it('FAILS on a refused delete instead of retrying the create for the whole window', async () => {
    // The delete's result has to be read. Unchecked, a refusal (a ServiceAccount with `create` but
    // not `delete`, an admission webhook) leaves the pod running and the recreate spends the whole
    // 90-second replacement window collecting 409s before throwing an error naming the CREATE: a
    // minute and a half of the driver's budget, and an operator sent to the wrong permission.
    const { calls } = stubFetch((method, url) => {
      if (method === 'POST' && url.endsWith('/pods')) {
        return new Response('AlreadyExists', { status: 409 })
      }
      if (method === 'GET' && url.includes('/pods/cf-run-1') && !url.includes('/proxy')) {
        return readyPodWithoutAliases()
      }
      if (method === 'DELETE' && url.includes('/pods/cf-run-1')) {
        return new Response('pods is forbidden: cannot delete', { status: 403 })
      }
      return undefined
    })
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    await expect(
      transport.dispatch(ref, { mode: 'coding' }, 'agent', withEnvironment),
    ).rejects.toThrow(/Could not delete runner pod/)
    // ONE create attempt, not a window of them: the failure is the delete, and it is named as such.
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/pods'))).toHaveLength(1)
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

  it('names the EXACT transport failure and its remedy when nothing answered', async () => {
    // The regression this guards: a stopped cluster reported as the bare string `fetch failed`,
    // which is undici's wrapper and says nothing. The cause chain holds the real answer.
    stubFetch(() => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6443'), {
          code: 'ECONNREFUSED',
        }),
      })
    })
    const transport = new KubernetesRunnerTransport(config, resolveSecret)
    const result = await transport.testConnection()

    expect(result.ok).toBe(false)
    expect(result.message).toContain('ECONNREFUSED 127.0.0.1:6443')
    expect(result.message).not.toBe('fetch failed')
    // The remedy names the apiserver being probed, so the operator knows what to go start.
    expect(result.message).toContain('https://k8s.example:6443')
    expect(result.message).toContain('The Kubernetes apiserver is most likely not running')
    // The SPA renders its own translated headline off this, not the English sentence above.
    expect(result.failureCause).toBe('refused')
  })

  it('refuses a token carrying a line break BEFORE dialing, naming the paste', async () => {
    // A token copied across a wrapped terminal line. undici would reject the header with an
    // opaque `Invalid header value`; the refusal has to name the token and the fix instead.
    const { calls } = stubFetch(() => new Response('{"items":[]}', { status: 200 }))
    const transport = new KubernetesRunnerTransport(config, (key) =>
      key === 'apiToken' ? 'sa-\ntoken' : undefined,
    )
    const result = await transport.testConnection()

    expect(result.ok).toBe(false)
    expect(result.message).toContain('space or line break')
    // Nothing was sent: an unusable header must not reach the network at all.
    expect(calls).toEqual([])
  })

  it('sends a token that merely arrived with surrounding whitespace, having trimmed it', async () => {
    // The trap the guard alone left open: `classifyServiceAccountToken` judges the TRIMMED value,
    // so a token ending in a newline is NOT a bad paste. Building the header from the untrimmed
    // value still died in undici with the opaque error the guard exists to replace.
    const { calls } = stubFetch((method, url, init) => {
      const auth = new Headers(init.headers).get('authorization')
      if (method === 'GET' && url.includes('/pods') && auth === 'Bearer sa-token') {
        return new Response('{"items":[]}', { status: 200 })
      }
      return new Response('unexpected authorization header', { status: 401 })
    })
    const transport = new KubernetesRunnerTransport(config, (key) =>
      key === 'apiToken' ? '  sa-token\n' : undefined,
    )
    const result = await transport.testConnection()

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
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
