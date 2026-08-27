import {
  composePostMortem,
  CONTAINER_EVICTION_ERROR,
  HARNESS_SHUTDOWN_ERROR,
  harnessDispatchError,
  readRunnerDispatchAck,
  type RunnerDispatchAck,
  type RunnerDispatchKind,
  type RunnerJobRef,
  type RunnerJobStopOutcome,
  type RunnerJobView,
  type RunnerTransport,
  containerKeyForRef,
} from '@cat-factory/kernel'
import type { DurableObjectId, DurableObjectStub } from '@cloudflare/workers-types'
import type { RunContainer } from './RunContainer'
import type { ResolveRunContainerNamespace, RunContainerNamespace } from './runContainerNamespace'
import {
  type ContainerStopCause,
  describeContainerExit,
  isRolloutSignal,
  type StopObservation,
} from './stopCause'
import type { ContainerInstanceRegistry } from './ContainerInstanceRegistry'

// The human-readable message for a failed poll the transport maps to a container eviction. The
// eviction verdict the engine acts on rides the STRUCTURED `RunnerJobView.evicted` field
// (`crash` / `transient`) minted alongside it. The "(container evicted or crashed)" wording and
// the parenthetical each cause adds are DESCRIPTIVE context only, no longer regex-classified by
// any consumer (error-message coverage I5). Which Cloudflare events count as transient churn is
// decided HERE, in the facade; the engine stays runtime-neutral.
const EVICTION_ERROR = CONTAINER_EVICTION_ERROR
const ROLLOUT_EVICTION_ERROR = `${EVICTION_ERROR} (transient infrastructure eviction)`
// An idle reclaim is churn too, but a DIFFERENT operator's problem from a release draining a
// container: it says the driver stopped polling for longer than the container's idle window,
// so the remedy is the poll scheduling, not the deploy. Both recover on the transient budget;
// only the wording tells them apart, and a shared one would hide a recurring hiccup behind
// "there must have been a deploy" (stuck-run audit F12).
const IDLE_EVICTION_ERROR = `${EVICTION_ERROR} (idle container reclaimed between polls)`

/**
 * Every cause a container can OBSERVE about its own reclaim is infrastructure churn, so the
 * table maps each to its wording and the verdict is `transient` for all of them. Exhaustive by
 * type, so a new cause cannot ship without deciding what the operator is told about it.
 */
const TRANSIENT_EVICTION_ERROR: Record<ContainerStopCause, string> = {
  rollout: ROLLOUT_EVICTION_ERROR,
  idle: IDLE_EVICTION_ERROR,
}

/**
 * The failed view for a 404 poll, given what the container itself observed about its stop.
 *
 * The two halves of that observation answer different questions and are read independently. The
 * `cause` decides the VERDICT: no observed cause ⇒ the container is simply gone with nothing to
 * explain it, which is a `crash` (an OOM, a genuine fault) and recovers on the small budget. The
 * `exit` state decides the DETAIL, and is attached whether or not a cause was recognised: on a
 * runtime that cannot hand a log tail back to the Worker it is the only post-mortem there is,
 * and a crash is exactly the case with no cause to name (finding D1).
 *
 * Independent does not mean unaware of each other. The cause is handed to the detail's wording
 * so the two cannot contradict: the same reclaim that mints the `transient` verdict here is
 * performed with a SIGKILL, and an exit code read as if nothing else explained it would tell the
 * operator "out-of-memory kill" directly underneath "idle container reclaimed between polls".
 */
function evictionView(observed: StopObservation): RunnerJobView {
  const detail = composePostMortem([describeContainerExit(observed.exit, observed.cause)])
  const { cause, expiredCause, exit } = observed
  // A workload that EXITED 0 with the job still in flight did not crash and was not reclaimed:
  // the harness was shut down, and the run is over rather than one container short. Read only
  // where nothing else explains the stop: a reclaim we performed is a SIGKILL and never lands
  // here as a 0 (`observationForStop` records nothing for a stop this container asked for), and
  // a cause that IS named is churn, which recovers. Local's container/native transports read the
  // same fact off their own runtimes; the wording and the field come from kernel so all three
  // report one thing.
  //
  // "Named" includes a cause whose attribution window has passed (`expiredCause`), which the
  // exit's own, much wider window routinely outlives: a drain the harness answered by exiting 0
  // and a poll that lands minutes later is the ORDINARY shape of a rollout discovered by a
  // re-driven run, and reading it here as a shutdown would fail a healthy run outright where
  // expiry alone only costs it the larger budget.
  if (!cause && !expiredCause && exit?.reason === 'exit' && exit.code === 0) {
    return {
      state: 'failed',
      error: HARNESS_SHUTDOWN_ERROR,
      harnessShutdown: true,
      ...(detail ? { detail } : {}),
    }
  }
  return {
    state: 'failed',
    error: cause ? TRANSIENT_EVICTION_ERROR[cause] : EVICTION_ERROR,
    evicted: cause ? 'transient' : 'crash',
    ...(detail ? { detail } : {}),
  }
}

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
// A stop, unlike those two, deliberately WAITS: the harness holds the response until the aborted
// job has actually settled (up to its own ~6s force-kill window), because the caller's whole
// question is whether the agent is still running. Sized to clear that with room to spare.
const STOP_TIMEOUT_MS = 30_000

// Inbound-auth header the harness checks when HARNESS_SHARED_SECRET is configured
// (matches the harness server + the local Docker transport). Sent on every harness
// call so a container that requires the secret accepts the Worker's dispatch/poll.
const HARNESS_SECRET_HEADER = 'x-harness-secret'

/**
 * The resolver a transport DEDICATED to one container class is built with: the deploy adapter's,
 * and every test that drives the transport over a single fake namespace. It ignores the variant
 * because such a transport is chosen by its caller, not by the job.
 *
 * It lives beside the transport rather than beside the resolver TYPE because constructing one is
 * its only purpose.
 */
export function fixedContainerNamespace(
  namespace: RunContainerNamespace,
): ResolveRunContainerNamespace {
  return () => namespace
}

export class CloudflareContainerTransport implements RunnerTransport {
  /** Backend id recorded in run diagnostics (per-run Cloudflare Container). */
  readonly backend = 'cloudflare-container'

  constructor(
    // Which per-run container class serves a given image variant. Every class (executor, UI
    // tester, deploy harness) exposes the same `/jobs` HTTP contract on the harness port plus
    // `recentStopObservation`/`shutdown`, so this transport drives any of them unchanged: a
    // deploy-dedicated instance is simply built over a resolver pinned to that one namespace.
    private readonly resolveNamespace: ResolveRunContainerNamespace,
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

  /**
   * The Durable Object id addressing this job's container: the class that serves the ref's image
   * variant, named by `containerKeyForRef`.
   *
   * Both halves of that come off the REF, which is why the variant rides there rather than only
   * on the dispatch options: `poll`, `release` and `stopJob` get no options, and a run whose
   * `tester-ui` step sits in its own container would otherwise be polled at the container its
   * coder step is running in, reading as an evicted job while the browser one worked on.
   */
  private stubFor(ref: RunnerJobRef): {
    id: DurableObjectId
    stub: DurableObjectStub<RunContainer>
  } {
    const namespace = this.resolveNamespace(ref.image ?? 'default')
    const id = namespace.idFromName(containerKeyForRef(ref))
    return { id, stub: namespace.get(id) as DurableObjectStub<RunContainer> }
  }

  // NB: the SIZING hints in `RunnerDispatchOptions` are intentionally ignored here. A
  // Cloudflare Container's instance type is fixed per container class by the wrangler
  // `[[containers]] instance_type`, with no per-DO/per-request sizing API, so a resolved
  // instance-type id is meaningless on this backend. Per-service sizing applies only to the
  // backends that can honour it (the self-hosted pool and the local Docker transport).
  //
  // The `image` hint is NOT in that group: it selects the container class, which this backend
  // does honour. It is read off the REF rather than the options, so `poll`/`release`/`stopJob`
  // (which get no options) address the same container the dispatch started.
  async dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind = 'agent',
  ): Promise<RunnerDispatchAck | undefined> {
    // The container is per-RUN AND per image variant, so every step of a run on the same image
    // dispatches to the same instance; the harness keys the job by `ref.jobId` (in the spec
    // body), unique per step, so siblings never collide in its registries. A step declaring a
    // different image gets its own container, which is why the inventory key below is the
    // variant-qualified one rather than the bare run id.
    const { stub } = this.stubFor(ref)
    // One harness endpoint for every kind: POST /jobs with the kind in the body. The
    // harness reads `kind` to pick the validator + registry; the rest is the job spec.
    const res = await stub.fetch('http://container/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.secretHeader() },
      body: JSON.stringify({ ...spec, kind }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      // A structured DispatchError (carrying the HTTP status) so the engine + the bootstrap /
      // env-config services classify this as a `dispatch` failure by field, not by regex; a 404
      // (harness image too old to know the /jobs route) elaborates to the stale-image remedy.
      throw harnessDispatchError({
        label: 'Container',
        status: res.status,
        body: await safeText(res),
      })
    }
    // Record the now-live container (keyed by the run id, the idFromName argument) so
    // the reaper can find it if its run record ever diverges from reality. Idempotent
    // across a run's steps — the store preserves the earliest startedAt for a key.
    // Best-effort — the registry swallows store errors.
    await this.registry?.register({ containerKey: containerKeyForRef(ref), kind, image: ref.image })
    // The harness's capability handshake rides the acceptance body. Read AFTER the registry
    // write so a malformed/absent body can never cost the reaper its record of a live container.
    return readRunnerDispatchAck(await safeJson(res))
  }

  /**
   * The failed view for a container that has gone away, spending whatever the container recorded
   * about its own reclaim.
   *
   * BOTH eviction paths funnel through here, including the one that already knows the cause from
   * the thrown rollout signal, because the claim is not only how the cause is read: it is how a
   * record is marked spent. A path that reported an eviction without claiming would leave the
   * record behind to excuse a second one.
   *
   * Claiming is best-effort. An unreachable DO answers nothing, which reads as the crash it may
   * well have been, and a container mid-rollout drain routinely is unreachable — so the cause the
   * transport OBSERVED itself wins over a read that could not happen.
   */
  private async evictionOf(
    stub: { recentStopObservation: (jobId: string) => Promise<StopObservation> },
    ref: RunnerJobRef,
    observed?: ContainerStopCause,
  ): Promise<RunnerJobView> {
    const claimed = await stub.recentStopObservation(ref.jobId).catch(() => ({}) as StopObservation)
    // The transport's own observation wins for the CAUSE (see above); the exit state can only
    // ever come from the container, so it rides through whichever way the cause was decided.
    return evictionView({ ...claimed, ...(observed ? { cause: observed } : {}) })
  }

  async poll(ref: RunnerJobRef): Promise<RunnerJobView> {
    // The per-run container is the Durable Object addressed by the run id; its DO id is
    // the closest thing to a stable "container id" to surface in the run's details (a
    // Cloudflare Container has no public URL). Derived here so the executor can show WHICH
    // container the run is on. Cheap (no extra round-trip): `idFromName` is local.
    const { id: doId, stub } = this.stubFor(ref)
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
      if (isRolloutSignal(err)) return this.evictionOf(stub, ref, 'rollout')
      throw err
    }
    if (res.status === 404) {
      // The job/container vanished (eviction or crash): report failed so the run
      // stops (the run-sweeper may then re-drive it from durable state). The eviction
      // verdict rides the STRUCTURED `evicted` field the caller reads directly (the
      // "(container evicted or crashed)" string is descriptive context only — no consumer
      // regex-matches it any more, see I5). Ask the DO what it observed about its own reclaim
      // (a new-version rollout, or its idle window elapsing between polls). Either is infra
      // churn the engine should ride out on the larger transient budget rather than spend the
      // crash budget on.
      return this.evictionOf(stub, ref)
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
      await this.registry.release(containerKeyForRef(ref), ref.image)
      return
    }
    const { stub } = this.stubFor(ref)
    await stub.shutdown()
  }

  /**
   * Stop ONE job and confirm it. Always answers `stopped`, because this backend owns the container
   * the job runs in: the graceful path asks the harness to abort that job and wait for it to
   * settle, and anything else escalates to reclaiming the container, which stops everything inside
   * it.
   *
   * Escalating is right here and only here. A per-run container serves ONE run, and the caller
   * that reaches for this has already failed the run, so there is no sibling step left to protect;
   * what the escalation buys is the difference between telling a human "the agent is stopped" and
   * telling them to go and look.
   */
  async stopJob(ref: RunnerJobRef): Promise<RunnerJobStopOutcome> {
    const { stub } = this.stubFor(ref)
    try {
      const res = await stub.fetch(`http://container/jobs/${encodeURIComponent(ref.jobId)}`, {
        method: 'DELETE',
        headers: this.secretHeader(),
        signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
      })
      // A 404 is not a stop: the container may simply have been recreated under the same DO name,
      // in which case nothing here has been asked to stop anything. Fall through to the reclaim.
      if (res.ok) {
        const body = (await safeJson(res)) as { state?: unknown } | undefined
        if (body?.state !== 'running') return 'stopped'
      }
    } catch (error) {
      // A drained/rolled-out container throws rather than answering; its job is gone with it, so
      // that IS the stop. Anything else falls through to the reclaim below.
      if (isRolloutSignal(error)) return 'stopped'
    }
    await this.release(ref)
    return 'stopped'
  }
}

/**
 * The acceptance body as JSON, or undefined for anything unreadable. Never throws: the job is
 * already accepted by the time this runs, so a body this transport cannot parse must degrade to
 * "no handshake" (which the dispatch site reads as unknown) rather than fail a live dispatch.
 */
async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return '(no body)'
  }
}
