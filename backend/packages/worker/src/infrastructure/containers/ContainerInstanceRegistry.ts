import type { Clock } from '@cat-factory/kernel'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type { ExecutionContainer } from './ExecutionContainer'
import { logger } from '../observability/logger'

// The instance-level reaping registry. Per-run Cloudflare Containers are addressed
// by a Durable Object id derived from the job id; nothing enumerates the live ones,
// so every safety net keyed off the run record instead of the real inventory (see
// migration 0022). This registry IS that inventory: the Cloudflare transport
// records a container here on dispatch and removes it on release, and a cron reaper
// kills anything that outlived its legitimate maximum lifetime — through the same
// EXEC_CONTAINER binding that started it, needing no Cloudflare API token.

/** One live per-run container, as the registry records it. */
export interface LiveContainerRecord {
  /** The idFromName() argument: the execution/bootstrap job id (also the run id). */
  containerKey: string
  /** The dispatch kind ('run' | 'blueprint' | 'bootstrap'); diagnostic only. */
  kind: string
  /** Owning workspace, when known (the transport seam carries only the job id). */
  workspaceId?: string
  /** Epoch ms of the FIRST dispatch = the container's true age. */
  startedAt: number
}

/**
 * Persistence for the live-container inventory (the `live_containers` table). `add`
 * MUST preserve the earliest `startedAt` for a key (a replayed dispatch is a no-op)
 * so the recorded age is the container's true age.
 */
export interface LiveContainerStore {
  add(record: LiveContainerRecord): Promise<void>
  remove(containerKey: string): Promise<void>
  listStartedBefore(epochMs: number): Promise<LiveContainerRecord[]>
}

/**
 * Owns the per-run container namespace + the live-container inventory. It is the
 * single kill path for a container — `release` both SIGKILLs the instance (via the
 * Durable Object's `shutdown` RPC) and clears its inventory row — used by the
 * normal terminal-reclaim path (through the Cloudflare transport) and by the cron
 * reaper alike, so the two can never diverge.
 */
export class ContainerInstanceRegistry {
  constructor(
    private readonly namespace: DurableObjectNamespace<ExecutionContainer>,
    private readonly store: LiveContainerStore,
    private readonly clock: Clock,
  ) {}

  /**
   * Record a freshly-dispatched container in the inventory. Best-effort: a write
   * failure must never break the dispatch it is bookkeeping for, and the earliest
   * `startedAt` is preserved across replayed dispatches (so age stays truthful).
   */
  async register(containerKey: string, kind: string, workspaceId?: string): Promise<void> {
    try {
      await this.store.add({ containerKey, kind, workspaceId, startedAt: this.clock.now() })
    } catch (error) {
      logger.warn(
        { containerKey, kind, err: errMessage(error) },
        'container-registry: failed to record live container (continuing)',
      )
    }
  }

  /**
   * Reclaim a container now and drop its inventory row — the single kill path.
   * Idempotent: `ExecutionContainer.shutdown` swallows "already gone", so this is a
   * no-op on a container that is already stopped. The row is removed only after the
   * SIGKILL resolves, so a (rare) transport-level failure leaves the row for the
   * reaper to retry rather than silently dropping a still-live container.
   */
  async release(containerKey: string): Promise<void> {
    await this.namespace.get(this.namespace.idFromName(containerKey)).shutdown()
    await this.store.remove(containerKey)
  }

  /**
   * The load-bearing backstop: kill every container whose first dispatch is older
   * than `epochMs` (its legitimate maximum lifetime has elapsed). With normal runs
   * self-reclaiming on their terminal path, a reaped container is a genuine LEAK, so
   * each kill is logged loudly. One wedged container never aborts the sweep — each
   * release is isolated. Returns how many were actually reaped.
   */
  async reapStaleBefore(epochMs: number): Promise<{ reaped: number }> {
    const stale = await this.store.listStartedBefore(epochMs)
    let reaped = 0
    for (const record of stale) {
      logger.warn(
        {
          containerKey: record.containerKey,
          kind: record.kind,
          workspaceId: record.workspaceId,
          ageMs: this.clock.now() - record.startedAt,
        },
        'container-reaper: killing leaked container past its max lifetime',
      )
      try {
        await this.release(record.containerKey)
        reaped++
      } catch (error) {
        // Leave the row in place so the next pass retries this one.
        logger.error(
          { containerKey: record.containerKey, err: errMessage(error) },
          'container-reaper: failed to kill leaked container (will retry next pass)',
        )
      }
    }
    return { reaped }
  }
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
