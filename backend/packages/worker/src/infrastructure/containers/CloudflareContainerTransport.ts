import type { RunnerDispatchKind, RunnerJobView, RunnerTransport } from '@cat-factory/kernel'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type { ImplementationContainer } from './ImplementationContainer'

// The default runner transport: a per-run Cloudflare Container. Each job is one
// Durable Object instance keyed by the job id (the execution id); the base
// Container.fetch proxies to the Pi harness inside it. This is the behaviour the
// ContainerAgentExecutor had inline before the transport seam was introduced —
// it is preserved byte-for-byte here, including the idempotent re-attach (a
// replayed `/run` for the same id re-attaches to the running job) and the
// eviction→failed mapping on a 404 poll.

// The harness `/run` and `/jobs/{id}` calls are quick (start a background job /
// read its state), so they get a short timeout. The long coding work is bounded
// container-side by the job's inactivity + max-duration watchdogs, not here.
const DISPATCH_TIMEOUT_MS = 30_000
const POLL_TIMEOUT_MS = 30_000

export class CloudflareContainerTransport implements RunnerTransport {
  constructor(private readonly namespace: DurableObjectNamespace<ImplementationContainer>) {}

  async dispatch(
    jobId: string,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind = 'run',
  ): Promise<void> {
    const stub = this.namespace.get(this.namespace.idFromName(jobId))
    const res = await stub.fetch(`http://container/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(
        `Implementation container dispatch failed (HTTP ${res.status}): ${await safeText(res)}`,
      )
    }
  }

  async poll(jobId: string): Promise<RunnerJobView> {
    const stub = this.namespace.get(this.namespace.idFromName(jobId))
    const res = await stub.fetch(`http://container/jobs/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    })
    if (res.status === 404) {
      // The job/container vanished (eviction or crash): report failed so the run
      // stops (the run-sweeper may then re-drive it from durable state).
      return {
        state: 'failed',
        error: 'Implementation job not found (container evicted or crashed)',
      }
    }
    if (!res.ok) {
      throw new Error(`Implementation job poll failed (HTTP ${res.status}): ${await safeText(res)}`)
    }
    return (await res.json()) as RunnerJobView
  }

  /**
   * Reclaim the per-run container now (SIGKILL via the DO's `shutdown` RPC) instead
   * of waiting for its idle `sleepAfter`. Called when a run is stopped/cancelled or
   * its block is deleted. Best-effort and idempotent: shutting down an already-gone
   * container is a no-op (the base class swallows it).
   */
  async release(jobId: string): Promise<void> {
    const stub = this.namespace.get(this.namespace.idFromName(jobId))
    await stub.shutdown()
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return '(no body)'
  }
}
