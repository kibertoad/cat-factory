import { Container } from '@cloudflare/containers'
import type { StopParams } from '@cloudflare/containers'
import type { Env } from '../env'
import { isRolloutSignal } from './ExecutionContainer'

/** DO-storage key recording when a new-version rollout last drained this container. */
const ROLLED_OUT_AT_KEY = 'rolledOutAt'
/** How long after a rollout a 404 poll is still attributed to it (ms). */
const ROLLOUT_ATTRIBUTION_WINDOW_MS = 120_000

// One DEPLOY container per run (addressed by the run id), mirroring {@link ExecutionContainer}
// but pulling the SEPARATE deploy-harness image (slim base + real `kubectl`/`kustomize`/`helm`)
// instead of the executor-harness. A Cloudflare Container's image is pinned per container class
// by the wrangler `[[containers]]` block, so the `image: 'deploy'` dispatch variant needs its own
// class — this one — bound as `DEPLOY_CONTAINER`. The transport routes a deploy job here while
// agent jobs stay on `EXEC_CONTAINER`, so the k8s CLIs never bloat an agent run's cold-start.
//
// The deploy harness serves the SAME `POST /jobs` + `GET /jobs/{id}` contract on 8080, so the
// generic `CloudflareContainerTransport` drives it unchanged (it just gets this namespace). As
// with the executor container, no long-lived secrets are configured: the per-job apiserver +
// git tokens arrive in the `/jobs` request body and the optional inbound-auth shared secret is
// the only class-level env var.
export class DeployContainer extends Container<Env> {
  // The deploy-harness HTTP server port (matches its Dockerfile EXPOSE/ENTRYPOINT).
  override defaultPort = 8080
  // Hand the inbound-auth shared secret to the harness when configured (it then rejects any
  // /jobs call without the matching `x-harness-secret` header the transport sends).
  override envVars: Record<string, string> = this.env.HARNESS_SHARED_SECRET
    ? { HARNESS_SHARED_SECRET: this.env.HARNESS_SHARED_SECRET }
    : {}
  // A deploy is dispatched then polled every ~15s while it renders + applies + waits on
  // rollout, so the instance stays warm for the job's duration; the idle window only elapses
  // once polling stops (the job finished).
  override sleepAfter = '10m'

  /**
   * Record that THIS run's deploy container was drained by a new-version rollout (exit 143)
   * rather than crashing, so the transport's next 404 poll classifies it as a transient
   * rollout eviction (recovered on the larger budget) instead of a crash. Mirrors
   * {@link ExecutionContainer.onError}.
   */
  override async onError(error: unknown): Promise<unknown> {
    if (isRolloutSignal(error)) {
      await this.ctx.storage.put(ROLLED_OUT_AT_KEY, Date.now())
    }
    return super.onError(error)
  }

  /** Belt-and-braces rollout capture via `onStop` (see {@link ExecutionContainer.onStop}). */
  override onStop(params: StopParams): void {
    if (params.reason === 'runtime_signal' && params.exitCode === 143) {
      void this.ctx.storage.put(ROLLED_OUT_AT_KEY, Date.now())
    }
  }

  /** Whether this run's deploy container was rolled out within the attribution window. */
  async recentlyRolledOut(): Promise<boolean> {
    const at = await this.ctx.storage.get<number>(ROLLED_OUT_AT_KEY)
    return typeof at === 'number' && Date.now() - at <= ROLLOUT_ATTRIBUTION_WINDOW_MS
  }

  /** Reclaim this container now (SIGKILL via the base class) rather than idling out. */
  async shutdown(): Promise<void> {
    try {
      await this.destroy()
    } catch {
      // Already gone / not running — nothing to reclaim.
    }
  }
}
