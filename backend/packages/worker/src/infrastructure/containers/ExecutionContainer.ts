import { Container } from '@cloudflare/containers'
import type { Env } from '../env'

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
