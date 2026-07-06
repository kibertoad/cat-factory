import type {
  RunnerDispatchKind,
  RunnerJobRef,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import { TRANSIENT_EVICTION_MARKER } from '@cat-factory/orchestration'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type { DeployContainer } from './DeployContainer'
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

// The default runner transport: a per-RUN Cloudflare Container. One Durable Object
// instance per run id (`ref.runId`) hosts that run's whole sequence of step jobs; the
// base Container.fetch proxies to the Pi harness inside it, which keys each job by the
// per-step `ref.jobId`. This is the behaviour the ContainerAgentExecutor had inline
// before the transport seam was introduced — preserved here, including the idempotent
// re-attach (a replayed dispatch for the same ref re-attaches to the running job) and
// the eviction→failed mapping on a 404 poll. Every dispatch kind (`run` | `blueprint`
// | `bootstrap` | …) hits the same harness endpoint (`POST /jobs`, with the kind in
// the body) identically; the bootstrapper rides this transport rather than
// hand-rolling its own EXEC_CONTAINER plumbing.
//
// It also folds in instance-level reaping: when a ContainerInstanceRegistry is
// wired, dispatch records the container in the live inventory and release clears it
// (through the registry's single kill path), so a cron reaper can backstop anything
// that outlived its lifetime — covering run/blueprint/bootstrap with no per-flow
// wiring.

// The harness `POST /jobs` and `GET /jobs/{id}` calls are quick (start a background
// job / read its state), so they get a short timeout. The long work is bounded
// container-side by the job's inactivity + max-duration watchdogs.
const DISPATCH_TIMEOUT_MS = 30_000
const POLL_TIMEOUT_MS = 30_000

// Inbound-auth header the harness checks when HARNESS_SHARED_SECRET is configured
// (matches the harness server + the local Docker transport). Sent on every harness
// call so a container that requires the secret accepts the Worker's dispatch/poll.
const HARNESS_SECRET_HEADER = 'x-harness-secret'

export class CloudflareContainerTransport implements RunnerTransport {
  /** Backend id recorded in run diagnostics (per-run Cloudflare Container). */
  readonly backend = 'cloudflare-container'

  constructor(
    // Either per-run container class: `ExecutionContainer` (the agent harness, bound as
    // `EXEC_CONTAINER`) or `DeployContainer` (the deploy harness, bound as `DEPLOY_CONTAINER`).
    // Both expose the same `/jobs` HTTP contract on 8080 plus `recentlyRolledOut`/`shutdown`,
    // so this transport drives either unchanged — a deploy-dedicated instance simply gets the
    // deploy namespace.
    private readonly namespace:
      | DurableObjectNamespace<ExecutionContainer>
      | DurableObjectNamespace<DeployContainer>,
    /** Live-container inventory + reaper kill path; absent in tests (reaping off). */
    private readonly registry?: ContainerInstanceRegistry,
    /**
     * Optional inbound-auth shared secret. When set, it is also injected into the
     * container's env (see ExecutionContainer) so the harness requires it; the same
     * value is sent here as the `x-harness-secret` header. Unset ⇒ no header (the
     * harness stays open, relying on DO-internal addressing) — kept symmetric with
     * the local transport's behaviour.
     */
    private readonly sharedSecret?: string,
  ) {}

  /** Header bag for a harness call: the shared secret when configured, else empty. */
  private secretHeader(): Record<string, string> {
    return this.sharedSecret ? { [HARNESS_SECRET_HEADER]: this.sharedSecret } : {}
  }

  // NB: the `RunnerDispatchOptions` (provisioning hints) the port allows are
  // intentionally ignored here. A Cloudflare Container's instance type is fixed per
  // container class by the wrangler `[[containers]] instance_type` — there is no
  // per-DO/per-request sizing API — so a resolved instance-type id is meaningless on
  // this backend. Per-service sizing applies only to the backends that can honour it
  // (the self-hosted pool and the local Docker transport).
  async dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind = 'agent',
  ): Promise<void> {
    // The container is per-RUN (one Durable Object per run id), so every step of a run
    // dispatches to the same instance; the harness keys the job by `ref.jobId` (in the
    // spec body), unique per step, so siblings never collide in its registries.
    const stub = this.namespace.get(this.namespace.idFromName(ref.runId))
    // One harness endpoint for every kind: POST /jobs with the kind in the body. The
    // harness reads `kind` to pick the validator + registry; the rest is the job spec.
    const res = await stub.fetch('http://container/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.secretHeader() },
      body: JSON.stringify({ ...spec, kind }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`Container dispatch failed (HTTP ${res.status}): ${await safeText(res)}`)
    }
    // Record the now-live container (keyed by the run id, the idFromName argument) so
    // the reaper can find it if its run record ever diverges from reality. Idempotent
    // across a run's steps — the store preserves the earliest startedAt for a key.
    // Best-effort — the registry swallows store errors.
    await this.registry?.register(ref.runId, kind)
  }

  async poll(ref: RunnerJobRef): Promise<RunnerJobView> {
    // The per-run container is the Durable Object addressed by the run id; its DO id is
    // the closest thing to a stable "container id" to surface in the run's details (a
    // Cloudflare Container has no public URL). Derived here so the executor can show WHICH
    // container the run is on. Cheap (no extra round-trip): `idFromName` is local.
    const doId = this.namespace.idFromName(ref.runId)
    const stub = this.namespace.get(doId)
    let res: Response
    try {
      res = await stub.fetch(`http://container/jobs/${encodeURIComponent(ref.jobId)}`, {
        method: 'GET',
        headers: this.secretHeader(),
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
    // The harness view carries the live `phase`; fold in the container's id (the DO id)
    // so the run's details can name which container it's running on. No public URL exists
    // for a Cloudflare per-run Container, so `url` is left unset.
    const view = (await res.json()) as RunnerJobView
    return { ...view, container: { ...view.container, id: doId.toString() } }
  }

  /**
   * Reclaim the per-run container now (SIGKILL via the DO's `shutdown` RPC) instead
   * of waiting for its idle `sleepAfter`, and drop its live-inventory row. Called
   * when a run is stopped/cancelled, succeeds/fails, or its block is deleted.
   * Best-effort and idempotent: shutting down an already-gone container is a no-op.
   */
  async release(ref: RunnerJobRef): Promise<void> {
    // Reclaim the per-RUN container (the shutdown is run-scoped — `ref.jobId` is a
    // single step within it, so the whole run's container goes regardless).
    if (this.registry) {
      // The registry owns the single kill path (shutdown + inventory removal).
      await this.registry.release(ref.runId)
      return
    }
    const stub = this.namespace.get(this.namespace.idFromName(ref.runId))
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
