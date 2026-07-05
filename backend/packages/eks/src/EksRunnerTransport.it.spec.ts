import type { RunnerJobRef } from '@cat-factory/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EksRunnerTransport } from './EksRunnerTransport.js'
import {
  awsSecretResolver,
  eksRunnerConfig,
  eksSkipReason,
  readEksClusterEnv,
  uniqueSuffix,
  waitForResolved,
} from './test-support/eks-cluster.js'

// INTEGRATION: drives EksRunnerTransport against a REAL apiserver fronted by an EKS-compatible
// API (a floci-emulated EKS cluster — real k3s — in CI). It reuses the entire native Kubernetes
// per-run-pod transport behind a MINTED IAM apiserver token, so this validates the same
// behaviours the Kubernetes suite does (per-run pod lifecycle, pod-proxy round-trip,
// 409-idempotent re-attach, 404→eviction) PLUS that the minted-token auth path reaches a real
// apiserver. The SigV4/STS minting correctness itself is pinned by the unit golden-vector test.
// Self-skips with a clear reason when `EKS_IT_*` is unset (see test-support/eks-cluster.ts).

const env = readEksClusterEnv()
const skip = eksSkipReason(env, { needsRunnerImage: true })

describe.skipIf(skip !== null)(
  `EksRunnerTransport (floci EKS integration)${skip ? ` — ${skip}` : ''}`,
  () => {
    const cluster = env as NonNullable<typeof env>
    let transport: EksRunnerTransport
    const created: RunnerJobRef[] = []

    beforeAll(() => {
      transport = new EksRunnerTransport(eksRunnerConfig(cluster), awsSecretResolver(cluster))
    })

    function freshRef(): RunnerJobRef {
      const runId = `eks-it-${uniqueSuffix()}`
      const ref = { runId, jobId: `${runId}-coder` }
      created.push(ref)
      return ref
    }

    afterAll(async () => {
      for (const ref of created) {
        try {
          await transport.release(ref)
        } catch {
          // cleanup is best-effort
        }
      }
    })

    it('mints an IAM token, creates a per-run pod, and round-trips the job via the pod-proxy', async () => {
      const ref = freshRef()
      await transport.dispatch(ref, { mode: 'coding' }, 'agent')

      const view = await transport.poll(ref)
      expect(view.state).toBe('done')
      const custom = (view.result as { custom?: Record<string, unknown> } | undefined)?.custom
      expect(custom?.jobId).toBe(ref.jobId)
      const dispatched = custom?.dispatched as { mode?: string; kind?: string } | undefined
      expect(dispatched?.mode).toBe('coding')
      expect(dispatched?.kind).toBe('agent')

      // Idempotent re-attach for the same run (pod 409s, no throw).
      await expect(transport.dispatch(ref, { mode: 'coding' }, 'agent')).resolves.toBeUndefined()
    })

    it('releases the run pod, and a subsequent poll maps the proxy 404 to an eviction', async () => {
      const ref = freshRef()
      await transport.dispatch(ref, { mode: 'coding' }, 'agent')
      await transport.release(ref)

      const afterRelease = await waitForResolved(
        () => transport.poll(ref),
        (v) => v.state === 'failed',
        { timeoutMs: 90_000, intervalMs: 2_000 },
      )
      expect(afterRelease.state).toBe('failed')
      expect(afterRelease.error).toMatch(/evicted or crashed/)

      await expect(transport.release(ref)).resolves.toBeUndefined()
    })

    it('testConnection reaches the apiserver with the minted IAM token', async () => {
      const result = await transport.testConnection()
      expect(result.ok).toBe(true)
    })
  },
)
