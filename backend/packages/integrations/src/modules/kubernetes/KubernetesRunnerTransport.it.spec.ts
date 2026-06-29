import type { RunnerJobRef } from '@cat-factory/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KubernetesRunnerTransport } from './KubernetesRunnerTransport.js'
import { podName } from './kubernetes.logic.js'
import {
  clusterSkipReason,
  deletePodQuietly,
  readClusterEnv,
  runnerConfig,
  tokenResolver,
  uniqueSuffix,
  waitForResolved,
} from './test-support/cluster.js'

// INTEGRATION: drives KubernetesRunnerTransport against a REAL k3d/Kubernetes apiserver, so
// the apiserver behaviours the unit test only mocks are validated for real — the per-run pod
// lifecycle, the pod-proxy subresource round-trip (POST /jobs + GET /jobs/:id reaching the
// in-pod mock harness), 409-idempotent re-attach, and the 404→eviction mapping after delete.
// Self-skips with a clear reason when `K8S_IT_*` is unset (see test-support/cluster.ts).

const env = readClusterEnv()
const skip = clusterSkipReason(env, { needsRunnerImage: true })

describe.skipIf(skip !== null)(
  `KubernetesRunnerTransport (k3d integration)${skip ? ` — ${skip}` : ''}`,
  () => {
    // The cluster env is present whenever this suite is NOT skipped. `describe.skipIf` still
    // runs this callback to collect the tests, so the env-dependent transport is built in
    // beforeAll (which IS skipped) rather than here, where `env` could still be null.
    const cluster = env as NonNullable<typeof env>
    let transport: KubernetesRunnerTransport
    const created: string[] = []

    beforeAll(() => {
      transport = new KubernetesRunnerTransport(runnerConfig(cluster), tokenResolver(cluster))
    })

    function freshRef(): RunnerJobRef {
      const runId = `it-${uniqueSuffix()}`
      created.push(podName(runId))
      return { runId, jobId: `${runId}-coder` }
    }

    afterAll(async () => {
      for (const name of created) await deletePodQuietly(cluster, name)
    })

    it('creates a per-run pod, reaches the harness via the pod-proxy, and round-trips the job view', async () => {
      const ref = freshRef()

      // dispatch creates the pod, waits for REAL readiness, then POSTs the job via the proxy.
      await transport.dispatch(ref, { mode: 'coding' }, 'agent')

      // poll fetches the harness view through the proxy — the mock echoes the dispatched body
      // back, proving the POST payload and the GET response both crossed the pod-proxy intact.
      const view = await transport.poll(ref)
      expect(view.state).toBe('done')
      const custom = (view.result as { custom?: Record<string, unknown> } | undefined)?.custom
      expect(custom?.jobId).toBe(ref.jobId)
      const dispatched = custom?.dispatched as { mode?: string; kind?: string } | undefined
      expect(dispatched?.mode).toBe('coding')
      expect(dispatched?.kind).toBe('agent')

      // A second dispatch for the SAME run is an idempotent re-attach (pod 409s, no throw).
      await expect(transport.dispatch(ref, { mode: 'coding' }, 'agent')).resolves.toBeUndefined()
    })

    it('schedules + serves a pod built with an instanceSize resource override', async () => {
      // A per-size override sets requests == limits (Guaranteed QoS). The unit test only
      // asserts the manifest's `resources` block is shaped right; this proves the
      // resource-bounded pod the apiserver actually admits still schedules on a real node
      // AND serves the harness through the pod-proxy. (Memory is generous enough not to OOM
      // the tiny Node mock; cpu is a request the single runner node trivially satisfies.)
      const sized = new KubernetesRunnerTransport(
        runnerConfig(cluster, { resourcesBySize: { small: { cpu: '100m', memory: '256Mi' } } }),
        tokenResolver(cluster),
      )
      const ref = freshRef()
      await sized.dispatch(ref, { mode: 'coding' }, 'agent', { instanceSize: 'small' })
      const view = await sized.poll(ref)
      expect(view.state).toBe('done')
    })

    it('releases the run pod, and a subsequent poll maps the proxy 404 to an eviction', async () => {
      const ref = freshRef()
      await transport.dispatch(ref, { mode: 'coding' }, 'agent')

      await transport.release(ref)

      // `release` issues a graceful pod DELETE, so the apiserver returns before the pod is
      // actually gone. As it terminates the pod-proxy passes through three phases: it still
      // reaches the harness (200), then — once the container has stopped but the pod object
      // lingers — returns a transient 502/503 dial error (which `poll` surfaces as a throw),
      // and only when the pod object is finally removed does it 404. Poll THROUGH that window
      // (tolerating the transient throws) until the transport maps the 404 to the recoverable
      // eviction the engine re-drives from, NOT a hard error.
      const afterRelease = await waitForResolved(
        () => transport.poll(ref),
        (v) => v.state === 'failed',
        { timeoutMs: 90_000, intervalMs: 2_000 },
      )
      expect(afterRelease.state).toBe('failed')
      expect(afterRelease.error).toMatch(/evicted or crashed/)

      // Releasing an already-gone pod is a no-op (real 404 tolerated).
      await expect(transport.release(ref)).resolves.toBeUndefined()
    })

    it('testConnection reaches the apiserver with the configured token', async () => {
      const result = await transport.testConnection()
      expect(result.ok).toBe(true)
    })
  },
)
