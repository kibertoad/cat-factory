import { Container } from '@cloudflare/containers'
import type { StopParams } from '@cloudflare/containers'
import type { Env } from '../env'
import {
  type ContainerStopCause,
  isRolloutSignal,
  recordStopCause,
  type StopCauseStorage,
  takeStopCause,
} from './stopCause'

/**
 * The behaviour every per-run Cloudflare Container shares: one Durable Object instance per run
 * id hosts that run's sequence of jobs, the harness listens on 8080, and the base
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
  override defaultPort = 8080

  // When configured, hand the inbound-auth shared secret to the harness so it rejects any /jobs
  // call that doesn't present the matching `x-harness-secret` header (which the transport
  // sends). Omitted when unset, leaving the harness open as before.
  override envVars: Record<string, string> = this.env.HARNESS_SHARED_SECRET
    ? { HARNESS_SHARED_SECRET: this.env.HARNESS_SHARED_SECRET }
    : {}

  // A job is dispatched, then polled every ~15s while it runs, so the instance stays warm for
  // the job's duration without holding a single request open. Polling is the ONLY thing that
  // keeps it warm, which is why an elapsed window is recorded as a reclaim cause rather than
  // left to read as a crash. See `onActivityExpired`.
  override sleepAfter = '10m'

  /**
   * Record that THIS run's container was drained by a new-version rollout (a deploy, exit 143)
   * rather than crashing. The transport's next job poll (which 404s once the container restarts
   * empty) reads this back through {@link recentEvictionCause}, so the engine
   * recovers it on the larger transient budget instead of failing the run as a crash.
   * Persisted to DO storage (not in-memory) so it survives the isolate reset a combined
   * worker+container deploy causes.
   */
  override async onError(error: unknown): Promise<unknown> {
    if (isRolloutSignal(error)) await this.record('rollout')
    // Preserve the base behaviour (log + rethrow) so nothing else changes.
    return super.onError(error)
  }

  /**
   * Belt-and-braces: depending on the runtime version, a rollout drain can surface as a
   * `runtime_signal` stop with SIGTERM (143) through `onStop` instead of (or as well as)
   * `onError`. Record it the same way.
   */
  override onStop(params: StopParams): void {
    if (params.reason === 'runtime_signal' && params.exitCode === 143) {
      void this.record('rollout')
    }
  }

  /**
   * The idle window elapsed. Record it as the reclaim cause it is, then reclaim as the base
   * class would.
   *
   * This container is kept warm ONLY by the driver's job polls, so reaching here means the
   * backend stopped polling for longer than `sleepAfter` while it still believed the job was
   * running: a poll-scheduling hiccup, not the workload dying. Unrecorded, the resulting 404
   * poll is indistinguishable from an OOM: it spends the single crash-eviction budget, and a
   * second hiccup in the same step then fails a healthy run (stuck-run audit F12).
   *
   * Nothing is recorded when the container is already gone: the base class stops nothing in
   * that case, so a marker would be attributing a reclaim that never happened.
   */
  override async onActivityExpired(): Promise<void> {
    if (this.ctx.container?.running) await this.record('idle')
    await super.onActivityExpired()
  }

  /**
   * Why this run's container went away, for the transport to read over RPC after a job poll
   * 404s: the one thing that tells a reclaim apart from a crash. `undefined` means no reclaim
   * this container observed explains the 404, so the caller reports a crash. Consuming, see
   * {@link takeStopCause}.
   */
  async recentEvictionCause(): Promise<ContainerStopCause | undefined> {
    return takeStopCause(this.storage, Date.now())
  }

  /**
   * Reclaim this container now (SIGKILL via the base class), rather than waiting for the
   * `sleepAfter` idle timer. Called over RPC when a run settles or faults, so a leaked instance
   * isn't billed while idle. Best-effort and idempotent: destroying an already-stopped
   * container is a no-op, and we swallow any error so the caller's failure handling is never
   * derailed by cleanup.
   */
  async shutdown(): Promise<void> {
    try {
      await this.destroy()
    } catch {
      // silent-catch-ok: already gone / not running, so there is nothing to reclaim and nothing
      // for an operator to do about it.
    }
  }

  private record(cause: ContainerStopCause): Promise<void> {
    return recordStopCause(this.storage, cause, Date.now())
  }

  /** The DO storage, narrowed to what the stop-cause bookkeeping uses. */
  private get storage(): StopCauseStorage {
    return this.ctx.storage as unknown as StopCauseStorage
  }
}
