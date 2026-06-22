import type { RunnerDispatchKind, RunnerJobView, RunnerTransport } from '@cat-factory/kernel'
import { TRANSIENT_EVICTION_MARKER } from '@cat-factory/orchestration'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import { type ExecutionContainer, isRolloutSignal } from './ExecutionContainer'
import type { ContainerInstanceRegistry } from './ContainerInstanceRegistry'

// The failed-poll error string the engine classifies as a container eviction. The
// "(container evicted or crashed)" suffix is matched by job.logic
// `isContainerEvictionError` (and the bootstrap flow). When THIS facade knows the
// eviction was a transient new-version rollout (not a crash), it appends the
// engine's neutral TRANSIENT_EVICTION_MARKER so `isTransientEviction` recovers it on
// the larger budget. The Cloudflare-specific "rollout ⇒ transient" mapping lives
// here, in the facade; the engine stays runtime-neutral.
const EVICTION_ERROR = 'Job not found (container evicted or crashed)'
const ROLLOUT_EVICTION_ERROR = `${EVICTION_ERROR} (${TRANSIENT_EVICTION_MARKER})`

// The default runner transport: a per-run Cloudflare Container. Each job is one
// Durable Object instance keyed by the job id (the execution/bootstrap job id); the
// base Container.fetch proxies to the Pi harness inside it. This is the behaviour
// the ContainerAgentExecutor had inline before the transport seam was introduced —
// preserved here, including the idempotent re-attach (a replayed dispatch for the
// same id re-attaches to the running job) and the eviction→failed mapping on a 404
// poll. Every dispatch kind (`run` | `blueprint` | `bootstrap`) hits the matching
// harness endpoint identically; the bootstrapper rides this transport rather than
// hand-rolling its own EXEC_CONTAINER plumbing.
//
// It also folds in instance-level reaping: when a ContainerInstanceRegistry is
// wired, dispatch records the container in the live inventory and release clears it
// (through the registry's single kill path), so a cron reaper can backstop anything
// that outlived its lifetime — covering run/blueprint/bootstrap with no per-flow
// wiring.

// The harness `/run`, `/blueprint`, `/bootstrap` and `/jobs/{id}` calls are quick
// (start a background job / read its state), so they get a short timeout. The long
// work is bounded container-side by the job's inactivity + max-duration watchdogs.
const DISPATCH_TIMEOUT_MS = 30_000
const POLL_TIMEOUT_MS = 30_000

export class CloudflareContainerTransport implements RunnerTransport {
  constructor(
    private readonly namespace: DurableObjectNamespace<ExecutionContainer>,
    /** Live-container inventory + reaper kill path; absent in tests (reaping off). */
    private readonly registry?: ContainerInstanceRegistry,
  ) {}

  // NB: the `RunnerDispatchOptions` (provisioning hints) the port allows are
  // intentionally ignored here. A Cloudflare Container's instance type is fixed per
  // container class by the wrangler `[[containers]] instance_type` — there is no
  // per-DO/per-request sizing API — so a resolved instance-type id is meaningless on
  // this backend. Per-service sizing applies only to the backends that can honour it
  // (the self-hosted pool and the local Docker transport).
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
      throw new Error(`Container dispatch failed (HTTP ${res.status}): ${await safeText(res)}`)
    }
    // Record the now-live container so the reaper can find it if its run record
    // ever diverges from reality. Best-effort — the registry swallows store errors.
    await this.registry?.register(jobId, kind)
  }

  async poll(jobId: string): Promise<RunnerJobView> {
    const stub = this.namespace.get(this.namespace.idFromName(jobId))
    let res: Response
    try {
      res = await stub.fetch(`http://container/jobs/${encodeURIComponent(jobId)}`, {
        method: 'GET',
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      })
    } catch (err) {
      // A rollout in flight can make the container fetch itself throw the runtime's
      // "new version rollout" signal (exit 143) rather than returning a 404. Report it
      // as a transient rollout eviction so the engine recovers it on the larger
      // rollout budget instead of failing the run.
      if (isRolloutSignal(err)) return { state: 'failed', error: ROLLOUT_EVICTION_ERROR }
      throw err
    }
    if (res.status === 404) {
      // The job/container vanished (eviction or crash): report failed so the run
      // stops (the run-sweeper may then re-drive it from durable state). The trailing
      // "(container evicted or crashed)" is matched by the bootstrap flow to classify
      // the fault as `evicted`. Ask the DO whether it was just drained by a
      // new-version rollout (a deploy) — if so, tag it so the engine treats it as
      // transient infra churn rather than a crash/OOM.
      const rolledOut = await stub.recentlyRolledOut().catch(() => false)
      return { state: 'failed', error: rolledOut ? ROLLOUT_EVICTION_ERROR : EVICTION_ERROR }
    }
    if (!res.ok) {
      throw new Error(`Container job poll failed (HTTP ${res.status}): ${await safeText(res)}`)
    }
    return (await res.json()) as RunnerJobView
  }

  /**
   * Reclaim the per-run container now (SIGKILL via the DO's `shutdown` RPC) instead
   * of waiting for its idle `sleepAfter`, and drop its live-inventory row. Called
   * when a run is stopped/cancelled, succeeds/fails, or its block is deleted.
   * Best-effort and idempotent: shutting down an already-gone container is a no-op.
   */
  async release(jobId: string): Promise<void> {
    if (this.registry) {
      // The registry owns the single kill path (shutdown + inventory removal).
      await this.registry.release(jobId)
      return
    }
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
