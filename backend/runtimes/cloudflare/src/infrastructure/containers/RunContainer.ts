import { Container } from '@cloudflare/containers'
import type { StopParams } from '@cloudflare/containers'
import { HARNESS_JOB_PORT } from '@cat-factory/contracts'
import { runBestEffort } from '@cat-factory/kernel'
import { harnessGitLabHost } from '@cat-factory/server'
import type { Env } from '../env'
import { loadGitLabConfig } from '../config/gitlab'
import { logger } from '../observability/logger'
import {
  clearStopCause,
  isRolloutSignal,
  observationForStop,
  recordStopCause,
  type StopCauseStorage,
  type StopObservation,
  takeStopCause,
} from './stopCause'

/**
 * The behaviour every per-run Cloudflare Container shares: one Durable Object instance per run
 * id hosts that run's sequence of jobs, the harness listens on {@link HARNESS_JOB_PORT}, and the base
 * `Container.fetch` proxies inbound requests there once it has booted.
 *
 * The two concrete classes ({@link import('./ExecutionContainer').ExecutionContainer} and
 * {@link import('./DeployContainer').DeployContainer}) exist only because a Cloudflare
 * Container's IMAGE is pinned per container class by the wrangler `[[containers]]` block. They
 * are two bindings onto one behaviour, which is why that behaviour lives here rather than being
 * kept in step by hand across both.
 *
 * No long-lived secrets are configured: the image carries none, and every per-job credential
 * (the VCS token, the LLM session token, an apiserver token) arrives in the `/jobs` request
 * body at dispatch time. The one exception is `HARNESS_SHARED_SECRET` below, an inbound-auth
 * shared secret rather than a tenant credential.
 */
export abstract class RunContainer extends Container<Env> {
  /** The harness HTTP server port (matches each image's Dockerfile ENTRYPOINT/EXPOSE). */
  override defaultPort = HARNESS_JOB_PORT

  override envVars: Record<string, string> = runContainerEnv(this.env)

  // A job is dispatched, then polled every ~15s while it runs, so the instance stays warm for
  // the job's duration without holding a single request open. Polling is the ONLY thing that
  // keeps it warm, which is why an elapsed window is recorded as a reclaim cause rather than
  // left to read as a crash. See `onActivityExpired`.
  override sleepAfter = '10m'

  /**
   * Whether the stop this container is about to observe is one WE asked for: the idle reclaim in
   * {@link onActivityExpired} and the deliberate teardown in {@link shutdown}, both of which stop
   * the container by signalling it.
   *
   * It exists because the resulting exit state is evidence about nothing. We sent the signal, so
   * the code that comes back describes our own request (and escalates to a SIGKILL 137 whenever
   * the harness does not exit inside the platform's grace period), while the account the run
   * actually needs is the cause already recorded beside it. Left recorded, that exit is read back
   * as the container's cause of death and reported as "most often an out-of-memory kill" under a
   * verdict that says the platform reclaimed an idle container.
   *
   * In-memory rather than persisted, and reset by {@link onStart}: it describes ONE stop of ONE
   * container life, and the isolate cannot outlive the stop it is set for. A container that comes
   * back up has a real death ahead of it again.
   */
  private selfInitiatedStop = false

  /**
   * A container life is starting, so nothing from here on is a stop we asked for.
   *
   * The base class flushes any deferred `onStop` from the PREVIOUS life before it calls this, so
   * the reset can never land between a self-initiated stop and the hook that observes it.
   */
  override async onStart(): Promise<void> {
    this.selfInitiatedStop = false
    await super.onStart()
  }

  /**
   * Record that THIS run's container was drained by a new-version rollout (a deploy, exit 143)
   * rather than crashing. The transport's next job poll (which 404s once the container restarts
   * empty) reads this back through {@link recentStopObservation}, so the engine
   * recovers it on the larger transient budget instead of failing the run as a crash.
   * Persisted to DO storage (not in-memory) so it survives the isolate reset a combined
   * worker+container deploy causes.
   */
  override async onError(error: unknown): Promise<unknown> {
    if (isRolloutSignal(error)) await this.record({ cause: 'rollout' })
    // Preserve the base behaviour (log + rethrow) so nothing else changes.
    return super.onError(error)
  }

  /**
   * Record EVERY stop, with whatever this hook can say about it.
   *
   * Two things ride the same write. A `runtime_signal` SIGTERM (143) is a rollout drain, which
   * depending on the runtime version surfaces here instead of (or as well as) through `onError`,
   * so it is recorded as that cause the same way. And the `{ exitCode, reason }` pair itself is
   * recorded for every stop, cause or not, because it is the ONLY account of a death this
   * runtime can keep: a Cloudflare Container's stdout goes to the deployment's Workers logs and
   * nothing here can read it back, so without this an OOM-killed agent reaches the operator as
   * "container evicted or crashed" and nothing else (finding D1).
   *
   * Recording an exit changes no verdict: the transient/crash classification still comes from
   * the cause alone, so a plain crash keeps spending the crash budget and merely says why.
   *
   * A stop WE asked for is the exception, and records nothing. Its exit state is the echo of our
   * own signal rather than an observation, and the cause that explains it has already been
   * recorded by whoever asked (see {@link selfInitiatedStop}).
   *
   * Both rules live in {@link observationForStop}, beside the other half of "what does this stop
   * mean" (`isRolloutSignal`) and where a plain unit test can reach them: nothing in this class
   * can be exercised without a real Durable Object.
   */
  override async onStop(params: StopParams): Promise<void> {
    const observed = observationForStop(params, this.selfInitiatedStop)
    if (observed) await this.record(observed)
  }

  /**
   * The idle window elapsed. Record it as the reclaim cause it is, then reclaim as the base
   * class would.
   *
   * This container is kept warm ONLY by the driver's job polls, so an idle expiry with a job
   * still outstanding means the backend stopped polling for longer than `sleepAfter`: a
   * poll-scheduling hiccup, not the workload dying. Unrecorded, the resulting 404 poll is
   * indistinguishable from an OOM: it spends the single crash-eviction budget, and a second
   * hiccup in the same step then fails a healthy run (stuck-run audit F12).
   *
   * This hook cannot tell that case from the ROUTINE one (the run parked on a human decision and
   * nothing is running), because only the harness knows whether a job is still live and asking
   * it would itself be activity. So the marker is minted for both, and what keeps that honest is
   * the boundary in {@link fetch}: the routine marker is dropped by the next dispatch, so it
   * cannot still be lying around to excuse the following step's crash.
   *
   * Nothing is recorded when the container is already gone: the base class stops nothing in
   * that case, so a marker would be attributing a reclaim that never happened.
   */
  override async onActivityExpired(): Promise<void> {
    if (this.ctx.container?.running) {
      await this.record({ cause: 'idle' })
      // The reclaim below is us signalling the container, so the exit it reports is our own
      // request coming back (a SIGKILL 137 whenever the harness does not exit inside the grace
      // period) and not a death to attribute. The cause just recorded is the whole account.
      this.selfInitiatedStop = true
    }
    await super.onActivityExpired()
  }

  /**
   * Proxy an inbound harness call, and take a JOB ACCEPTANCE as the end of whatever this
   * container previously observed about itself.
   *
   * A stop cause explains the death of a container that was serving the jobs outstanding when it
   * was recorded. `POST /jobs` answering 2xx says a new job starts here, so nothing recorded
   * before it can account for that job's death. Without the boundary the routine case poisons
   * the rare one: a run parks on a human decision, its container idles out with nothing running,
   * and the `idle` marker that leaves behind is still inside its (deliberately wide) window to
   * excuse a genuine OOM in the NEXT step as transient churn.
   *
   * It has to be the acceptance rather than the container starting: a 404 poll BOOTS the
   * container on its way to discovering the job is gone, so clearing on start would drop the
   * record moments before the read that exists to consume it.
   */
  override async fetch(request: Request): Promise<Response> {
    const res = await super.fetch(request)
    if (isJobDispatch(request) && res.ok) {
      // Best-effort: the job is accepted and running by now, so bookkeeping must never turn a
      // live dispatch into a failure. A drop is reported rather than swallowed, because the only
      // symptom otherwise is a crash quietly misread as churn some minutes later.
      await runBestEffort(logger, 'clear container stop cause on dispatch', () =>
        clearStopCause(this.storage),
      )
    }
    return res
  }

  /**
   * What this run's container observed about its own stop, for the transport to read over RPC
   * after `jobId`'s poll 404s: the `cause` that tells a reclaim apart from a crash, and the
   * `exit` state that is the only surviving account of the death itself. An EMPTY observation
   * means nothing this container saw explains that 404, so the caller reports a bare crash.
   *
   * Claimed by the polling job rather than deleted, so a retried durable poll step re-reads the
   * same answer while a different job still finds it spent. See {@link takeStopCause}.
   */
  async recentStopObservation(jobId: string): Promise<StopObservation> {
    return takeStopCause(this.storage, Date.now(), jobId)
  }

  /**
   * Reclaim this container now (SIGKILL via the base class), rather than waiting for the
   * `sleepAfter` idle timer. Called over RPC when a run settles or faults, so a leaked instance
   * isn't billed while idle. Best-effort and idempotent: destroying an already-stopped
   * container is a no-op, and we swallow any error so the caller's failure handling is never
   * derailed by cleanup.
   *
   * It is also where the stop record's life ENDS. A record is written on every stop and deleted
   * only when a NEW job is accepted, so without this the last one a run ever observed sits in
   * that run's Durable Object for good: the run is over, no dispatch is coming to clear it, and
   * the value is a diagnostic nobody will read again. Deleting it here is what keeps the whole
   * mechanism transient rather than a per-run key that accumulates for the lifetime of the
   * deployment.
   *
   * Ordered after the teardown so the destroy's own `onStop` cannot land behind the delete,
   * belt-and-braces with {@link selfInitiatedStop}, which stops that hook writing at all.
   */
  async shutdown(): Promise<void> {
    this.selfInitiatedStop = true
    try {
      await this.destroy()
    } catch {
      // silent-catch-ok: already gone / not running, so there is nothing to reclaim and nothing
      // for an operator to do about it.
    }
    // Best-effort: the container is reclaimed either way, and a retained key is a tidiness
    // problem, never a correctness one. Reported rather than swallowed so a storage backend
    // failing every delete does not stay invisible.
    await runBestEffort(logger, 'clear container stop cause on shutdown', () =>
      clearStopCause(this.storage),
    )
  }

  private record(observed: StopObservation): Promise<void> {
    return recordStopCause(this.storage, observed, Date.now())
  }

  /** The DO storage, narrowed to what the stop-cause bookkeeping uses. */
  private get storage(): StopCauseStorage {
    return this.ctx.storage as unknown as StopCauseStorage
  }
}

/**
 * Whether an inbound request is the transport starting a job (`POST /jobs`), as opposed to
 * polling or stopping one (`GET`/`DELETE /jobs/{id}`).
 *
 * The harness route is matched here rather than announced over a separate RPC because the
 * dispatch already passes through this object, and an extra round trip would be one more thing
 * that can fail between "job accepted" and "record cleared". The URL is parsed rather than
 * string-compared so a query string or a trailing slash cannot make a dispatch look like
 * something else.
 */
function isJobDispatch(request: Request): boolean {
  if (request.method !== 'POST') return false
  try {
    return new URL(request.url).pathname.replace(/\/+$/, '') === '/jobs'
  } catch {
    // silent-catch-ok: an unparseable URL is not a dispatch, which is the whole question here.
    return false
  }
}

/**
 * The harness clone-host allow-list entry this deployment needs, as env, or `{}` when it reaches
 * no GitLab instance. Read straight off `Env` rather than through `loadConfig`, which validates
 * the encryption key and the App private key and would turn an unrelated misconfiguration into a
 * container that cannot start.
 */
function harnessHostEnv(env: Env): Record<string, string> {
  const host = harnessGitLabHost(loadGitLabConfig(env))
  return host ? { GITHUB_ALLOWED_HOSTS: host } : {}
}

/**
 * The container env every per-run Cloudflare Container is started with.
 *
 * A free function rather than an inline initializer because it is the only place the Worker states
 * what the job container's environment IS, and an initializer reading `this.env` can only be
 * evaluated by standing up a Durable Object.
 *
 * Two values are omitted when unset, so the harness keeps its own defaults:
 *
 *  - `HARNESS_SHARED_SECRET`: inbound auth, so the harness rejects any /jobs call that does not
 *    present the matching `x-harness-secret` header (which the transport sends).
 *  - `GITHUB_ALLOWED_HOSTS`: the harness will only send a clone/push credential to a host on its
 *    allow-list, which defaults to github.com. A GitLab deployment's clone URL is therefore
 *    refused at checkout unless its instance is named here. It is the sibling of
 *    `deploymentRepoOrigin`, derived from the same `GITLAB_API_BASE` inversion so the host
 *    dispatched to and the host allowed cannot disagree. (Local mode's `harnessAllowedHosts` is
 *    the same widening on the transport it owns.)
 *
 * `PORT` is the exception: always stated, and last, so nothing above can disagree with the
 * {@link RunContainer.defaultPort} the class addresses. Left unset, the two are joined only by the
 * image happening to default to the same number, and a deployment pins its OWN mirrored image tag
 * in the wrangler `[[containers]]` block. One left on a tag from before the harness port moved
 * would bind its own default, answer nothing on `defaultPort`, and surface as a container that
 * never became ready. The Kubernetes pod spec and the local container adapters state it the same
 * way, so no facade leaves the served port to the image.
 */
export function runContainerEnv(env: Env): Record<string, string> {
  return {
    ...(env.HARNESS_SHARED_SECRET ? { HARNESS_SHARED_SECRET: env.HARNESS_SHARED_SECRET } : {}),
    ...harnessHostEnv(env),
    PORT: String(HARNESS_JOB_PORT),
  }
}
