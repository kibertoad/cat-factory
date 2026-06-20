import { Container } from '@cloudflare/containers'
import type { StopParams } from '@cloudflare/containers'
import type { Env } from '../env'

/** DO-storage key recording when a new-version rollout last drained this container. */
const ROLLED_OUT_AT_KEY = 'rolledOutAt'
/** How long after a rollout a 404 poll is still attributed to it (ms). */
const ROLLOUT_ATTRIBUTION_WINDOW_MS = 120_000

/**
 * Whether a container error/stop is the runtime's *new-version rollout* signal — a
 * deploy draining the old container (exit 143) — rather than a crash/OOM. The
 * @cloudflare/containers base class surfaces this through `onError` with the wording
 * "...new version rollout: 143" (which its own exit-code parser, keyed on the plain
 * "runtime signalled the container to exit:" form, does not recognise).
 */
export function isRolloutSignal(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
  return /new version rollout|runtime signalled the container to exit/i.test(message)
}

// One container instance per run: Cloudflare Containers map a Durable Object id
// to a dedicated container, so addressing `env.EXEC_CONTAINER.get(<executionId>)`
// gives each execution its own ephemeral sandbox. The container runs the Pi
// coding-agent harness (see @cat-factory/executor-harness) listening on 8080;
// the base `Container.fetch` proxies inbound requests there once it has booted.
//
// No secrets are configured here: the image carries none, and the per-job GitHub
// token + LLM session token are passed in the `/run` request body at dispatch
// time, never via image build args or class-level env vars.
export class ExecutionContainer extends Container<Env> {
  // The harness HTTP server port (matches the Dockerfile ENTRYPOINT).
  override defaultPort = 8080
  // A run is dispatched, then polled every ~15s while its background job runs, so
  // the instance stays warm for the job's duration without holding a single
  // request open. This idle window only elapses once polling stops (the job has
  // finished); the headroom tolerates a transient gap between polls without the
  // instance being reclaimed mid-job.
  override sleepAfter = '10m'

  /**
   * Record that THIS run's container was drained by a new-version rollout (a deploy,
   * exit 143) rather than crashing. The transport's next job poll — which 404s once
   * the container restarts empty — reads this via {@link recentlyRolledOut} to
   * classify the eviction as a transient rollout, so the engine recovers it on the
   * larger rollout budget instead of failing the run as a crash. Persisted to DO
   * storage (not in-memory) so it survives a DO isolate reset that a combined
   * worker+container deploy would cause.
   */
  override async onError(error: unknown): Promise<unknown> {
    if (isRolloutSignal(error)) {
      await this.ctx.storage.put(ROLLED_OUT_AT_KEY, Date.now())
    }
    // Preserve the base behaviour (log + rethrow) so nothing else changes.
    return super.onError(error)
  }

  /**
   * Belt-and-braces: depending on the runtime version, a rollout drain can surface
   * as a `runtime_signal` stop with SIGTERM (143) through `onStop` instead of (or as
   * well as) `onError`. Record it the same way.
   */
  override onStop(params: StopParams): void {
    if (params.reason === 'runtime_signal' && params.exitCode === 143) {
      void this.ctx.storage.put(ROLLED_OUT_AT_KEY, Date.now())
    }
  }

  /**
   * Whether this run's container was drained by a new-version rollout within the
   * last {@link ROLLOUT_ATTRIBUTION_WINDOW_MS}. Called over RPC by the transport
   * after a job poll 404s, to tell a transient rollout eviction apart from a
   * crash/OOM. Time-bounded so a stale flag from an earlier rollout in this run
   * can't misclassify a later genuine crash.
   */
  async recentlyRolledOut(): Promise<boolean> {
    const at = await this.ctx.storage.get<number>(ROLLED_OUT_AT_KEY)
    return typeof at === 'number' && Date.now() - at <= ROLLOUT_ATTRIBUTION_WINDOW_MS
  }

  /**
   * Reclaim this container now (SIGKILL via the base class), rather than waiting
   * for the `sleepAfter` idle timer. Called over RPC when a run faults so a leaked
   * instance isn't billed while idle. Best-effort and idempotent: destroying an
   * already-stopped container is a no-op, and we swallow any error so the caller's
   * failure handling is never derailed by cleanup.
   */
  async shutdown(): Promise<void> {
    try {
      await this.destroy()
    } catch {
      // Already gone / not running — nothing to reclaim.
    }
  }
}
